import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_POLICY,
  hasBackupCapacity,
  nextDue,
  planRotation,
  PolicyValues,
} from './policy';

const execFileAsync = promisify(execFile);
const LOCK_KEY = 'hermes-retention-recovery';
const MAX_RUN_MS = 45 * 60_000;

type DbConnection = {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string;
};

function connection(value: string): DbConnection {
  const url = new URL(value);
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new Error('Invalid PostgreSQL connection');
  }
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

function pgEnv(db: DbConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: db.host,
    PGPORT: db.port,
    PGUSER: db.user,
    PGPASSWORD: db.password,
    PGDATABASE: db.database,
    PGCONNECT_TIMEOUT: '10',
  };
}

async function command(
  binary: string,
  args: string[],
  db: DbConnection,
  timeout = MAX_RUN_MS,
) {
  // No shell, no user-controlled command or arguments, no stderr in API/audit logs.
  return execFileAsync(binary, args, {
    env: pgEnv(db),
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function checksum(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid backup stream');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

@Injectable()
export class BackupRunner {
  private readonly logger = new Logger(BackupRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async directory(): Promise<string> {
    const folder = this.config.get<string>(
      'BACKUP_STORAGE_DIR',
      '/var/lib/hermes/backups',
    );
    if (
      !folder ||
      !path.isAbsolute(folder) ||
      path.parse(folder).root === folder
    ) {
      throw new ServiceUnavailableException(
        'El almacenamiento de backups no está configurado',
      );
    }
    const info = await lstat(folder).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new ServiceUnavailableException(
        'El almacenamiento de backups no está disponible',
      );
    }
    return folder;
  }

  async diskStatus() {
    const folder = await this.directory();
    const fs = await statfs(folder, { bigint: true });
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    return {
      freeBytes: Number(free),
      usedPercent: Number(((total - free) * 100n) / total),
    };
  }

  private async assertCapacity() {
    const disk = await this.diskStatus();
    const db = connection(this.config.getOrThrow<string>('DATABASE_URL'));
    const { stdout } = await execFileAsync(
      'psql',
      ['-At', '-c', 'SELECT pg_database_size(current_database())'],
      { env: pgEnv(db), timeout: 30_000, maxBuffer: 1024 },
    );
    const estimated = Number(stdout.trim());
    if (!Number.isSafeInteger(estimated) || estimated < 0)
      throw new Error('Database size unavailable');
    if (!hasBackupCapacity(disk.freeBytes, disk.usedPercent, estimated)) {
      this.logger.warn('backup_skipped_insufficient_disk');
      throw new ServiceUnavailableException(
        'No hay espacio suficiente para la operación',
      );
    }
  }

  private async lock<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
        if (!rows[0]?.locked)
          throw new ConflictException(
            'Ya hay una operación de backup o recuperación en curso',
          );
        return work(tx);
      },
      { timeout: MAX_RUN_MS + 60_000, maxWait: 5_000 },
    );
  }

  private async recordFailure(kind: string) {
    await this.prisma.backupOperation
      .create({
        data: {
          kind,
          status: 'FAILED',
          detail: 'Operation failed; inspect server logs',
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    this.logger.error(`${kind.toLowerCase()}_failed`);
  }

  async assertRestoreTarget() {
    const restoreUrl = this.config.get<string>('RESTORE_CHECK_DATABASE_URL');
    if (!restoreUrl)
      throw new ServiceUnavailableException(
        'El PostgreSQL aislado no está configurado',
      );
    const restore = connection(restoreUrl);
    const source = connection(this.config.getOrThrow<string>('DATABASE_URL'));
    if (
      restore.host !== 'restore-postgres' ||
      (restore.host === source.host && restore.port === source.port)
    ) {
      throw new ServiceUnavailableException(
        'El destino de restore aislado no es válido',
      );
    }
    try {
      await command('psql', ['-At', '-c', 'SELECT 1'], restore, 10_000);
    } catch {
      throw new ServiceUnavailableException(
        'El PostgreSQL aislado no está disponible',
      );
    }
    return restore;
  }

  async backup(
    kind: 'PERIODIC' | 'MANUAL' = 'MANUAL',
    due?: { updatedAt: Date; intervalMs: number },
  ) {
    try {
      return await this.lock(async (tx) => {
        if (due) {
          const last = await tx.backupOperation.findFirst({
            where: { kind: 'BACKUP' },
            orderBy: { startedAt: 'desc' },
          });
          if (
            nextDue(last?.finishedAt || null, due.updatedAt, due.intervalMs) >
            new Date()
          ) {
            return { skipped: true };
          }
        }
        const folder = await this.directory();
        await this.assertCapacity();
        const db = connection(this.config.getOrThrow<string>('DATABASE_URL'));
        const id = randomUUID();
        const fileName = `hermes-${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.dump`;
        const finalFile = path.join(folder, fileName);
        const temporary = `${finalFile}.partial`;
        const operation = await tx.backupOperation.create({
          data: { kind: 'BACKUP', status: 'RUNNING' },
        });
        try {
          await command(
            'pg_dump',
            ['--format=custom', '--no-owner', '--no-acl', '--file', temporary],
            db,
          );
          await command('pg_restore', ['--list', temporary], db, 60_000);
          const digest = await checksum(temporary);
          const file = await stat(temporary);
          if (file.size === 0) throw new Error('Empty backup');
          await rename(temporary, finalFile);
          const artifact = await tx.backupArtifact.create({
            data: {
              id,
              kind,
              fileName,
              sizeBytes: BigInt(file.size),
              sha256: digest,
              protected: kind !== 'PERIODIC',
            },
          });
          await tx.backupOperation.update({
            where: { id: operation.id },
            data: {
              status: 'SUCCESS',
              artifactId: artifact.id,
              finishedAt: new Date(),
            },
          });
          this.logger.log(`backup_completed kind=${kind} artifact=${id}`);
          return {
            id: artifact.id,
            createdAt: artifact.createdAt,
            sizeBytes: file.size,
            sha256: digest,
          };
        } catch (error) {
          await unlink(finalFile).catch(() => undefined);
          throw error;
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      });
    } catch (error) {
      if (!(error instanceof ConflictException))
        await this.recordFailure('BACKUP');
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException(
        'Falló el backup; revise los registros del servidor',
      );
    }
  }

  async rotationPreview(policy: PolicyValues = DEFAULT_POLICY) {
    const artifacts = await this.prisma.backupArtifact.findMany();
    const candidates = planRotation(artifacts, policy);
    const selected = artifacts.filter((item) => candidates.includes(item.id));
    const folder = await this.directory().catch(() => null);
    const legacy = folder
      ? (await readdir(folder)).filter(
          (name) =>
            name.endsWith('.dump') &&
            !artifacts.some((item) => item.fileName === name),
        )
      : [];
    const legacySizes = folder
      ? await Promise.all(
          legacy.map(async (name) => {
            const info = await lstat(path.join(folder, name)).catch(() => null);
            return info?.isFile() ? info.size : 0;
          }),
        )
      : [];
    return {
      managedCount: artifacts.length,
      protectedCount: artifacts.filter(
        (item) => item.protected || item.kind !== 'PERIODIC',
      ).length,
      legacyCount: legacy.length,
      legacyStorageBytes: legacySizes.reduce((sum, value) => sum + value, 0),
      managedStorageBytes: Number(
        artifacts.reduce((total, item) => total + item.sizeBytes, 0n),
      ),
      deleteIds: candidates,
      deleteCount: candidates.length,
      reclaimBytes: Number(
        selected.reduce((total, item) => total + item.sizeBytes, 0n),
      ),
    };
  }

  async rotate(policy: PolicyValues) {
    const selected = await this.lock(async (tx) => {
      const artifacts = await tx.backupArtifact.findMany();
      const ids = planRotation(artifacts, policy);
      const candidates = artifacts.filter(
        (item) =>
          ids.includes(item.id) &&
          path.basename(item.fileName) === item.fileName,
      );
      if (candidates.length) {
        await tx.backupArtifact.deleteMany({
          where: { id: { in: candidates.map((item) => item.id) } },
        });
      }
      return candidates;
    });
    // Database removal commits before file deletion. A crash can leave an
    // unmanaged file, but cannot make a retained DB record point to a deleted dump.
    const folder = await this.directory();
    let deleted = 0;
    for (const artifact of selected) {
      await unlink(path.join(folder, artifact.fileName)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      deleted++;
    }
    if (deleted) {
      await this.prisma.backupOperation.create({
        data: {
          kind: 'ROTATION',
          status: 'SUCCESS',
          detail: `${deleted} managed periodic artifacts removed`,
          finishedAt: new Date(),
        },
      });
      this.logger.log(`rotation_executed deleted=${deleted}`);
    }
    return { deleted };
  }

  async restoreCheck(due?: { updatedAt: Date; intervalMs: number }) {
    try {
      return await this.lock(async (tx) => {
        if (due) {
          const last = await tx.backupOperation.findFirst({
            where: { kind: 'RESTORE_CHECK' },
            orderBy: { startedAt: 'desc' },
          });
          if (
            nextDue(last?.finishedAt || null, due.updatedAt, due.intervalMs) >
            new Date()
          ) {
            return { skipped: true };
          }
        }
        const restore = await this.assertRestoreTarget();
        await this.assertCapacity();
        const artifact = await tx.backupArtifact.findFirst({
          orderBy: { createdAt: 'desc' },
        });
        if (!artifact)
          throw new ServiceUnavailableException(
            'No hay un backup gestionado para verificar',
          );
        const folder = await this.directory();
        const file = path.join(folder, artifact.fileName);
        if (
          path.basename(artifact.fileName) !== artifact.fileName ||
          (await checksum(file)) !== artifact.sha256
        ) {
          throw new Error('Backup checksum mismatch');
        }
        const database = `hermes_check_${randomUUID().replace(/-/g, '')}`;
        const operation = await tx.backupOperation.create({
          data: {
            kind: 'RESTORE_CHECK',
            status: 'RUNNING',
            artifactId: artifact.id,
          },
        });
        await tx.backupArtifact.update({
          where: { id: artifact.id },
          data: { inUse: true },
        });
        try {
          await command('createdb', [database], restore, 30_000);
          await command(
            'pg_restore',
            ['--no-owner', '--no-acl', '--dbname', database, file],
            restore,
          );
          const query = await command(
            'psql',
            [
              '-d',
              database,
              '-At',
              '-c',
              "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
            ],
            restore,
            30_000,
          );
          if (Number(query.stdout.trim()) < 1)
            throw new Error('Restored database has no tables');
          await tx.backupArtifact.update({
            where: { id: artifact.id },
            data: { restoreCheckedAt: new Date(), restoreCheckPassed: true },
          });
          await tx.backupOperation.update({
            where: { id: operation.id },
            data: { status: 'SUCCESS', finishedAt: new Date() },
          });
          this.logger.log(`restore_check_passed artifact=${artifact.id}`);
          return { artifactId: artifact.id, passed: true };
        } finally {
          await command(
            'dropdb',
            ['--if-exists', '--force', database],
            restore,
            30_000,
          ).catch(() => {
            this.logger.error('restore_check_teardown_failed');
            throw new Error('Isolated restore teardown failed');
          });
          await tx.backupArtifact.update({
            where: { id: artifact.id },
            data: { inUse: false },
          });
        }
      });
    } catch (error) {
      if (!(error instanceof ConflictException))
        await this.recordFailure('RESTORE_CHECK');
      if (
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException(
        'Falló el restore-check; revise los registros del servidor',
      );
    }
  }
}

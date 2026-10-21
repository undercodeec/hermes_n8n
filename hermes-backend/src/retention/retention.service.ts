import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { BackupRunner } from './backup-runner.service';
import {
  DEFAULT_POLICY,
  nextDue,
  POLICY_LIMITS,
  PolicyValues,
  validatePolicy,
} from './policy';

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: BackupRunner,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Delay first evaluation. A migration/start never starts a backup on its own.
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async current() {
    const row = await this.prisma.retentionRecoveryPolicy.findUnique({
      where: { id: 'global' },
    });
    return { row, policy: row ? this.values(row) : DEFAULT_POLICY };
  }

  private values(row: PolicyValues): PolicyValues {
    return {
      backupEnabled: row.backupEnabled,
      backupIntervalHours: row.backupIntervalHours,
      maximumBackupCount: row.maximumBackupCount,
      maximumBackupAgeDays: row.maximumBackupAgeDays,
      maximumBackupStorageGiB: row.maximumBackupStorageGiB,
      restoreCheckEnabled: row.restoreCheckEnabled,
      restoreCheckIntervalDays: row.restoreCheckIntervalDays,
    };
  }

  async get() {
    const { row, policy } = await this.current();
    const [lastBackup, lastAttempt, lastFailure, lastRestore, preview, disk] =
      await Promise.all([
        this.prisma.backupOperation.findFirst({
          where: { kind: 'BACKUP', status: 'SUCCESS' },
          orderBy: { startedAt: 'desc' },
        }),
        this.prisma.backupOperation.findFirst({
          where: { kind: 'BACKUP' },
          orderBy: { startedAt: 'desc' },
        }),
        this.prisma.backupOperation.findFirst({
          where: { kind: 'BACKUP', status: 'FAILED' },
          orderBy: { startedAt: 'desc' },
        }),
        this.prisma.backupOperation.findFirst({
          where: { kind: 'RESTORE_CHECK' },
          orderBy: { startedAt: 'desc' },
        }),
        this.runner.rotationPreview(policy),
        this.runner.diskStatus().catch(() => null),
      ]);
    const updatedAt = row?.updatedAt || new Date();
    const warnings: string[] = [];
    if (!disk) warnings.push('El almacenamiento de backups no está disponible');
    warnings.push(
      'Los backups heredados fuera del volumen gestionado no aparecen en este inventario',
    );
    if (
      policy.restoreCheckEnabled &&
      !this.config.get<string>('RESTORE_CHECK_DATABASE_URL')
    ) {
      warnings.push(
        'El PostgreSQL aislado para restore-check no está configurado',
      );
    }
    if (
      preview.managedStorageBytes >
      policy.maximumBackupStorageGiB * 1024 ** 3
    ) {
      warnings.push(
        'Los backups gestionados superan el presupuesto; los protegidos se conservan',
      );
    }
    return {
      policy,
      defaults: DEFAULT_POLICY,
      limits: POLICY_LIMITS,
      status: {
        configured: Boolean(row),
        nextBackupAt: policy.backupEnabled
          ? nextDue(
              lastAttempt?.finishedAt || null,
              updatedAt,
              policy.backupIntervalHours * 3_600_000,
            )
          : null,
        nextRestoreCheckAt: policy.restoreCheckEnabled
          ? nextDue(
              lastRestore?.finishedAt || null,
              updatedAt,
              policy.restoreCheckIntervalDays * 86_400_000,
            )
          : null,
        lastBackupAt: lastBackup?.finishedAt || null,
        lastBackupFailureAt: lastFailure?.finishedAt || null,
        lastRestoreCheckAt: lastRestore?.finishedAt || null,
        lastRestoreCheckPassed: lastRestore?.status === 'SUCCESS',
        disk,
        ...preview,
        warnings,
      },
    };
  }

  async update(input: unknown, userId: string) {
    const value = validatePolicy(input);
    if (value.backupEnabled) await this.runner.diskStatus();
    if (value.restoreCheckEnabled) await this.runner.assertRestoreTarget();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS held FROM pg_advisory_xact_lock(hashtext('hermes-retention-policy'))`;
      const before = await tx.retentionRecoveryPolicy.findUnique({
        where: { id: 'global' },
      });
      await tx.retentionRecoveryPolicy.upsert({
        where: { id: 'global' },
        create: { id: 'global', ...value, updatedBy: userId },
        update: { ...value, updatedBy: userId },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'RETENTION_POLICY_UPDATED',
          entity: 'retention_recovery_policy',
          entityId: 'global',
          changes: {
            before: before ? this.values(before) : DEFAULT_POLICY,
            after: value,
          },
        },
      });
    });
    this.logger.log('retention_policy_updated');
    return this.get();
  }

  async preview(input: unknown) {
    return this.runner.rotationPreview(validatePolicy(input));
  }

  async backupNow() {
    const result = await this.runner.backup('MANUAL');
    return result;
  }

  async restoreNow() {
    return this.runner.restoreCheck();
  }

  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { row, policy } = await this.current();
      if (!row) return;
      if (policy.backupEnabled) {
        const last = await this.prisma.backupOperation.findFirst({
          where: { kind: 'BACKUP' },
          orderBy: { startedAt: 'desc' },
        });
        if (
          nextDue(
            last?.finishedAt || null,
            row.updatedAt,
            policy.backupIntervalHours * 3_600_000,
          ) <= now
        ) {
          await this.runner.backup('PERIODIC', {
            updatedAt: row.updatedAt,
            intervalMs: policy.backupIntervalHours * 3_600_000,
          });
        }
        const successes = await this.prisma.backupOperation.count({
          where: { kind: 'BACKUP', status: 'SUCCESS' },
        });
        if (successes > 0) await this.runner.rotate(policy);
      }
      if (policy.restoreCheckEnabled) {
        const last = await this.prisma.backupOperation.findFirst({
          where: { kind: 'RESTORE_CHECK' },
          orderBy: { startedAt: 'desc' },
        });
        if (
          nextDue(
            last?.finishedAt || null,
            row.updatedAt,
            policy.restoreCheckIntervalDays * 86_400_000,
          ) <= now
        ) {
          await this.runner.restoreCheck({
            updatedAt: row.updatedAt,
            intervalMs: policy.restoreCheckIntervalDays * 86_400_000,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `retention_tick_failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    } finally {
      this.ticking = false;
    }
  }
}

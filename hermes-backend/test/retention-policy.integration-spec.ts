import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RetentionService } from '../src/retention/retention.service';
import { DEFAULT_POLICY } from '../src/retention/policy';
import { BackupRunner } from '../src/retention/backup-runner.service';

const url = process.env.RETENTION_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
const isolated =
  parsed?.hostname === '127.0.0.1' &&
  parsed.port === '55433' &&
  parsed.pathname === '/retention_test';

describe('isolated retention policy persistence', () => {
  if (!isolated || !url) {
    it.skip('requires RETENTION_TEST_DATABASE_URL on isolated port 55433', () =>
      undefined);
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  const runner = {
    diskStatus: jest
      .fn()
      .mockResolvedValue({ freeBytes: 100 * 1024 ** 3, usedPercent: 10 }),
    rotationPreview: jest.fn().mockResolvedValue({
      managedCount: 0,
      protectedCount: 0,
      legacyCount: 0,
      managedStorageBytes: 0,
      deleteIds: [],
      deleteCount: 0,
      reclaimBytes: 0,
    }),
    backup: jest.fn(),
    rotate: jest.fn(),
    restoreCheck: jest.fn(),
  };
  const service = new RetentionService(
    db as never,
    runner as never,
    { get: () => undefined } as never,
  );
  const userId = randomUUID();

  beforeAll(async () => {
    await db.retentionRecoveryPolicy.deleteMany();
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        password: 'synthetic',
        name: 'Test operator',
        role: UserRole.ADMIN,
      },
    });
  });

  afterAll(async () => {
    await db.backupArtifact.deleteMany();
    await db.auditLog.deleteMany({ where: { userId } });
    await db.retentionRecoveryPolicy.deleteMany();
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('starts disabled, persists ADMIN change and its audit without scheduling work', async () => {
    const initial = await service.get();
    expect(initial.status.configured).toBe(false);
    expect(initial.policy).toEqual(DEFAULT_POLICY);
    await service.update({ ...DEFAULT_POLICY, maximumBackupCount: 11 }, userId);
    const fresh = await db.retentionRecoveryPolicy.findUniqueOrThrow({
      where: { id: 'global' },
    });
    expect(fresh.maximumBackupCount).toBe(11);
    expect(fresh.backupEnabled).toBe(false);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { userId, action: 'RETENTION_POLICY_UPDATED' },
    });
    expect(audit.changes).toEqual({
      before: DEFAULT_POLICY,
      after: { ...DEFAULT_POLICY, maximumBackupCount: 11 },
    });
    await service.tick(new Date(Date.now() + 10 * 86_400_000));
    expect(runner.backup).not.toHaveBeenCalled();
  });

  it('commits eligible index removal and deletes only eligible managed files', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'hermes-retention-test-'));
    try {
      const time = new Date();
      for (const [name, age, protectedValue] of [
        ['new.dump', 0, false],
        ['old.dump', 2, false],
        ['protected.dump', 3, true],
      ] as const) {
        await writeFile(path.join(folder, name), 'synthetic');
        await db.backupArtifact.create({
          data: {
            kind: 'PERIODIC',
            fileName: name,
            sizeBytes: 9n,
            sha256: 'synthetic',
            protected: protectedValue,
            createdAt: new Date(time.getTime() - age * 86_400_000),
          },
        });
      }
      const localRunner = new BackupRunner(
        db as never,
        { get: () => folder } as never,
      );
      const policy = { ...DEFAULT_POLICY, maximumBackupCount: 1 };
      expect((await localRunner.rotationPreview(policy)).deleteCount).toBe(1);
      expect(await localRunner.rotate(policy)).toEqual({ deleted: 1 });
      expect((await readdir(folder)).sort()).toEqual([
        'new.dump',
        'protected.dump',
      ]);
      expect(await db.backupArtifact.count()).toBe(2);
    } finally {
      for (const name of await readdir(folder))
        await unlink(path.join(folder, name));
      await rmdir(folder);
    }
  });
});

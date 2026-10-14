import { RetentionService } from './retention.service';
import { DEFAULT_POLICY } from './policy';

describe('retention scheduler and audit', () => {
  const row = {
    id: 'global',
    ...DEFAULT_POLICY,
    updatedAt: new Date('2026-10-14T00:00:00Z'),
    updatedBy: 'operator',
  };
  const operations = {
    findFirst: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
  };
  const policy = {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(row),
  };
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    retentionRecoveryPolicy: policy,
    auditLog: audit,
  };
  const prisma = {
    retentionRecoveryPolicy: policy,
    backupOperation: operations,
    $transaction: jest.fn(
      async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
    ),
  };
  const runner = {
    diskStatus: jest.fn().mockResolvedValue({ freeBytes: 100, usedPercent: 1 }),
    rotationPreview: jest
      .fn()
      .mockResolvedValue({ managedCount: 0, managedStorageBytes: 0 }),
    assertRestoreTarget: jest.fn().mockResolvedValue(undefined),
    backup: jest.fn().mockResolvedValue({}),
    rotate: jest.fn().mockResolvedValue({}),
    restoreCheck: jest.fn().mockResolvedValue({}),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new RetentionService(
    prisma as never,
    runner as never,
    config as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    policy.findUnique.mockResolvedValue(null);
    operations.findFirst.mockResolvedValue(null);
    operations.count.mockResolvedValue(0);
  });

  it('does no scheduled work before an operator saves a policy', async () => {
    await service.tick(new Date('2026-10-20T00:00:00Z'));
    expect(runner.backup).not.toHaveBeenCalled();
    expect(runner.restoreCheck).not.toHaveBeenCalled();
  });

  it('schedules one due backup after an enabled policy, not immediately on change', async () => {
    policy.findUnique.mockResolvedValue({
      ...row,
      backupEnabled: true,
      backupIntervalHours: 6,
    });
    await service.tick(new Date('2026-10-14T05:00:00Z'));
    expect(runner.backup).not.toHaveBeenCalled();
    await service.tick(new Date('2026-10-14T07:00:00Z'));
    expect(runner.backup).toHaveBeenCalledTimes(1);
    expect(runner.backup).toHaveBeenCalledWith('PERIODIC', {
      updatedAt: row.updatedAt,
      intervalMs: 21_600_000,
    });
  });

  it('writes old and new policy to AuditLog in the policy transaction', async () => {
    await service.update(DEFAULT_POLICY, 'operator');
    expect(policy.upsert).toHaveBeenCalled();
    expect(audit.create).toHaveBeenCalledWith({
      data: {
        userId: 'operator',
        action: 'RETENTION_POLICY_UPDATED',
        entity: 'retention_recovery_policy',
        entityId: 'global',
        changes: { before: DEFAULT_POLICY, after: DEFAULT_POLICY },
      },
    });
  });
});

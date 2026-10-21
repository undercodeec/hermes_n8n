import { ConflictException } from '@nestjs/common';
import { BackupRunner } from './backup-runner.service';

describe('backup operation concurrency', () => {
  const now = new Date();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
    backupOperation: {
      findFirst: jest.fn().mockResolvedValue({ finishedAt: now }),
    },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const runner = new BackupRunner(prisma as never, {} as never);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ locked: true }]);
    tx.backupOperation.findFirst.mockResolvedValue({ finishedAt: now });
  });

  it('rechecks the due time after obtaining the PostgreSQL lock', async () => {
    const due = {
      updatedAt: new Date(now.getTime() - 86_400_000),
      intervalMs: 6 * 3_600_000,
    };
    await expect(runner.backup('PERIODIC', due)).resolves.toEqual({
      skipped: true,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.backupOperation.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects a second operation while the advisory lock is held', async () => {
    tx.$queryRaw.mockResolvedValue([{ locked: false }]);
    await expect(runner.backup('PERIODIC')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

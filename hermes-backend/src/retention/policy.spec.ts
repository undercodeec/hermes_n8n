import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_POLICY,
  hasBackupCapacity,
  nextDue,
  planRotation,
  validatePolicy,
} from './policy';

const GiB = 1024n ** 3n;
const now = new Date('2026-10-14T12:00:00Z');
const artifact = (id: string, ageDays: number, extra = {}) => ({
  id,
  kind: 'PERIODIC',
  sizeBytes: GiB,
  protected: false,
  inUse: false,
  createdAt: new Date(now.getTime() - ageDays * 86_400_000),
  restoreCheckPassed: null,
  ...extra,
});

describe('retention policy', () => {
  it('starts with all periodic work disabled', () => {
    expect(DEFAULT_POLICY.backupEnabled).toBe(false);
    expect(DEFAULT_POLICY.restoreCheckEnabled).toBe(false);
    expect(DEFAULT_POLICY).toEqual({
      backupEnabled: false,
      backupIntervalHours: 72,
      maximumBackupCount: 5,
      maximumBackupAgeDays: 30,
      maximumBackupStorageGiB: 2,
      restoreCheckEnabled: false,
      restoreCheckIntervalDays: 60,
    });
  });

  it('accepts typed values within safe bounds and rejects unsafe settings', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    for (const backupIntervalHours of [6, 12, 24, 48, 72, 168, 336, 504, 720]) {
      expect(
        validatePolicy({ ...DEFAULT_POLICY, backupIntervalHours })
          .backupIntervalHours,
      ).toBe(backupIntervalHours);
    }
    for (const maximumBackupStorageGiB of [1, 2, 3, 5, 10, 1024]) {
      expect(
        validatePolicy({ ...DEFAULT_POLICY, maximumBackupStorageGiB })
          .maximumBackupStorageGiB,
      ).toBe(maximumBackupStorageGiB);
    }
    for (const candidate of [
      { backupIntervalHours: 5 },
      { backupIntervalHours: 721 },
      { maximumBackupCount: 0 },
      { maximumBackupAgeDays: 0 },
      { maximumBackupStorageGiB: 0 },
      { maximumBackupStorageGiB: 1025 },
      { restoreCheckIntervalDays: 1 },
      { minimumFreeGiB: 2 },
      { backupEnabled: 'true' },
    ]) {
      expect(() => validatePolicy({ ...DEFAULT_POLICY, ...candidate })).toThrow(
        BadRequestException,
      );
    }
  });

  it('preserves protected, in-use, manual, legacy, and newest valid backups', () => {
    const items = [
      artifact('new', 1),
      artifact('old', 100),
      artifact('protected', 100, { protected: true }),
      artifact('in-use', 100, { inUse: true }),
      artifact('manual', 100, { kind: 'MANUAL' }),
      artifact('legacy', 100, { kind: 'LEGACY' }),
    ];
    expect(
      planRotation(items, { ...DEFAULT_POLICY, maximumBackupCount: 1 }, now),
    ).toEqual(['old']);
    expect(planRotation([artifact('only', 100)], DEFAULT_POLICY, now)).toEqual(
      [],
    );
  });

  it('applies age, count and storage limits to eligible backups', () => {
    const items = [
      artifact('a', 1),
      artifact('b', 2),
      artifact('c', 3),
      artifact('d', 4),
    ];
    expect(
      planRotation(items, { ...DEFAULT_POLICY, maximumBackupAgeDays: 2 }, now),
    ).toEqual(['c', 'd']);
    expect(
      planRotation(items, { ...DEFAULT_POLICY, maximumBackupCount: 2 }, now),
    ).toEqual(['d', 'c']);
    const large = items.map((item) => ({ ...item, sizeBytes: 4n * GiB }));
    expect(
      planRotation(
        large,
        { ...DEFAULT_POLICY, maximumBackupStorageGiB: 10 },
        now,
      ),
    ).toEqual(['d', 'c']);
  });

  it('bases next execution on last attempt or updated policy', () => {
    const last = new Date('2026-10-14T06:00:00Z');
    expect(nextDue(last, now, 6 * 3_600_000)).toEqual(
      new Date('2026-10-14T18:00:00Z'),
    );
  });

  it('enforces the fixed disk floor and a size-aware estimate', () => {
    expect(hasBackupCapacity(7 * Number(GiB), 20, Number(GiB))).toBe(false);
    expect(hasBackupCapacity(20 * Number(GiB), 86, Number(GiB))).toBe(false);
    expect(hasBackupCapacity(9 * Number(GiB), 80, 10 * Number(GiB))).toBe(
      false,
    );
    expect(hasBackupCapacity(20 * Number(GiB), 80, Number(GiB))).toBe(true);
  });
});

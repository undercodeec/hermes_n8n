import { BadRequestException } from '@nestjs/common';

export type PolicyValues = {
  backupEnabled: boolean;
  backupIntervalHours: number;
  maximumBackupCount: number;
  maximumBackupAgeDays: number;
  maximumBackupStorageGiB: number;
  restoreCheckEnabled: boolean;
  restoreCheckIntervalDays: number;
};

export const DEFAULT_POLICY: PolicyValues = Object.freeze({
  backupEnabled: false,
  backupIntervalHours: 24,
  maximumBackupCount: 7,
  maximumBackupAgeDays: 30,
  maximumBackupStorageGiB: 50,
  restoreCheckEnabled: false,
  restoreCheckIntervalDays: 30,
});

export const POLICY_LIMITS = Object.freeze({
  backupIntervalHours: { min: 6, max: 168 },
  maximumBackupCount: { min: 1, max: 365 },
  maximumBackupAgeDays: { min: 1, max: 3650 },
  maximumBackupStorageGiB: { min: 10, max: 1024 },
  restoreCheckIntervalDays: { min: 30, max: 365 },
  minimumFreeGiB: 8,
  maximumDiskUsagePercent: 85,
});

export function validatePolicy(value: unknown): PolicyValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid policy');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_POLICY) as (keyof PolicyValues)[];
  if (
    Object.keys(input).some((key) => !keys.includes(key as keyof PolicyValues))
  ) {
    throw new BadRequestException('Unknown policy field');
  }
  for (const key of ['backupEnabled', 'restoreCheckEnabled'] as const) {
    if (typeof input[key] !== 'boolean') {
      throw new BadRequestException(`${key} must be boolean`);
    }
  }
  for (const key of Object.keys(
    POLICY_LIMITS,
  ) as (keyof typeof POLICY_LIMITS)[]) {
    if (!(key in DEFAULT_POLICY)) continue;
    const limits = POLICY_LIMITS[key] as { min: number; max: number };
    const number = input[key];
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < limits.min ||
      number > limits.max
    ) {
      throw new BadRequestException(
        `${key} must be between ${limits.min} and ${limits.max}`,
      );
    }
  }
  return Object.fromEntries(
    keys.map((key) => [key, input[key]]),
  ) as PolicyValues;
}

export type RotationArtifact = {
  id: string;
  kind: string;
  sizeBytes: bigint;
  protected: boolean;
  inUse: boolean;
  createdAt: Date;
  restoreCheckPassed: boolean | null;
};

export function planRotation(
  artifacts: RotationArtifact[],
  policy: PolicyValues,
  now = new Date(),
): string[] {
  const periodic = artifacts
    .filter((item) => item.kind === 'PERIODIC')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const deletable = periodic.filter((item) => !item.protected && !item.inUse);
  // Keep the newest valid artifact even when it exceeds all policy limits.
  const newestValid =
    periodic.find((item) => item.restoreCheckPassed !== false) || periodic[0];
  const remaining = new Set(periodic.map((item) => item.id));
  const selected: string[] = [];
  const remove = (item: RotationArtifact) => {
    if (item.id === newestValid?.id || !remaining.has(item.id)) return;
    remaining.delete(item.id);
    selected.push(item.id);
  };
  const ageLimit = now.getTime() - policy.maximumBackupAgeDays * 86_400_000;
  for (const item of deletable) {
    if (item.createdAt.getTime() < ageLimit) remove(item);
  }
  for (const item of [...deletable].reverse()) {
    if (remaining.size <= policy.maximumBackupCount) break;
    remove(item);
  }
  const budget = BigInt(policy.maximumBackupStorageGiB) * 1024n ** 3n;
  let used = artifacts
    .filter((item) => remaining.has(item.id) || item.kind !== 'PERIODIC')
    .reduce((sum, item) => sum + item.sizeBytes, 0n);
  for (const item of [...deletable].reverse()) {
    if (used <= budget) break;
    if (!remaining.has(item.id)) continue;
    const before = remaining.size;
    remove(item);
    if (remaining.size < before) used -= item.sizeBytes;
  }
  return selected;
}

export function nextDue(
  lastSuccess: Date | null,
  updatedAt: Date,
  intervalMs: number,
): Date {
  return new Date(
    Math.max(lastSuccess?.getTime() || 0, updatedAt.getTime()) + intervalMs,
  );
}

export function hasBackupCapacity(
  freeBytes: number,
  usedPercent: number,
  databaseBytes: number,
): boolean {
  const GiB = 1024 ** 3;
  const needed = Math.max(8 * GiB, Math.ceil(databaseBytes * 1.2) + GiB);
  return (
    Number.isSafeInteger(databaseBytes) &&
    databaseBytes >= 0 &&
    Number.isFinite(freeBytes) &&
    freeBytes >= needed &&
    Number.isFinite(usedPercent) &&
    usedPercent <= 85
  );
}

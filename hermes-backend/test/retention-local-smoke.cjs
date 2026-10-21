// Run only in the disposable Docker network described in docs/retention-recovery-policy.md.
const assert = require('node:assert/strict');
const { PrismaService } = require('/app/dist/prisma/prisma.service');
const { BackupRunner } = require('/app/dist/retention/backup-runner.service');
const { RetentionService } = require('/app/dist/retention/retention.service');
const { DEFAULT_POLICY } = require('/app/dist/retention/policy');
const { randomUUID } = require('node:crypto');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  const restore = new URL(process.env.RESTORE_CHECK_DATABASE_URL || '');
  assert.equal(source.hostname, 'hermes-retention-local-20261014');
  assert.equal(source.pathname, '/retention_test');
  assert.equal(restore.hostname, 'restore-postgres');
  assert.equal(process.env.BACKUP_STORAGE_DIR, '/var/lib/hermes/backups');
  const config = {
    get: (key, fallback) => process.env[key] || fallback,
    getOrThrow: (key) => {
      if (!process.env[key]) throw new Error(`Missing ${key}`);
      return process.env[key];
    },
  };
  const db = new PrismaService();
  await db.$connect();
  try {
    const runner = new BackupRunner(db, config);
    const service = new RetentionService(db, runner, config);
    const initial = await service.get();
    assert.equal(initial.policy.backupEnabled, false);
    assert.equal(initial.policy.restoreCheckEnabled, false);
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${id}@example.test`, password: 'synthetic', name: 'Synthetic operator', role: 'ADMIN' } });
    await service.update({ ...DEFAULT_POLICY, maximumBackupCount: 1 }, id);
    const first = await runner.backup('PERIODIC');
    assert.ok(first.id);
    const restored = await runner.restoreCheck();
    assert.equal(restored.passed, true);
    const second = await runner.backup('PERIODIC');
    assert.ok(second.id);
    const preview = await runner.rotationPreview({ ...DEFAULT_POLICY, maximumBackupCount: 1 });
    assert.equal(preview.deleteCount, 1);
    const rotated = await runner.rotate({ ...DEFAULT_POLICY, maximumBackupCount: 1 });
    assert.equal(rotated.deleted, 1);
    assert.equal(await db.backupArtifact.count(), 1);
    assert.equal((await service.get()).policy.backupEnabled, false);
    console.log('RETENTION_LOCAL_SMOKE_PASS: durable policy, dump, checksum/catalog, isolated restore, preview, rotation');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`RETENTION_LOCAL_SMOKE_FAIL: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});

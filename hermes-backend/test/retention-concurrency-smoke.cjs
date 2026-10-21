const assert = require('node:assert/strict');
const { PrismaService } = require('/app/dist/prisma/prisma.service');
const { BackupRunner } = require('/app/dist/retention/backup-runner.service');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert.equal(source.hostname, 'hermes-retention-local-20261014');
  assert.equal(source.pathname, '/retention_test');
  const db = new PrismaService();
  await db.$connect();
  try {
    const old = new Date(Date.now() - 86_400_000);
    await db.backupOperation.updateMany({ where: { kind: 'BACKUP' }, data: { startedAt: old, finishedAt: old } });
    const before = await db.backupOperation.count({ where: { kind: 'BACKUP', status: 'SUCCESS' } });
    const config = {
      get: (key, fallback) => process.env[key] || fallback,
      getOrThrow: (key) => process.env[key],
    };
    const runner = new BackupRunner(db, config);
    const due = { updatedAt: old, intervalMs: 6 * 3_600_000 };
    const results = await Promise.allSettled([
      runner.backup('PERIODIC', due),
      runner.backup('PERIODIC', due),
    ]);
    const after = await db.backupOperation.count({ where: { kind: 'BACKUP', status: 'SUCCESS' } });
    assert.equal(after - before, 1);
    assert.equal(results.filter((item) => item.status === 'fulfilled' && item.value.id).length, 1);
    console.log('RETENTION_CONCURRENCY_PASS: two due schedulers created one backup');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`RETENTION_CONCURRENCY_FAIL: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});

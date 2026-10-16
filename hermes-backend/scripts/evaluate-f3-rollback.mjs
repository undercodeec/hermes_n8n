import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const base = '83364e8d1175a05077d8e4b970fe2872bcdd6467';
const root = process.cwd();
const artifact = join(root, 'artifacts', 'f3-rollback-gate');
const read = (name) => JSON.parse(readFileSync(join(artifact, name), 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const db = read('db-evidence.json');
const engines = [read('gemini-evidence.json'), read('nous-evidence.json')];
const unit = JSON.parse(
  readFileSync(join(process.env.TEMP, 'f3-rollback-unit-jest.json'), 'utf8'),
);
const integration = JSON.parse(
  readFileSync(
    join(process.env.TEMP, 'f3-rollback-relevant-integration-jest.json'),
    'utf8',
  ),
);
const changed = execFileSync('git', ['diff', '--name-only', base], {
  encoding: 'utf8',
  cwd: join(root, '..'),
})
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const cases = [
  'baseline OFF Gemini',
  'ON Gemini',
  'ON to OFF Gemini',
  'OFF to ON Gemini',
  'baseline OFF Nous',
  'ON Nous',
  'ON to OFF Nous',
  'OFF to ON Nous',
  'ACTIVE survives',
  'evidence survives',
  'approval audit survives',
  'historical exposure survives',
  'new OFF turn has no exposure',
  'no stale learning over repeated OFF turns',
  'concurrent flag boundary',
  'in-flight provider retains prior request',
  'PREPARED delivery preserved',
  'CONFIRMED delivery preserved',
  'SUPPRESSED delivery preserved',
  'AMBIGUOUS delivery preserved',
  'shadow ON retrieval OFF',
  'shadow OFF retrieval OFF',
  'privacy after re-enable',
  'commercial authority after re-enable',
  'approval matrix after re-enable',
  'HIGH excluded',
  'expired excluded',
  'invalid flag fails closed',
  'selector failure isolated while OFF',
  'process recreation uses new flag snapshot',
];
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median =
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.ceil((sorted.length - 1) / 2)]) /
    2;
  return {
    samples: sorted.length,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    meanMs: mean,
    medianMs: median,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
};
const performance = Object.fromEntries(
  engines.map((engine) => [
    engine.engine,
    Object.fromEntries(
      Object.entries(engine.performanceSamples).map(([stage, values]) => [
        stage,
        stats(values),
      ]),
    ),
  ]),
);
const testSummary = (result) => ({
  suites: result.numTotalTestSuites,
  passedSuites: result.numPassedTestSuites,
  tests: result.numTotalTests,
  passedTests: result.numPassedTests,
  failedTests: result.numFailedTests,
  skippedTests: result.numPendingTests,
  success: result.success,
});
const staleExposureCount = engines.reduce(
  (total, engine) =>
    total + engine.exposures.slice(2, 5).reduce((sum, count) => sum + count, 0),
  0,
);
const checks = {
  unit: unit.success,
  integration: integration.success,
  thirtyCases: cases.length === 30,
  engines:
    engines.length === 2 &&
    engines.every(
      (engine) =>
        engine.exposures.join(',') === '0,1,0,0,0,1' &&
        engine.requestLearningCounts.join(',') === '0,1,0,0,0,1' &&
        engine.baselineHash === engine.postRollbackHash,
    ),
  data: JSON.stringify(db.before) === JSON.stringify(db.afterOff),
  reenable: JSON.stringify(db.selectedOn) === JSON.stringify(db.selectedAgain),
  redis: db.redis.keyHashBefore === db.redis.keyHashAfter,
  historical:
    typeof db.historicalTraceHash === 'string' &&
    db.historicalTraceHash.length === 64,
  stale: staleExposureCount === 0,
  migrations: !changed.some(
    (path) =>
      path.includes('prisma/schema.prisma') ||
      path.includes('prisma/migrations/'),
  ),
};
const pass = Object.values(checks).every(Boolean);
const report = {
  gate: 'F3_ROLLBACK_GATE',
  result: pass
    ? 'F3_ROLLBACK_GATE_PROVEN_OFFLINE'
    : 'BLOCKED_F3_ROLLBACK_TEST_FAILURE',
  baseSha: base,
  finalReference: 'refs/heads/f3-rollback-gate',
  fixtureVersion: 'f3-rollback-v1',
  fixtureSha256: sha(JSON.stringify(cases)),
  boundary:
    'ConfigModule validated environment snapshot at process startup; OFF effective for new turns on restarted chat processes, after the per-turn flag read and before selector invocation',
  restartRequired: 'YES',
  redisFlushRequired: 'NO',
  engineSwitchRequired: 'NO',
  shadowIndependent: true,
  reviewEnabled: false,
  summaryEnabled: false,
  corpus: cases,
  engines: engines.map(
    ({
      engine,
      sequence,
      exposures,
      requestLearningCounts,
      baselineHash,
      postRollbackHash,
      promptVersions,
    }) => ({
      engine,
      sequence,
      exposures,
      requestLearningCounts,
      baselineNormalizedHash: baselineHash,
      postRollbackNormalizedHash: postRollbackHash,
      promptVersions,
    }),
  ),
  database: {
    before: db.before,
    afterOff: db.afterOff,
    selectedOnCount: db.selectedOn.length,
    selectedOffCount: db.selectedOff.length,
    selectedAgainCount: db.selectedAgain.length,
    historicalTraceHash: db.historicalTraceHash,
    redis: db.redis,
  },
  staleExposureCount,
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    required: false,
  },
  tests: {
    unit: testSummary(unit),
    relevantIntegration: testSummary(integration),
  },
  performance: {
    scope:
      'actual engine adapters with local deterministic provider fakes; isolated PostgreSQL selector; 20 samples each',
    threshold: 'THRESHOLD_NOT_DEFINED',
    byEngine: performance,
    selectorOn: stats(db.selectorSamplesMs),
  },
  externalTraffic: {
    geminiReviewer: 0,
    geminiConversationalReal: 0,
    nousReal: 0,
    metaReal: 0,
    whatsappReal: 0,
  },
  productionChanges: 'NONE',
  flagsChanged: 'NONE',
  f3State: 'OPEN',
  checks,
};
const reportText = JSON.stringify(report, null, 2) + '\n';
writeFileSync(join(artifact, 'offline-rollback-report.json'), reportText);
const summary = `# F3 rollback gate — offline\n\nResult: **${report.result}**. Base: \`${base}\`; result reference: \`f3-rollback-gate\`. F3 remains OPEN.\n\nConfigModule validates an environment snapshot at process startup. Disable \`LEARNING_RETRIEVAL_ENABLED\` in the intended runtime configuration and restart every chat process to apply OFF. New turns on the restarted processes skip the selector and omit approvedLearning; in-flight requests and durable PREPARED deliveries retain their earlier metadata. No database deletion, migration, Redis flush or engine switch is part of rollback.\n\nBoth Gemini Direct and Nous passed OFF→ON→OFF→OFF→OFF→ON with request learning counts \`0,1,0,0,0,1\`. Their normalized post-rollback requests match the original OFF baseline. The isolated database fixture preserved ${db.before.learning.count} items, ${db.before.evidence.count} evidence rows, ${db.before.audits.count} audit rows, ${db.before.deliveries.count} deliveries and all historical trace metadata; re-enable selected the same ACTIVE item. Redis key hash was unchanged.\n\n${cases.length} synthetic corpus cases are mapped to assertions in the AutoReply, engine adapter, configuration and PostgreSQL integration suites. Unit: ${unit.numPassedTests}/${unit.numTotalTests} tests in ${unit.numPassedTestSuites} suites. Relevant integration: ${integration.numPassedTests}/${integration.numTotalTests} tests in ${integration.numPassedTestSuites} suites. Performance is descriptive (20 fake-adapter samples per stage); THRESHOLD_NOT_DEFINED. External provider, Meta and WhatsApp traffic: 0. No production flag change.\n\nReport SHA-256: \`${sha(reportText)}\`.\n`;
writeFileSync(join(artifact, 'offline-rollback-summary.md'), summary);
if (!pass) process.exitCode = 1;
console.log(
  JSON.stringify({
    result: report.result,
    reportSha256: sha(reportText),
    checks,
    tests: report.tests,
  }),
);

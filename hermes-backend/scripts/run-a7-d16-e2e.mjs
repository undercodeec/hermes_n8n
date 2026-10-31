import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'win32' && process.env.GITHUB_ACTIONS !== 'true')
  throw new Error(
    'A7-D16 may run only on local Windows or a GitHub Actions runner',
  );
if (['racknerd-8cc858a'].includes(process.env.HOSTNAME?.toLowerCase()))
  throw new Error('Production host is forbidden');
if (process.cwd().replaceAll('\\', '/').startsWith('/var/www/'))
  throw new Error('Production path is forbidden');

const databaseUrl =
  'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/hermes_a7_d16_test?schema=public';
const redisUrl = 'redis://127.0.0.1:56380/0';
const compose = 'docker-compose.a7-d16-e2e.yml';
const artifactSubdir = process.env.A7_D16_ARTIFACT_SUBDIR || 'a7-d16-e2e';
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(artifactSubdir))
  throw new Error('Invalid A7-D16 artifact subdirectory');
const artifactDir = resolve('artifacts', artifactSubdir);
mkdirSync(artifactDir, { recursive: true });
rmSync(`${artifactDir}/jest-results.json`, { force: true });
rmSync(`${artifactDir}/capacity.json`, { force: true });
rmSync(`${artifactDir}/critical.json`, { force: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    /(API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL|META_|GEMINI_|NOUS_)/i.test(
      key,
    )
  )
    delete env[key];
}
Object.assign(env, {
  DATABASE_URL: databaseUrl,
  DATABASE_INTEGRATION_URL: databaseUrl,
  REDIS_INTEGRATION_URL: redisUrl,
  A7_D16_CAPACITY_FILE: `${artifactDir}/capacity.json`,
  A7_D16_CRITICAL_FILE: `${artifactDir}/critical.json`,
  NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
  NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
  NOUS_PILOT_OPERATIONS_ENABLED: 'true',
});

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    stdio: 'inherit',
    env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} exited ${result.status}`);
}

let started = false;
const startedAt = Date.now();
let failure;
try {
  started = true;
  run('docker', ['compose', '-f', compose, 'up', '-d', '--wait']);
  run(process.execPath, ['./node_modules/prisma/build/index.js', 'generate']);
  run(process.execPath, [
    './node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
  ]);
  const postgresProbe = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'a7_d16_test',
      '-d',
      'hermes_a7_d16_test',
      '-Atqc',
      'SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    ],
    { env, encoding: 'utf8' },
  );
  const redisProbe = spawnSync(
    'docker',
    ['compose', '-f', compose, 'exec', '-T', 'redis', 'redis-cli', 'ping'],
    { env, encoding: 'utf8' },
  );
  if (
    postgresProbe.status !== 0 ||
    postgresProbe.stdout.trim() !== '27' ||
    redisProbe.status !== 0 ||
    redisProbe.stdout.trim() !== 'PONG'
  )
    throw new Error('PostgreSQL migration or Redis probe failed');
  writeFileSync(
    `${artifactDir}/infrastructure.json`,
    JSON.stringify(
      {
        postgresqlAppliedMigrations: 27,
        redisPing: 'PONG',
        database: 'hermes_a7_d16_test',
        ports: [55433, 56380],
      },
      null,
      2,
    ),
  );
  run(process.execPath, [
    './node_modules/jest/bin/jest.js',
    '--config',
    './test/jest-a7-d16.json',
    '--runInBand',
    '--json',
    '--outputFile',
    `${artifactDir}/jest-results.json`,
    '--runTestsByPath',
    'test/a7-d16-nous.e2e-spec.ts',
    'test/a7-d16-critical.integration-spec.ts',
    'test/nous-hermes-queue.integration-spec.ts',
    'test/nous-recovery-pagination.integration-spec.ts',
    'test/inbound-turn.integration-spec.ts',
    'test/automated-delivery.integration-spec.ts',
  ]);
} catch (error) {
  failure = error;
} finally {
  if (started) {
    try {
      run('docker', [
        'compose',
        '-f',
        compose,
        'down',
        '--volumes',
        '--remove-orphans',
      ]);
    } catch (error) {
      failure ??= error;
    }
  }
  let results = {};
  try {
    const jest = JSON.parse(
      readFileSync(`${artifactDir}/jest-results.json`, 'utf8'),
    );
    results = {
      total: jest.numTotalTests,
      passed: jest.numPassedTests,
      failed: jest.numFailedTests,
      pending: jest.numPendingTests,
      suites: jest.numTotalTestSuites,
    };
  } catch {
    /* Migration or setup may have failed before Jest started. */
  }
  const summary = {
    ...results,
    elapsedMs: Date.now() - startedAt,
    status: failure ? 'FAILED' : 'PASSED',
    error: failure instanceof Error ? failure.message : undefined,
    infrastructure: 'postgres:16-alpine, redis:7-alpine, loopback-only',
  };
  writeFileSync(
    `${artifactDir}/summary.json`,
    JSON.stringify(summary, null, 2),
  );
  const markdown = `## A7-D16 isolated E2E\n\nStatus: **${summary.status}**  \nTests: ${summary.passed ?? 0}/${summary.total ?? 0} passed; ${summary.failed ?? 0} failed  \nElapsed: ${summary.elapsedMs} ms  \n${summary.error ?? ''}\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' });
  process.stdout.write(`A7_D16_SUMMARY ${JSON.stringify(summary)}\n`);
}
if (failure) throw failure;

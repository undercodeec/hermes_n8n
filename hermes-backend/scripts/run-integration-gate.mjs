import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import {
  allowedSkippedTests,
  databaseUrls,
  redisUrls,
  suiteGroups,
} from './integration-gate-config.mjs';

if (process.platform !== 'win32' && process.env.GITHUB_ACTIONS !== 'true')
  throw new Error(
    'Integration gate may run only on local Windows or GitHub Actions',
  );
if (process.env.HOSTNAME?.toLowerCase() === 'racknerd-8cc858a')
  throw new Error('Production host is forbidden');
if (process.cwd().replaceAll('\\', '/').startsWith('/var/www/'))
  throw new Error('Production path is forbidden');

const compose = 'docker-compose.integration-gate.yml';
const project = `hermes-integration-gate-${process.pid}`;
const artifactDir = resolve('artifacts', 'integration-gate-20261031');
const expectedSuites = readdirSync('test')
  .filter((name) => name.endsWith('.integration-spec.ts'))
  .sort();
const assignedSuites = suiteGroups.flatMap((group) => group.suites).sort();
if (JSON.stringify(expectedSuites) !== JSON.stringify(assignedSuites))
  throw new Error('Integration suite mapping is incomplete or duplicated');

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (
    /(API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL|META_|GEMINI_|GOOGLE_|NOUS_)/i.test(
      key,
    )
  )
    delete baseEnv[key];
}
baseEnv.COMPOSE_PROJECT_NAME = project;

function run(program, args, env = baseEnv, options = {}) {
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    throw new Error(
      `${program} exited ${result.status ?? 'without status'}: ${
        result.error?.message ?? detail.slice(-1500)
      }`,
    );
  }
  return result;
}

function docker(args, env = baseEnv) {
  return run('docker', ['compose', '-f', compose, '-p', project, ...args], env);
}

async function assertPortFree(port) {
  await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

function createDatabase(service, user, name) {
  if (!/^(?:ads_[de]_test_gate|retention_test)$/u.test(name))
    throw new Error('Unexpected test database name');
  docker([
    'exec',
    '-T',
    service,
    'psql',
    '-U',
    user,
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE DATABASE ${name}`,
  ]);
}

function migrate(database) {
  const env = { ...baseEnv, DATABASE_URL: databaseUrls[database] };
  run(
    process.execPath,
    ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    env,
  );
}

function suiteEnv(group) {
  return {
    ...baseEnv,
    DATABASE_URL: databaseUrls[group.database],
    DATABASE_INTEGRATION_URL: databaseUrls[group.database],
    REDIS_INTEGRATION_URL: redisUrls[group.redis],
    ADS_D_TEST_DATABASE_URL: databaseUrls.adsD,
    ADS_E_TEST_DATABASE_URL: databaseUrls.adsE,
    ADS_E_TEST_REDIS_URL: redisUrls.main,
    RETENTION_TEST_DATABASE_URL: databaseUrls.retention,
    CALENDAR_TEST_DATABASE_URL: databaseUrls.main,
    CALENDAR_TEST_PSQL_MODE: 'docker-integration-gate',
    CALENDAR_TEST_COMPOSE_PROJECT: project,
  };
}

mkdirSync(artifactDir, { recursive: true });
const results = [];
let started = false;
let failure;
try {
  for (const port of [55432, 55433, 55439, 55888, 56379, 56380])
    await assertPortFree(port);
  process.stdout.write('INTEGRATION_GATE_PORTS_FREE loopback-only\n');
  started = true;
  docker(['up', '-d', '--wait']);
  process.stdout.write('INTEGRATION_GATE_CONTAINERS_READY\n');
  run(process.execPath, ['./node_modules/prisma/build/index.js', 'generate']);
  createDatabase('postgres-main', 'learning_test', 'ads_d_test_gate');
  createDatabase('postgres-main', 'learning_test', 'ads_e_test_gate');
  createDatabase('postgres-a7', 'a7_d16_test', 'retention_test');
  for (const database of Object.keys(databaseUrls)) migrate(database);
  process.stdout.write('INTEGRATION_GATE_DATABASES_MIGRATED\n');

  for (const group of suiteGroups) {
    for (const suite of group.suites) {
      const outputFile = resolve(artifactDir, `${suite}.json`);
      const args = [
        './node_modules/jest/bin/jest.js',
        '--config',
        './test/jest-integration.json',
        '--runInBand',
        '--json',
        '--outputFile',
        outputFile,
        '--runTestsByPath',
        `test/${suite}`,
      ];
      const child = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        env: suiteEnv(group),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600_000,
        windowsHide: true,
      });
      writeFileSync(
        resolve(artifactDir, `${suite}.log`),
        `${child.stdout ?? ''}\n${child.stderr ?? ''}`,
      );
      let jest = {};
      try {
        jest = JSON.parse(readFileSync(outputFile, 'utf8'));
      } catch {
        // A setup failure may precede Jest's JSON output.
      }
      const result = {
        suite,
        database: group.database,
        exitCode: child.status,
        passed: jest.numPassedTests ?? 0,
        failed: jest.numFailedTests ?? 0,
        skipped: jest.numPendingTests ?? 0,
        testSuitesFailed: jest.numFailedTestSuites ?? 1,
      };
      results.push(result);
      process.stdout.write(`INTEGRATION_SUITE ${JSON.stringify(result)}\n`);
    }
  }
  if (
    results.some(
      (result) =>
        result.exitCode !== 0 ||
        result.testSuitesFailed ||
        result.passed === 0 ||
        result.skipped > (allowedSkippedTests[result.suite] ?? 0),
    )
  )
    throw new Error('One or more integration suites failed');
} catch (error) {
  failure = error;
} finally {
  if (started) {
    try {
      docker(['down', '--volumes', '--remove-orphans']);
    } catch (error) {
      failure ??= error;
    }
  }
  const summary = {
    status: failure ? 'FAILED' : 'PASSED',
    expectedSuiteCount: expectedSuites.length,
    executedSuiteCount: results.length,
    passed: results.reduce((sum, result) => sum + result.passed, 0),
    failed: results.reduce((sum, result) => sum + result.failed, 0),
    skipped: results.reduce((sum, result) => sum + result.skipped, 0),
    results,
    error: failure instanceof Error ? failure.message : undefined,
    infrastructure: 'disposable Docker Compose; loopback ports only',
  };
  writeFileSync(
    resolve(artifactDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(`INTEGRATION_GATE_SUMMARY ${JSON.stringify(summary)}\n`);
}
if (failure) throw failure;

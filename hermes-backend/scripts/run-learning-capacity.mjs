import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT,
  assertDiskPreflight,
  assertNoTargetOverride,
  isolatedTargets,
  parseCapacityArgs,
} from './learning-capacity-config.mjs';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const safeEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: process.env.LANG || 'C',
};
const interruption = new AbortController();
let signalCode = 0;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    signalCode = code;
    interruption.abort();
  });
}

function output(command, args, env = safeEnv) {
  return execFileSync(command, args, {
    cwd: backend,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(command, args, env, signal = interruption.signal) {
  return new Promise((resolveResult, reject) => {
    const options = {
      cwd: backend,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (signal) options.signal = signal;
    const child = spawn(command, args, options);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveResult(stdout);
      else
        reject(
          new Error(`${command} ${args[0]} failed (${code ?? 'interrupted'})`),
        );
    });
  });
}

function projectResourceCounts() {
  const filter = `name=${PROJECT}`;
  return {
    containers: output('docker', ['ps', '-aq', '--filter', filter])
      .trim()
      .split('\n')
      .filter(Boolean).length,
    networks: output('docker', ['network', 'ls', '-q', '--filter', filter])
      .trim()
      .split('\n')
      .filter(Boolean).length,
    volumes: output('docker', ['volume', 'ls', '-q', '--filter', filter])
      .trim()
      .split('\n')
      .filter(Boolean).length,
  };
}

function requireEmptyProject() {
  const counts = projectResourceCounts();
  if (Object.values(counts).some(Boolean)) {
    throw new Error('Refusing to touch existing isolated project resources');
  }
}

async function main() {
  const args = parseCapacityArgs(process.argv.slice(2));
  if (
    process.env.DOCKER_HOST &&
    process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock'
  ) {
    throw new Error('Refusing a non-local Docker host');
  }
  if (
    output('docker', ['context', 'show']).trim() !== 'default' ||
    output('docker', [
      'context',
      'inspect',
      'default',
      '--format',
      '{{(index .Endpoints "docker").Host}}',
    ]).trim() !== 'unix:///var/run/docker.sock'
  ) {
    throw new Error('Refusing a non-local Docker context');
  }
  const compose = JSON.parse(
    output('docker', [
      'compose',
      '-f',
      'docker-compose.learning-test.yml',
      '-p',
      PROJECT,
      'config',
      '--format',
      'json',
    ]),
  );
  const targets = isolatedTargets(compose);
  assertNoTargetOverride(process.env, targets);
  const disk = assertDiskPreflight(output('df', ['-Pk', '/']));
  if (
    output('git', ['status', '--porcelain', '--untracked-files=all']).trim()
  ) {
    throw new Error('Capacity harness requires a clean committed worktree');
  }
  requireEmptyProject();
  if (
    output('ss', ['-H', '-ltn', '( sport = :55432 or sport = :56379 )']).trim()
  ) {
    throw new Error('Isolated loopback ports are already occupied');
  }
  process.stdout.write(
    `profile=${args.profile} preflight_free_bytes=${disk.availableBytes} use_pct=${disk.usedPercent}\n`,
  );
  const env = {
    ...safeEnv,
    NODE_ENV: 'test',
    DATABASE_URL: targets.databaseUrl,
    REDIS_URL: targets.redisUrl,
    CAPACITY_ISOLATED_CONFIRMED: '1',
  };
  let attemptedUp = false;
  let workError;
  try {
    attemptedUp = true;
    await run('npm', ['run', 'learning:harness:up'], safeEnv);
    await run(
      process.execPath,
      ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      env,
    );
    const result = await run(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        'scripts/learning-capacity-workload.cjs',
        String(args.concurrency),
        String(args.turns),
        String(args.durationSeconds),
        args.profile,
      ],
      env,
    );
    const summary = JSON.parse(result.trim().split('\n').at(-1));
    if (
      summary.profile !== args.profile ||
      summary.errors !== 0 ||
      summary.completed < 1
    ) {
      throw new Error('Capacity workload did not complete successfully');
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    workError = error;
  } finally {
    if (attemptedUp) {
      try {
        await run('npm', ['run', 'learning:harness:down'], safeEnv, null);
      } catch {
        workError ||= new Error('Official harness cleanup failed');
      }
    }
    const remaining = projectResourceCounts();
    const listeners = output('ss', [
      '-H',
      '-ltn',
      '( sport = :55432 or sport = :56379 )',
    ])
      .trim()
      .split('\n')
      .filter(Boolean).length;
    process.stdout.write(
      `cleanup_containers=${remaining.containers} networks=${remaining.networks} volumes=${remaining.volumes} ports=${listeners}\n`,
    );
    if (Object.values(remaining).some(Boolean) || listeners) {
      workError = new Error('Isolated project resources remain after cleanup');
    }
  }
  if (signalCode) throw new Error('Capacity harness interrupted after cleanup');
  if (workError) throw workError;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = signalCode || 1;
});

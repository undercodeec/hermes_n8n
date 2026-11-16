import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Observed on ca85b991's unmodified migrations/datamodel. Never repair unrelated
// schema here; reject any drift beyond this exact, documented pilot baseline.
export const KNOWN_PILOT_DRIFT = `[*] Changed the \`advertising_daily_metrics\` table
  [*] Renamed index \`advertising_daily_metrics_integrationId_campaignId_metricDate_k\` to \`advertising_daily_metrics_integrationId_campaignId_metricDa_key\`

[*] Changed the \`campaign_template_media\` table
  [*] Renamed index \`campaign_template_media_wabaId_templateName_templateLanguage_he\` to \`campaign_template_media_wabaId_templateName_templateLanguag_key\`

[*] Changed the \`retention_recovery_policy\` table
  [*] Altered column \`updatedAt\` (default changed from \`Some(Now)\` to \`None\`)

[*] Changed the \`transfer_payment_proof_messages\` table
  [*] Renamed index \`transfer_payment_proof_messages_transferPaymentId_receivedAt_id\` to \`transfer_payment_proof_messages_transferPaymentId_receivedA_idx\``;

// No Compose, bind mounts, named volumes, existing databases or caller URLs.
export function runInboxOrderIntegration({
  spawn = spawnSync,
  log = console.log,
  exportFixture = false,
  serveLocal = false,
} = {}) {
  const id = randomUUID().replaceAll('-', '');
  const project = `hermes-inbox-test-${id}`;
  const database = `inbox_test_${id}`;
  const password = randomUUID();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(
        key,
      ),
    ),
  );
  env.NODE_ENV = 'test';
  if (exportFixture) env.INBOX_ORDER_EXPORT_FIXTURE = '1';
  if (serveLocal) {
    // Explicit synthetic test secret only; never inherit production config.
    env.INBOX_LOCAL_PROOF_SECRET = 'inbox-local-synthetic-proof-20261110-only';
    env.INBOX_ORDER_SERVE_LOCAL = '1';
  }
  function run(command, args, { allowedStatus = [0], ...options } = {}) {
    const result = spawn(command, args, {
      env,
      encoding: 'utf8',
      windowsHide: true,
      ...options,
    });
    if (result.error || !allowedStatus.includes(result.status))
      throw new Error(
        `${command} ${args[0]} failed (exit ${result.status}): ${result.error?.message ?? (result.stderr || result.stdout)}`,
      );
    return result.stdout?.trim() ?? '';
  }
  if (run('docker', ['context', 'show']) !== 'desktop-linux')
    throw new Error('Only the local desktop-linux context is allowed');
  const endpoint = JSON.parse(
    run('docker', ['context', 'inspect', 'desktop-linux']),
  )[0].Endpoints.docker.Host;
  if (!endpoint.startsWith('npipe:////./pipe/'))
    throw new Error('Refusing a non-local Docker endpoint');
  // Pin all subsequent operations, even if another session changes its context.
  env.DOCKER_CONTEXT = 'desktop-linux';
  run('docker', ['info', '--format', '{{.ServerVersion}}']);
  let failure;
  const cleanupErrors = [];
  try {
    const network = run('docker', [
      'network',
      'create',
      '--label',
      `com.docker.compose.project=${project}`,
      project,
    ]);
    const container = run('docker', [
      'run',
      '-d',
      '--pull=never',
      '--name',
      project,
      '--label',
      `com.docker.compose.project=${project}`,
      '--network',
      network,
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      '127.0.0.1::5432',
      '-e',
      `POSTGRES_DB=${database}`,
      '-e',
      'POSTGRES_USER=inbox_test',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      'postgres:16-alpine',
    ]);
    const port = run('docker', ['port', container, '5432/tcp'])
      .split(':')
      .at(-1);
    env.DATABASE_URL = `postgresql://inbox_test:${password}@127.0.0.1:${port}/${database}?schema=public`;
    env.INBOX_ORDER_TEST_DATABASE_URL = env.DATABASE_URL;
    env.INBOX_ORDER_TEST_DATABASE_NAME = database;
    log(
      `Created ${project}; target 127.0.0.1:${port}/${database} (disposable)`,
    );
    run('docker', [
      'exec',
      container,
      'sh',
      '-c',
      'for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -U inbox_test >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1',
    ]);
    const migrations = readdirSync('prisma/migrations')
      .filter((name) => name !== 'migration_lock.toml')
      .sort();
    for (const name of migrations) {
      run(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'inbox_test',
          '-d',
          database,
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          input: readFileSync(
            `prisma/migrations/${name}/migration.sql`,
            'utf8',
          ),
        },
      );
    }
    log(
      `Applied ${migrations.length} existing migration SQL files to the new disposable database`,
    );
    const drift = run(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-url',
        env.DATABASE_URL,
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { allowedStatus: [0, 2] },
    ).replaceAll('\r\n', '\n');
    if (drift === KNOWN_PILOT_DRIFT) {
      log(`Known pre-existing pilot schema drift (unchanged):\n${drift}`);
    } else if (!drift || drift === 'No difference detected.') {
      log(
        'Fresh migration database matches the pilot Prisma datamodel (no drift)',
      );
    } else {
      throw new Error(
        `Unexpected schema drift; do not continue fixture writes:\n${drift}`,
      );
    }
    run(
      process.execPath,
      [
        'node_modules/jest/bin/jest.js',
        '--config',
        'test/jest-integration.json',
        '--runInBand',
        '--runTestsByPath',
        'test/conversations-inbox-order.integration-spec.ts',
      ],
      { stdio: 'inherit' },
    );
  } catch (error) {
    failure = error;
  } finally {
    // Failed creates may leave resources without a returned ID. Discover only
    // this invocation's unique label/name; never skip network cleanup on error.
    for (const resource of ['container', 'network']) {
      try {
        const owned = run('docker', [
          ...(resource === 'container'
            ? ['ps', '-aq']
            : ['network', 'ls', '-q']),
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--filter',
          `name=${project}`,
        ])
          .split(/\s+/)
          .filter(Boolean);
        for (const ownedId of owned) {
          try {
            run(
              'docker',
              resource === 'container'
                ? ['rm', '-f', ownedId]
                : ['network', 'rm', ownedId],
            );
            log(`Removed task ${resource} ${project} (${ownedId})`);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      `Task ${project} failed cleanup; inspect only resources labelled com.docker.compose.project=${project}`,
    );
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runInboxOrderIntegration({
    exportFixture: process.argv.includes('--export-fixture'),
    serveLocal: process.argv.includes('--serve-local'),
  });

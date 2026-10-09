import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDiskPreflight,
  assertNoTargetOverride,
  isolatedTargets,
  parseCapacityArgs,
} from './learning-capacity-config.mjs';

const compose = {
  name: 'hermes-learning-test',
  networks: { default: { name: 'hermes-learning-test_default' } },
  volumes: {
    learning_test_pgdata: { name: 'hermes-learning-test_learning_test_pgdata' },
  },
  services: {
    postgres: {
      image: 'postgres:16-alpine',
      environment: {
        POSTGRES_USER: 'learning_test',
        POSTGRES_PASSWORD: 'test_only',
        POSTGRES_DB: 'hermes_learning_test',
      },
      ports: [{ host_ip: '127.0.0.1', published: '55432', target: 5432 }],
      networks: { default: null },
      volumes: [
        {
          type: 'volume',
          source: 'learning_test_pgdata',
          target: '/var/lib/postgresql/data',
        },
      ],
    },
    redis: {
      image: 'redis:7-alpine',
      ports: [{ host_ip: '127.0.0.1', published: '56379', target: 6379 }],
      networks: { default: null },
    },
  },
};

test('smoke is conservative and all custom parameters are bounded', () => {
  assert.deepEqual(parseCapacityArgs([]), {
    concurrency: 1,
    turns: 4,
    durationSeconds: 10,
    profile: 'smoke',
  });
  assert.equal(
    parseCapacityArgs(['--turns', '20']).profile,
    'custom-unapproved',
  );
  assert.throws(() => parseCapacityArgs(['--concurrency', '0']));
  assert.throws(() => parseCapacityArgs(['--turns', '5001']));
  assert.throws(() => parseCapacityArgs(['--duration-seconds', '1.5']));
});

test('rejects production targets and altered Compose project resources', () => {
  const targets = isolatedTargets(compose);
  assertNoTargetOverride({}, targets);
  assert.throws(() =>
    assertNoTargetOverride(
      { DATABASE_URL: 'postgresql://production.invalid/db' },
      targets,
    ),
  );
  assert.throws(() =>
    assertNoTargetOverride(
      { REDIS_URL: 'redis://production.invalid/0' },
      targets,
    ),
  );
  assert.throws(() => isolatedTargets({ ...compose, name: 'hermes-backend' }));
  assert.throws(() =>
    isolatedTargets({
      ...compose,
      networks: { default: { ...compose.networks.default, external: true } },
    }),
  );
  assert.throws(() =>
    isolatedTargets({
      ...compose,
      services: {
        ...compose.services,
        redis: {
          ...compose.services.redis,
          ports: [{ host_ip: '0.0.0.0', published: '56379' }],
        },
      },
    }),
  );
});

test('requires the disk gate before any Docker resource is created', () => {
  assert.deepEqual(
    assertDiskPreflight(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 10000000 1000 9000000 80% /\n',
    ),
    {
      availableBytes: 9000000 * 1024,
      usedPercent: 80,
    },
  );
  assert.throws(() =>
    assertDiskPreflight(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 10000000 1000 7000000 80% /\n',
    ),
  );
  assert.throws(() =>
    assertDiskPreflight(
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 10000000 1000 9000000 86% /\n',
    ),
  );
});

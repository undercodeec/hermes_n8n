import { spawnSync } from 'node:child_process';

const databaseUrl =
  process.env.LEARNING_TEST_DATABASE_URL ||
  'postgresql://learning_test:learning_test_only@127.0.0.1:55432/hermes_learning_test?schema=public';
const redisUrl =
  process.env.LEARNING_TEST_REDIS_URL || 'redis://127.0.0.1:56379/0';

function assertIsolated(url, expectedPort, expectedName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid isolated test URL: ${url}`);
  }
  if (
    parsed.protocol !== 'postgresql:' &&
    parsed.protocol !== 'postgres:' &&
    parsed.protocol !== 'redis:'
  ) {
    throw new Error(`Unexpected isolated test protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== expectedPort) {
    throw new Error(`Refusing non-local isolated test target: ${url}`);
  }
  if (expectedName && !parsed.pathname.includes(expectedName)) {
    throw new Error(`Refusing unexpected isolated test database: ${url}`);
  }
}

assertIsolated(databaseUrl, '55432', 'hermes_learning_test');
assertIsolated(redisUrl, '56379');

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_INTEGRATION_URL: databaseUrl,
  REDIS_INTEGRATION_URL: redisUrl,
};

for (const command of [
  [
    process.execPath,
    ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  ],
  [
    process.execPath,
    [
      './node_modules/jest/bin/jest.js',
      '--config',
      './test/jest-integration.json',
      '--runInBand',
      'test/conversation-learning.integration-spec.ts',
    ],
  ],
]) {
  const result = spawnSync(command[0], command[1], {
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

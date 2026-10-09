export const PROJECT = 'hermes-learning-test';
export const SMOKE = Object.freeze({
  concurrency: 1,
  turns: 4,
  durationSeconds: 10,
});

function positiveInteger(value, key, maximum) {
  if (!/^[0-9]+$/.test(value || '')) throw new Error(`Invalid ${key}`);
  const number = Number(value);
  if (number < 1 || number > maximum) throw new Error(`Invalid ${key}`);
  return number;
}

export function parseCapacityArgs(argv) {
  const result = { ...SMOKE };
  const seen = new Set();
  const limits = {
    '--concurrency': 16,
    '--turns': 5000,
    '--duration-seconds': 300,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!(flag in limits) || seen.has(flag) || !argv[i + 1]) {
      throw new Error(
        'Expected unique --concurrency, --turns or --duration-seconds options',
      );
    }
    seen.add(flag);
    const key =
      flag === '--duration-seconds' ? 'durationSeconds' : flag.slice(2);
    result[key] = positiveInteger(argv[i + 1], key, limits[flag]);
  }
  return { ...result, profile: seen.size ? 'custom-unapproved' : 'smoke' };
}

function exactly(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`Refusing unexpected isolated ${label}`);
}

export function isolatedTargets(compose) {
  exactly(compose?.name, PROJECT, 'project');
  const services = compose?.services || {};
  exactly(Object.keys(services).sort().join(','), 'postgres,redis', 'services');
  const networks = compose?.networks || {};
  exactly(Object.keys(networks).join(','), 'default', 'network set');
  exactly(networks.default?.name, `${PROJECT}_default`, 'network name');
  exactly(Boolean(networks.default?.external), false, 'external network');
  const volumes = compose?.volumes || {};
  exactly(Object.keys(volumes).join(','), 'learning_test_pgdata', 'volume set');
  exactly(
    volumes.learning_test_pgdata?.name,
    `${PROJECT}_learning_test_pgdata`,
    'volume name',
  );
  exactly(
    Boolean(volumes.learning_test_pgdata?.external),
    false,
    'external volume',
  );
  const postgres = services.postgres;
  const redis = services.redis;
  exactly(postgres.image, 'postgres:16-alpine', 'PostgreSQL image');
  exactly(redis.image, 'redis:7-alpine', 'Redis image');
  exactly(Boolean(postgres.build || redis.build), false, 'service build');
  exactly(
    Boolean(postgres.container_name || redis.container_name),
    false,
    'container name override',
  );
  exactly(
    Boolean(postgres.env_file || redis.env_file),
    false,
    'environment file',
  );
  exactly(postgres.ports?.length, 1, 'PostgreSQL port count');
  exactly(redis.ports?.length, 1, 'Redis port count');
  for (const [service, expected, target] of [
    [postgres, '55432', 5432],
    [redis, '56379', 6379],
  ]) {
    exactly(service.ports[0].host_ip, '127.0.0.1', 'port address');
    exactly(String(service.ports[0].published), expected, 'port');
    exactly(Number(service.ports[0].target), target, 'container port');
    exactly(service.network_mode ?? null, null, 'network mode');
    exactly(
      Object.keys(service.networks || {}).join(','),
      'default',
      'service network',
    );
  }
  exactly(postgres.volumes?.length, 1, 'PostgreSQL mount count');
  exactly(postgres.volumes[0].type, 'volume', 'PostgreSQL mount type');
  exactly(
    postgres.volumes[0].source,
    'learning_test_pgdata',
    'PostgreSQL mount source',
  );
  exactly(
    postgres.volumes[0].target,
    '/var/lib/postgresql/data',
    'PostgreSQL mount target',
  );
  exactly((redis.volumes || []).length, 0, 'Redis mount count');
  const settings = postgres.environment || {};
  exactly(
    Object.keys(settings).sort().join(','),
    'POSTGRES_DB,POSTGRES_PASSWORD,POSTGRES_USER',
    'PostgreSQL environment',
  );
  exactly(settings.POSTGRES_DB, 'hermes_learning_test', 'PostgreSQL database');
  exactly(settings.POSTGRES_USER, 'learning_test', 'PostgreSQL user');
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
    if (!settings[key] || !/^[a-zA-Z0-9_]+$/.test(settings[key])) {
      throw new Error('Isolated PostgreSQL settings are missing');
    }
  }
  const database = new URL(
    `postgresql://127.0.0.1:55432/${settings.POSTGRES_DB}`,
  );
  database.username = settings.POSTGRES_USER;
  database.password = settings.POSTGRES_PASSWORD;
  database.searchParams.set('schema', 'public');
  const redisUrl = 'redis://127.0.0.1:56379/0';
  return { databaseUrl: database.toString(), redisUrl };
}

export function assertNoTargetOverride(env, targets) {
  for (const key of [
    'DATABASE_URL',
    'DATABASE_INTEGRATION_URL',
    'LEARNING_TEST_DATABASE_URL',
  ]) {
    if (env[key] && env[key] !== targets.databaseUrl) {
      throw new Error(`Refusing non-isolated ${key}`);
    }
  }
  for (const key of [
    'REDIS_URL',
    'REDIS_INTEGRATION_URL',
    'LEARNING_TEST_REDIS_URL',
  ]) {
    if (env[key] && env[key] !== targets.redisUrl) {
      throw new Error(`Refusing non-isolated ${key}`);
    }
  }
}

export function assertDiskPreflight(dfOutput) {
  const row = dfOutput.trim().split('\n').at(-1)?.trim().split(/\s+/);
  const availableKiB = Number(row?.[3]);
  const usedPercent = Number(row?.[4]?.replace('%', ''));
  if (!Number.isFinite(availableKiB) || !Number.isFinite(usedPercent)) {
    throw new Error('Unable to verify disk capacity');
  }
  if (availableKiB * 1024 < 8 * 1024 ** 3 || usedPercent > 85) {
    throw new Error(
      'Disk preflight failed: require at least 8 GiB free and at most 85% used',
    );
  }
  return { availableBytes: availableKiB * 1024, usedPercent };
}

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const port = process.env.COMMERCIAL_RECOVERY_TEST_PORT;
const psql = process.env.PSQL_BIN;
if (!port || !psql)
  throw new Error(
    'Set COMMERCIAL_RECOVERY_TEST_PORT and PSQL_BIN for the isolated local cluster',
  );
const baseDir = resolve('scripts/commercial-base-recovery');
const preflight = join(baseDir, 'preflight.sql');
const repair = join(baseDir, 'repair.sql');
const verify = join(baseDir, 'verify.sql');
let sequence = 0;

function envFor(schema) {
  return {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: port,
    PGUSER: 'hermes_recovery',
    PGDATABASE: 'postgres',
    PGOPTIONS: `-c search_path=${schema},public`,
    PGCONNECT_TIMEOUT: '3',
  };
}

function sql(schema, source) {
  return execFileSync(psql, ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-tA'], {
    env: envFor(schema),
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function file(schema, path) {
  return execFileSync(
    psql,
    ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-tA', '-f', path],
    {
      env: envFor(schema),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
}

function emptySchema() {
  const schema = `recovery_${process.pid}_${++sequence}`;
  sql('public', `CREATE SCHEMA ${schema};`);
  return schema;
}

function setup() {
  const schema = emptySchema();
  sql(
    'public',
    `CREATE TABLE ${schema}.products (LIKE public.products INCLUDING ALL);
    CREATE TABLE ${schema}.price_lists (LIKE public.price_lists INCLUDING ALL);
    ALTER TABLE ${schema}.price_lists ADD CONSTRAINT price_lists_productId_fkey
      FOREIGN KEY ("productId") REFERENCES ${schema}.products("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  );
  return schema;
}

const product = `INSERT INTO products ("id","name","description","category","serviceCode","sku","imageUrl","isActive","metadata","createdAt","updatedAt") VALUES
  ('commercial-product-landing-basic','Landing Básica','Landing page de una sola sección.','Landing Page','LANDING_PAGE','commercial-landing-basic',NULL,true,'{"commercialTerms":{"renewalUsdPerYear":40,"estimatedBusinessDays":10}}'::jsonb,'2026-09-23','2026-09-25');`;
const price = `INSERT INTO price_lists ("id","productId","name","price","currency","market","priceType","taxMode","taxLabel","taxRatePercent","scope","policyVersion","isPromotion","supersedesPriceListId","validFrom","validUntil","restrictions","notes","isActive","createdAt","updatedAt") VALUES
  ('commercial-price-landing-basic-global-v1','commercial-product-landing-basic','Tarifa global vigente',250.00,'USD',NULL,'FIXED','INCLUDED','IVA',NULL,'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.','global-v1',false,NULL,'2026-09-23',NULL,NULL,'Precio confirmado para Hermes.',true,'2026-09-23','2026-09-23');`;

function verdict(schema) {
  return file(schema, preflight).split('|')[0];
}

function counts(schema) {
  return sql(
    schema,
    `SELECT (SELECT count(*) FROM products WHERE "id"='commercial-product-landing-basic'),
    (SELECT count(*) FROM price_lists WHERE "id"='commercial-price-landing-basic-global-v1');`,
  );
}

test('missing rows are restored selectively and verified', () => {
  const schema = setup();
  assert.equal(verdict(schema), 'BASE_CATALOG_MISSING');
  assert.equal(counts(schema), '0|0');
  assert.throws(() => file(schema, verify));
  assert.equal(counts(schema), '0|0');
  file(schema, repair);
  assert.equal(verdict(schema), 'BASE_CATALOG_ALREADY_VALID');
  assert.match(file(schema, verify), /BASE_CATALOG_ALREADY_VALID/);
  assert.equal(counts(schema), '1|1');
  assert.equal(
    sql(
      schema,
      `SELECT count(*) FROM price_lists t JOIN products p ON p."id"=t."productId" WHERE p."id"='commercial-product-landing-basic' AND t."id"='commercial-price-landing-basic-global-v1';`,
    ),
    '1',
  );
});

test('an existing valid product is preserved while its tariff is restored', () => {
  const schema = setup();
  sql(schema, product);
  assert.equal(verdict(schema), 'BASE_CATALOG_PARTIAL');
  const before = sql(
    schema,
    `SELECT "createdAt"::text FROM products WHERE "id"='commercial-product-landing-basic';`,
  );
  file(schema, repair);
  assert.equal(verdict(schema), 'BASE_CATALOG_ALREADY_VALID');
  assert.equal(
    sql(
      schema,
      `SELECT "createdAt"::text FROM products WHERE "id"='commercial-product-landing-basic';`,
    ),
    before,
  );
});

test('valid rows survive repeated execution without duplicates', () => {
  const schema = setup();
  sql(schema, product + price);
  assert.equal(verdict(schema), 'BASE_CATALOG_ALREADY_VALID');
  file(schema, repair);
  file(schema, repair);
  assert.equal(counts(schema), '1|1');
});

test('a reused SKU with another product ID is a blocking conflict', () => {
  const schema = setup();
  sql(
    schema,
    product.replace('commercial-product-landing-basic', 'another-product'),
  );
  assert.equal(verdict(schema), 'BASE_CATALOG_CONFLICT');
  assert.throws(() => file(schema, repair));
  assert.equal(counts(schema), '0|0');
});

test('a tariff with an unauthorized amount is a blocking conflict', () => {
  const schema = setup();
  sql(schema, product + price.replace('250.00', '299.00'));
  assert.equal(verdict(schema), 'BASE_CATALOG_CONFLICT');
  assert.throws(() => file(schema, repair));
  assert.equal(counts(schema), '1|1');
});

test('a product with unauthorized commercial terms is a blocking conflict', () => {
  const schema = setup();
  sql(
    schema,
    product.replace('"renewalUsdPerYear":40', '"renewalUsdPerYear":80'),
  );
  assert.equal(verdict(schema), 'BASE_CATALOG_CONFLICT');
  assert.throws(() => file(schema, repair));
  assert.equal(counts(schema), '1|0');
});

test('a second global-v1 tariff for the product is a blocking conflict', () => {
  const schema = setup();
  sql(
    schema,
    product +
      price.replace(
        'commercial-price-landing-basic-global-v1',
        'another-global-price',
      ),
  );
  assert.equal(verdict(schema), 'BASE_CATALOG_CONFLICT');
  assert.throws(() => file(schema, repair));
  assert.equal(counts(schema), '1|0');
});

test('an insert failure rolls back the product and tariff together', () => {
  const schema = setup();
  sql(
    'public',
    `CREATE FUNCTION ${schema}.reject_tariff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER reject_tariff BEFORE INSERT ON ${schema}.price_lists FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_tariff();`,
  );
  assert.throws(() => file(schema, repair));
  assert.equal(counts(schema), '0|0');
});

test('two concurrent repairs serialize and leave one pair of rows', async () => {
  const schema = setup();
  const args = ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-tA', '-f', repair];
  await Promise.all([
    execFileAsync(psql, args, { env: envFor(schema) }),
    execFileAsync(psql, args, { env: envFor(schema) }),
  ]);
  assert.equal(counts(schema), '1|1');
});

test('Prisma applies Black Friday after repair and leaves it inactive', () => {
  const schema = emptySchema();
  const temp = mkdtempSync(join(tmpdir(), 'hermes-recovery-prisma-'));
  const migrations = join(temp, 'migrations');
  const baseline = join(migrations, '20261028000000_test_schema');
  const campaign = join(migrations, '20261029200000_black_friday_landing_80');
  mkdirSync(baseline, { recursive: true });
  copyFileSync(resolve('prisma/schema.prisma'), join(temp, 'schema.prisma'));
  copyFileSync(
    resolve('prisma/migrations/migration_lock.toml'),
    join(migrations, 'migration_lock.toml'),
  );
  writeFileSync(
    join(baseline, 'migration.sql'),
    `CREATE TABLE products (LIKE public.products INCLUDING ALL);
    CREATE TABLE price_lists (LIKE public.price_lists INCLUDING ALL);
    ALTER TABLE price_lists ADD CONSTRAINT price_lists_productId_fkey FOREIGN KEY ("productId") REFERENCES products("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  );
  const prisma = resolve('node_modules/prisma/build/index.js');
  const prismaOptions = {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://hermes_recovery@127.0.0.1:${port}/postgres?schema=${schema}`,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  execFileSync(
    process.execPath,
    [prisma, 'migrate', 'deploy', '--schema', join(temp, 'schema.prisma')],
    prismaOptions,
  );
  assert.equal(verdict(schema), 'BASE_CATALOG_MISSING');
  file(schema, repair);
  mkdirSync(campaign);
  copyFileSync(
    resolve(
      'prisma/migrations/20261029200000_black_friday_landing_80/migration.sql',
    ),
    join(campaign, 'migration.sql'),
  );
  execFileSync(
    process.execPath,
    [prisma, 'migrate', 'deploy', '--schema', join(temp, 'schema.prisma')],
    prismaOptions,
  );
  assert.equal(
    sql(
      schema,
      `SELECT count(*) FROM price_lists WHERE "id"='commercial-price-landing-black-friday-80-global-v1' AND "price"=80.00 AND "isActive"=false AND "validUntil" IS NULL AND "supersedesPriceListId"='commercial-price-landing-basic-global-v1';`,
    ),
    '1',
  );
  assert.equal(counts(schema), '1|1');
});

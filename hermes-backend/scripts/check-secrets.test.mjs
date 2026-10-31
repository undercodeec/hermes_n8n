import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scanner = join(
  dirname(fileURLToPath(import.meta.url)),
  'check-secrets.mjs',
);

function scan(source, extension = '.ts') {
  const root = mkdtempSync(join(tmpdir(), 'hermes-secret-scan-'));
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(scanner, join(scripts, 'check-secrets.mjs'));
    writeFileSync(join(root, `sample${extension}`), source);
    const init = spawnSync('git', ['init', '--quiet'], { cwd: root });
    assert.equal(init.status, 0);
    return spawnSync(process.execPath, [join(scripts, 'check-secrets.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
  } finally {
    // This function creates the directory beneath the system temp directory.
    assert.ok(
      resolve(root).startsWith(
        `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`,
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
}

test('a variable passed into an API key field is not a literal secret', () => {
  assert.equal(
    scan('const settings = {\n  HERMES_API_KEY: key,\n};\n').status,
    0,
  );
});

test('a literal API key assignment remains detected', () => {
  const result = scan(
    "const settings = {\n  HERMES_API_KEY: 'real-looking-token',\n};\n",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HERMES_API_KEY \(literal secret assignment\)/);
});

test('a non-fixture embedded URL credential remains detected', () => {
  const url = [
    'postgresql://user:',
    'operational-looking-value',
    '@localhost/db',
  ].join('');
  const result = scan(`const url = '${url}';\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CREDENTIAL_URL \(embedded URL credential\)/);
});

test('an explicitly named fixture URL credential is accepted', () => {
  const url = [
    'postgresql://user:',
    'fixture-local-only',
    '@127.0.0.1/db',
  ].join('');
  assert.equal(scan(`const url = '${url}';\n`).status, 0);
});

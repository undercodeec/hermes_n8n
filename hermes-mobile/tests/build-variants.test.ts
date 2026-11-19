import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const crm = 'https://api.undercodeec.com';
const hermes = 'https://api.undercodeec.com';
const config = (variables: Record<string, string>) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('EXPO_PUBLIC_') || key.startsWith('HERMES_MOBILE_')) delete env[key];
  const run = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./app.config.js")))'], {
    cwd: process.cwd(), env: { ...env, ...variables }, encoding: 'utf8',
  });
  return run;
};

test('default bundle is offline demo with distinct package and no integration configuration', () => {
  const result = config({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).android.package, 'com.undercodeec.hermescrmdemo.test');
  assert.equal(JSON.parse(result.stdout).android.allowBackup, false);
  assert.notEqual(config({ EXPO_PUBLIC_MOBILE_AUTH_MODE: 'staging' }).status, 0);
});

test('isolated auth + demo cannot silently become a public read-only build', () => {
  const base = { HERMES_MOBILE_BUILD_VARIANT: 'staging', HERMES_MOBILE_ISOLATED_TEST_CONFIRMED: 'yes',
    EXPO_PUBLIC_CRM_AUTH_BASE_URL: crm, EXPO_PUBLIC_HERMES_API_BASE_URL: hermes };
  assert.notEqual(config(base).status, 0);
  assert.notEqual(config({ ...base, EXPO_PUBLIC_MOBILE_INBOX_MODE: 'read-only' }).status, 0);
});

test('public API read-only requires exact HTTPS hosts and both explicit opt-ins', () => {
  const base = { HERMES_MOBILE_BUILD_VARIANT: 'read-only-public', HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED: 'yes',
    EXPO_PUBLIC_MOBILE_AUTH_MODE: 'staging', EXPO_PUBLIC_MOBILE_INBOX_MODE: 'read-only',
    EXPO_PUBLIC_CRM_AUTH_BASE_URL: crm, EXPO_PUBLIC_HERMES_API_BASE_URL: hermes };
  const result = config(base);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).android.package, 'com.undercodeec.hermescrmreadonly.publicapitest');
  assert.equal(JSON.parse(result.stdout).name, 'Hermes CRM Read-Only - Test');
  assert.deepEqual(JSON.parse(result.stdout).android.blockedPermissions.sort(), [
    'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_IMAGES',
    'android.permission.VIBRATE',
  ].sort());
  assert.notEqual(config({ ...base, HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED: '' }).status, 0);
  assert.notEqual(config({ ...base, EXPO_PUBLIC_HERMES_API_BASE_URL: 'http://api.undercodeec.com' }).status, 0);
  assert.notEqual(config({ ...base, EXPO_PUBLIC_CRM_AUTH_BASE_URL: 'https://admincrm.undercodeec.com' }).status, 0);
  assert.notEqual(config({ ...base, EXPO_PUBLIC_MOBILE_INBOX_MODE: '' }).status, 0);
});

test('separate read-only entrypoint never imports DemoApp or its composer', () => {
  const entry = readFileSync('index.readonly.ts', 'utf8');
  const readOnly = readFileSync('src/ReadOnlyApp.tsx', 'utf8');
  assert.doesNotMatch(entry + readOnly, /\.\/App['"]|\/demo['"]|DemoApp|SEND_DEMO|reply|send/i);
  assert.match(readOnly, /MobileInboxScreen/);
});

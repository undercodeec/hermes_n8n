import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import {
  allowedSkippedTests,
  databaseUrls,
  redisUrls,
  suiteGroups,
} from './integration-gate-config.mjs';

test('assigns every general integration suite exactly once to its required isolated target', () => {
  const actual = readdirSync('test')
    .filter((name) => name.endsWith('.integration-spec.ts'))
    .sort();
  const assigned = suiteGroups.flatMap((group) => group.suites).sort();
  assert.deepEqual(assigned, actual);
  assert.equal(new Set(assigned).size, actual.length);

  const byName = Object.fromEntries(
    suiteGroups.flatMap((group) => group.suites.map((name) => [name, group])),
  );
  assert.equal(
    byName['f3-native-diagnostics.integration-spec.ts'].database,
    'a3',
  );
  assert.equal(
    byName['f3-canary-run-scope.integration-spec.ts'].database,
    'a6',
  );
  assert.equal(byName['a7-d16-critical.integration-spec.ts'].database, 'a7');
  assert.equal(
    byName['retention-policy.integration-spec.ts'].database,
    'retention',
  );
  assert.equal(byName['advertising-flow.integration-spec.ts'].database, 'adsD');
  assert.equal(
    byName['advertising-outbox.integration-spec.ts'].database,
    'adsE',
  );
  assert.equal(
    byName['calendar-meetings.integration-spec.ts'].database,
    'main',
  );

  for (const url of [
    ...Object.values(databaseUrls),
    ...Object.values(redisUrls),
  ]) {
    assert.equal(new URL(url).hostname, '127.0.0.1');
  }
  assert.equal(new URL(databaseUrls.main).port, '55432');
  assert.equal(new URL(databaseUrls.a7).port, '55433');
  assert.equal(new URL(databaseUrls.a3).port, '55439');
  assert.equal(new URL(databaseUrls.a6).port, '55888');
  assert.deepEqual(allowedSkippedTests, {
    'advertising-flow.integration-spec.ts': [
      'registers a web BFF v2 intent through Nest and resolves its signed reference',
    ],
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseTag, makeReleaseManifest } from './backend-release-manifest.mjs';

const commit = 'a'.repeat(40);
const tag = 'hermes-backend-app:phase0-trace-a1';
const image = {
  Id: `sha256:${'b'.repeat(64)}`,
  Created: '2026-10-09T18:00:00Z',
  Config: { Labels: { 'org.opencontainers.image.revision': commit } },
  RepoTags: [tag],
  RepoDigests: [`hermes-backend-app@sha256:${'c'.repeat(64)}`],
};

test('requires an explicit immutable tag and full OCI revision', () => {
  assert.throws(() => assertReleaseTag('hermes-backend-app:latest'));
  assert.throws(() => makeReleaseManifest({ ...image, Config: { Labels: {} } }, tag));
  assert.throws(() => makeReleaseManifest(image, 'hermes-backend-app:other'));
});

test('records the inspected image and validates an optional registry digest', () => {
  const local = makeReleaseManifest(image, tag);
  assert.equal(local.gitCommit, commit);
  assert.equal(local.imageId, image.Id);
  assert.equal(local.registryDigest, null);
  const digest = image.RepoDigests[0];
  assert.equal(makeReleaseManifest(image, tag, digest).registryDigest, digest);
  assert.throws(() =>
    makeReleaseManifest(image, tag, `hermes-backend-app@sha256:${'d'.repeat(64)}`),
  );
});

import { execFileSync } from 'node:child_process';
import { writeFile, link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fullCommit = /^[0-9a-f]{40}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
const registryDigest = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

export function assertReleaseTag(tag) {
  if (
    typeof tag !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(tag) ||
    tag.endsWith(':latest')
  ) {
    throw new Error('An explicit immutable image tag is required; latest is not a revision');
  }
  return tag;
}

export function makeReleaseManifest(image, tag, repoDigest = null) {
  assertReleaseTag(tag);
  const commit = image?.Config?.Labels?.['org.opencontainers.image.revision'];
  if (!fullCommit.test(commit || '')) {
    throw new Error('Image lacks a full OCI revision label');
  }
  if (!imageId.test(image?.Id || '')) {
    throw new Error('Image lacks a verifiable local image ID');
  }
  if (!image?.RepoTags?.includes(tag)) {
    throw new Error('Image tag does not match the inspected image');
  }
  const builtAt = new Date(image.Created);
  if (Number.isNaN(builtAt.getTime())) {
    throw new Error('Image lacks a valid build timestamp');
  }
  if (repoDigest !== null) {
    if (
      !registryDigest.test(repoDigest) ||
      !image?.RepoDigests?.includes(repoDigest)
    ) {
      throw new Error('Registry digest does not match the inspected image');
    }
  }
  return {
    schemaVersion: 1,
    gitCommit: commit,
    imageTag: tag,
    imageId: image.Id,
    registryDigest: repoDigest,
    builtAtUtc: builtAt.toISOString(),
  };
}

export function inspectImage(tag) {
  assertReleaseTag(tag);
  const result = execFileSync('docker', ['image', 'inspect', tag], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(result)[0];
}

export async function writeReleaseManifest(output, manifest) {
  const target = resolve(output);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    await link(temporary, target);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseArguments(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--tag', '--output', '--repo-digest'].includes(key) || !argv[i + 1]) {
      throw new Error('Expected --tag, --output and optional --repo-digest');
    }
    values[key] = argv[i + 1];
  }
  if (!values['--tag'] || !values['--output']) {
    throw new Error('Both --tag and --output are required');
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const manifest = makeReleaseManifest(
      inspectImage(args['--tag']),
      args['--tag'],
      args['--repo-digest'] || null,
    );
    await writeReleaseManifest(args['--output'], manifest);
    process.stdout.write('Release manifest written from inspected OCI metadata\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

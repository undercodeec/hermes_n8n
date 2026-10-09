import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseTag,
  inspectImage,
  makeReleaseManifest,
  writeReleaseManifest,
} from './backend-release-manifest.mjs';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(backend, '..');

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--tag' ||
    argv[2] !== '--manifest'
  ) {
    throw new Error('Usage: node scripts/build-backend-release.mjs --tag IMAGE:IMMUTABLE_TAG --manifest OUTSIDE_REPO.json');
  }
  return { tag: assertReleaseTag(argv[1]), output: resolve(argv[3]) };
}

try {
  const { tag, output } = parseArguments(process.argv.slice(2));
  if (output === repository || output.startsWith(`${repository}${sep}`)) {
    throw new Error('Release manifest output must be outside the source checkout');
  }
  const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Source checkout has no full Git commit SHA');
  }
  const dirty = execFileSync(
    'git',
    ['-C', repository, 'status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8' },
  );
  if (dirty.trim()) {
    throw new Error('Build requires a clean committed source checkout');
  }
  const build = spawnSync(
    'docker',
    ['build', '--pull=false', '--build-arg', `GIT_COMMIT=${commit}`, '--tag', tag, backend],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) {
    throw new Error(`Docker build failed (${build.status ?? 'interrupted'})`);
  }
  const manifest = makeReleaseManifest(inspectImage(tag), tag);
  if (manifest.gitCommit !== commit) {
    throw new Error('Built image revision differs from the source commit');
  }
  await writeReleaseManifest(output, manifest);
  process.stdout.write('Traceable local image and release manifest created\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

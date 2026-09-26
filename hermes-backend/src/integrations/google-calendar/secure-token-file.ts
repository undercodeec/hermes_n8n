import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Runtime credential persistence for the explicitly invoked local bootstrap. */
export function saveGoogleToken(output: string, refreshToken: string): void {
  if (!refreshToken || /[\r\n\0]/.test(refreshToken))
    throw new Error('Invalid refresh token');
  const target = resolve(output),
    directory = dirname(target);
  const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const path = relative(repository, target);
  if (!path.startsWith('..') && !isAbsolute(path)) {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', target], {
        cwd: repository,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      throw new Error('Credential output must be ignored by Git');
    }
  }
  if (existsSync(target))
    throw new Error('Credential output already exists; choose a new path');
  // Never change permissions of an arbitrary existing parent directory.
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(target, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami', [], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      execFileSync(
        'icacls',
        [target, '/inheritance:r', '/grant:r', `${identity}:F`],
        { windowsHide: true, stdio: 'ignore' },
      );
    } else chmodSync(target, 0o600);
    writeFileSync(fd, `GOOGLE_REFRESH_TOKEN=${refreshToken}\n`, {
      encoding: 'utf8',
    });
  } finally {
    closeSync(fd);
  }
}

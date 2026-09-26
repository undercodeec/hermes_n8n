import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveGoogleToken } from './secure-token-file';

it('stores refresh token privately and refuses to overwrite it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-calendar-token-test-'));
  try {
    const target = join(directory, 'private', 'calendar.env');
    saveGoogleToken(target, 'test-refresh');
    expect(readFileSync(target, 'utf8')).toBe(
      'GOOGLE_REFRESH_TOKEN=test-refresh\n',
    );
    expect(() => saveGoogleToken(target, 'test-second')).toThrow();
    if (process.platform !== 'win32')
      expect(statSync(target).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

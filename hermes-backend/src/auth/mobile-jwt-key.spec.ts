import { JwtService } from '@nestjs/jwt';
import { mobileJwtKey } from './mobile-jwt-key';
import { webJwtKey } from './web-jwt-key';
import { JwtStrategy } from './strategies/jwt.strategy';

describe('mobile access JWT key separation and rollback', () => {
  const legacySecret = 'synthetic-legacy-jwt-secret-over-thirty-two-chars';
  const jwt = new JwtService();
  const db = { user: { findUnique: jest.fn() }, mobileSession: { findFirst: jest.fn() } };
  const config = { getOrThrow: () => legacySecret };
  const strategy = new JwtStrategy(config as never, db as never);
  const provider = (strategy as unknown as {
    _secretOrKeyProvider: (request: unknown, token: string, done: (error: Error | null, secret?: string) => void) => void;
  })._secretOrKeyProvider;
  const keyFor = (token: string): Promise<string> => new Promise((resolve, reject) => {
    provider(null, token, (error, key) => error ? reject(error) : resolve(key!));
  });

  it('keeps existing web JWTs valid but makes mobile JWTs unverifiable by the old backend key', async () => {
    const claims = { sub: 'synthetic-user', role: 'ADMIN' };
    const web = jwt.sign(claims, { secret: legacySecret, expiresIn: '7d' });
    const mobile = jwt.sign({ ...claims, typ: 'mobile', sid: 'synthetic-session' },
      { secret: mobileJwtKey(legacySecret), expiresIn: '5m' });
    expect(await keyFor(web)).toBe(legacySecret);
    expect(await keyFor(mobile)).toBe(mobileJwtKey(legacySecret));
    expect(jwt.verify(web, { secret: legacySecret })).toMatchObject(claims);
    expect(() => jwt.verify(mobile, { secret: legacySecret })).toThrow();
    expect(jwt.verify(mobile, { secret: await keyFor(mobile) })).toMatchObject({ typ: 'mobile' });
    const forgedHint = jwt.sign({ ...claims, typ: 'mobile' }, { secret: legacySecret });
    const selected = await keyFor(forgedHint);
    expect(() => jwt.verify(forgedHint, { secret: selected })).toThrow();
  });

  it('rejects malformed and oversized key-selection hints', async () => {
    await expect(keyFor('bad')).rejects.toThrow();
    await expect(keyFor('x'.repeat(8193))).rejects.toThrow();
  });

  it('separates short web session JWTs from legacy password JWTs and mobile JWTs', async () => {
    const claims = { sub: 'synthetic-user', role: 'ADMIN', sid: 'synthetic-session', typ: 'web' };
    const token = jwt.sign(claims, { secret: webJwtKey(legacySecret), expiresIn: '5m' });
    expect(await keyFor(token)).toBe(webJwtKey(legacySecret));
    expect(() => jwt.verify(token, { secret: legacySecret })).toThrow();
    expect(() => jwt.verify(token, { secret: mobileJwtKey(legacySecret) })).toThrow();
    const forged = jwt.sign(claims, { secret: legacySecret });
    const selected = await keyFor(forged);
    expect(() => jwt.verify(forged, { secret: selected })).toThrow();
  });
});

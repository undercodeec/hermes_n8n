/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- Deliberately asynchronous in-memory Prisma/Jest mock with untyped test payloads. */
import { createHmac } from 'crypto';
import { Prisma, UserRole } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

const secret = 'a-shared-secret-with-at-least-thirty-two-characters';
const email = 'gerencia@undercodeec.com';
const user = {
  id: 'operator-1',
  email,
  name: 'Gerencia Undercodeec',
  role: UserRole.ADMIN,
  isActive: true,
};
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
let sequence = 0;
function proof(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: 'undercodeec-admin',
      aud: 'hermes-crm',
      sub: email,
      role: 'ADMIN',
      jti: `proof-id-which-is-long-enough-${++sequence}`,
      iat: now,
      exp: now + 120,
      ...overrides,
    }),
  ).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

describe('CRM mobile sessions and shared proof replay', () => {
  const consumed = new Set<string>();
  let storedUser: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    isActive: boolean;
  } = { ...user };
  let session: {
    id: string;
    userId: string;
    refreshHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  };
  let webSession: typeof session;
  const upsert = jest.fn(async (args: { update: Record<string, unknown> }) => {
    Object.assign(storedUser, args.update);
    return { ...storedUser };
  });
  const txReference: { current?: unknown } = {};
  const db = {
    consumedCrmProof: {
      create: jest.fn(async ({ data }: { data: { jti: string } }) => {
        if (consumed.has(data.jti))
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: '5.22.0',
          });
        consumed.add(data.jti);
      }),
    },
    user: { upsert, findUnique: jest.fn(async () => storedUser) },
    $queryRaw: jest.fn(async () => [{ id: user.id }]),
    mobileSession: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: { userId: string; refreshHash: string; expiresAt: Date };
        }) => {
          session = { id: sessionId, ...data, revokedAt: null };
          return { ...session };
        },
      ),
      findUnique: jest.fn(async () =>
        session ? { ...session, user: { ...storedUser } } : null,
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { id: string; userId: string; expiresAt: { gt: Date } };
        }) =>
          session?.id === where.id &&
          session.userId === where.userId &&
          !session.revokedAt &&
          session.expiresAt > where.expiresAt.gt
            ? { ...session }
            : null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id: string;
            userId?: string;
            refreshHash?: string;
            expiresAt?: { gt: Date };
          };
          data: { refreshHash?: string; expiresAt?: Date; revokedAt?: Date };
        }) => {
          if (
            !session ||
            session.id !== where.id ||
            session.revokedAt ||
            (where.userId && where.userId !== session.userId) ||
            (where.refreshHash && where.refreshHash !== session.refreshHash) ||
            (where.expiresAt && session.expiresAt <= where.expiresAt.gt)
          )
            return { count: 0 };
          Object.assign(session, data);
          return { count: 1 };
        },
      ),
    },
    webSession: {
      create: jest.fn(async ({ data }: { data: { userId: string; refreshHash: string; expiresAt: Date } }) => {
        webSession = { id: sessionId, ...data, revokedAt: null };
        return { ...webSession };
      }),
      findUnique: jest.fn(async () => webSession ? { ...webSession, user: { ...storedUser } } : null),
      findFirst: jest.fn(async ({ where }: { where: { id: string; userId: string; expiresAt: { gt: Date } } }) =>
        webSession?.id === where.id && webSession.userId === where.userId && !webSession.revokedAt &&
        webSession.expiresAt > where.expiresAt.gt ? { ...webSession } : null),
      updateMany: jest.fn(async ({ where, data }: { where: { id?: string; userId?: string; refreshHash?: string; expiresAt?: { gt: Date } }; data: { refreshHash?: string; expiresAt?: Date; revokedAt?: Date } }) => {
        if (!webSession || webSession.revokedAt ||
            (where.id && webSession.id !== where.id) ||
            (where.userId && webSession.userId !== where.userId) ||
            (where.refreshHash && webSession.refreshHash !== where.refreshHash) ||
            (where.expiresAt && webSession.expiresAt <= where.expiresAt.gt)) return { count: 0 };
        Object.assign(webSession, data);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const previous = new Set(consumed);
        try {
          return await fn(txReference.current);
        } catch (error) {
          consumed.clear();
          previous.forEach((jti) => consumed.add(jti));
          throw error;
        }
      },
    ),
  };
  txReference.current = db;
  const jwt = { sign: jest.fn().mockReturnValue('short-jwt') };
  const config = {
    get: jest.fn(
      (key: string, fallback?: string) =>
        ({
          CRM_HERMES_PROOF_SECRET: secret,
          CRM_OPERATOR_EMAIL: email,
        })[key] ?? fallback,
    ),
    getOrThrow: jest.fn(() => secret),
  };
  const auth = new AuthService(db as never, jwt as never, config as never);

  beforeEach(() => {
    consumed.clear();
    storedUser = { ...user };
    session = undefined as never;
    webSession = undefined as never;
    jest.clearAllMocks();
  });

  it('shares durable jti between web and mobile without reactivating an operator', async () => {
    const webProof = proof();
    await auth.loginWithCrmProof(webProof);
    await expect(auth.loginMobileWithCrmProof(webProof)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const mobileProof = proof({ aud: 'hermes-crm-mobile' });
    await auth.loginMobileWithCrmProof(mobileProof);
    await expect(auth.loginWithCrmProof(mobileProof)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(consumed.size).toBe(2);
  });

  it('does not reactivate a disabled web user or promote a demoted operator', async () => {
    storedUser.isActive = false;
    await expect(auth.loginWithCrmProof(proof())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    storedUser.isActive = true;
    storedUser.role = UserRole.SALES_AGENT;
    await expect(auth.loginWithCrmProof(proof())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(storedUser.role).toBe(UserRole.SALES_AGENT);
    expect(consumed.size).toBe(0);
  });

  it('rejects disabled mobile user without consuming proof or activating user', async () => {
    storedUser.isActive = false;
    const signed = proof({ aud: 'hermes-crm-mobile' });
    await expect(auth.loginMobileWithCrmProof(signed)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(storedUser.isActive).toBe(false);
    expect(consumed.size).toBe(0);
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it('revokes other phone sessions before issuing a new one', async () => {
    await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.mobileSession.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('rejects a mobile proof that expires while waiting for the operator lock', async () => {
    const waitingProof = proof({
      aud: 'hermes-crm-mobile',
      exp: Math.floor(Date.now() / 1000) + 1,
    });
    db.$queryRaw.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return [{ id: user.id }];
    });
    await expect(
      auth.loginMobileWithCrmProof(waitingProof),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.mobileSession.create).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures and expired proofs before persistence', async () => {
    await expect(
      auth.loginMobileWithCrmProof(`${proof({ aud: 'hermes-crm-mobile' })}x`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile', exp: 1 })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.consumedCrmProof.create).not.toHaveBeenCalled();
  });

  it('only one concurrent web/mobile exchange can consume a signed proof', async () => {
    const jti = `same-id-across-audiences-${++sequence}`;
    const results = await Promise.allSettled([
      auth.loginWithCrmProof(proof({ jti })),
      auth.loginMobileWithCrmProof(proof({ jti, aud: 'hermes-crm-mobile' })),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
  });

  it('requires separate web and mobile proof audiences', async () => {
    await expect(auth.loginMobileWithCrmProof(proof())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      auth.loginWithCrmProof(proof({ aud: 'hermes-crm-mobile' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.consumedCrmProof.create).not.toHaveBeenCalled();
  });

  it('rotates refresh via CAS, rejects replay and does not extend idle window', async () => {
    const initial = await auth.loginMobileWithCrmProof(
      proof({ aud: 'hermes-crm-mobile' }),
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sid: sessionId, typ: 'mobile' }),
      expect.objectContaining({ expiresIn: '5m', secret: expect.any(String) }),
    );
    const expiresAt = session.expiresAt.getTime();
    const attempts = await Promise.allSettled([
      auth.refreshMobile(initial.refreshToken),
      auth.refreshMobile(initial.refreshToken),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    expect(session.expiresAt.getTime()).toBe(expiresAt);
    await expect(
      auth.refreshMobile(initial.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect((await auth.checkMobile(user.id, sessionId)).active).toBe(true);
    await auth.mobileActivity(user.id, sessionId);
    expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(expiresAt);
    await auth.logoutMobile(user.id, sessionId);
    await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokes with the current refresh without rotating an expired access JWT', async () => {
    const initial = await auth.loginMobileWithCrmProof(
      proof({ aud: 'hermes-crm-mobile' }),
    );
    jwt.sign.mockClear();
    await expect(
      auth.logoutMobileWithRefresh(initial.refreshToken),
    ).resolves.toEqual({ revoked: true });
    expect(jwt.sign).not.toHaveBeenCalled();
    await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      auth.logoutMobileWithRefresh(initial.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not allow a consumed refresh to revoke the winning rotation', async () => {
    const initial = await auth.loginMobileWithCrmProof(
      proof({ aud: 'hermes-crm-mobile' }),
    );
    const rotated = await auth.refreshMobile(initial.refreshToken);
    await expect(
      auth.logoutMobileWithRefresh(initial.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.checkMobile(user.id, sessionId)).resolves.toMatchObject({
      active: true,
    });
    await expect(
      auth.logoutMobileWithRefresh(rotated.refreshToken),
    ).resolves.toEqual({ revoked: true });
  });

  it('rejects a demoted or mismatched operator for an existing mobile access JWT', async () => {
    const strategy = new JwtStrategy(config as never, db as never);
    await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
    storedUser.role = UserRole.SALES_AGENT;
    await expect(
      strategy.validate({
        sub: user.id,
        email,
        role: 'ADMIN',
        sid: sessionId,
        typ: 'mobile',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    storedUser.role = UserRole.ADMIN;
    storedUser.email = 'other@example.invalid';
    await expect(
      strategy.validate({
        sub: user.id,
        email,
        role: 'ADMIN',
        sid: sessionId,
        typ: 'mobile',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects expired session on refresh, activity, check and JWT validation', async () => {
    const initial = await auth.loginMobileWithCrmProof(
      proof({ aud: 'hermes-crm-mobile' }),
    );
    session.expiresAt = new Date(Date.now() - 1);
    await expect(
      auth.refreshMobile(initial.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      auth.mobileActivity(user.id, sessionId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const strategy = new JwtStrategy(config as never, db as never);
    await expect(
      strategy.validate({
        sub: user.id,
        email,
        role: 'ADMIN',
        sid: sessionId,
        typ: 'mobile',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Pre-rollout CRM operator JWTs cannot bypass the durable web policy.
    await expect(
      strategy.validate({ sub: user.id, email, role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('expires after exactly 24 hours without human activity, including while refresh, checks and validation run', async () => {
    const start = Date.parse('2026-11-18T12:00:00.000Z');
    jest.useFakeTimers({ now: start });
    try {
      const initial = await auth.loginMobileWithCrmProof(
        proof({ aud: 'hermes-crm-mobile' }),
      );
      const expiry = start + 24 * 60 * 60 * 1000;
      expect(session.expiresAt.getTime()).toBe(expiry);
      jest.setSystemTime(start + 30 * 60 * 1000);
      const rotated = await auth.refreshMobile(initial.refreshToken);
      expect(rotated.expiresAt.getTime()).toBe(expiry);
      expect(await auth.checkMobile(user.id, sessionId)).toEqual({
        active: true,
        expiresAt: session.expiresAt,
        idleRemainingMs: expiry - Date.now(),
      });
      const strategy = new JwtStrategy(config as never, db as never);
      await expect(
        strategy.validate({
          sub: user.id,
          email,
          role: 'ADMIN',
          sid: sessionId,
          typ: 'mobile',
        }),
      ).resolves.toMatchObject({ sessionId });
      jest.setSystemTime(expiry - 1);
      const lastRefresh = await auth.refreshMobile(rotated.refreshToken);
      expect(lastRefresh.expiresAt.getTime()).toBe(expiry);
      expect(await auth.checkMobile(user.id, sessionId)).toEqual({
        active: true,
        expiresAt: session.expiresAt,
        idleRemainingMs: 1,
      });
      jest.setSystemTime(expiry);
      await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        auth.refreshMobile(lastRefresh.refreshToken),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        strategy.validate({
          sub: user.id,
          email,
          role: 'ADMIN',
          sid: sessionId,
          typ: 'mobile',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        auth.mobileActivity(user.id, sessionId),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // An old untyped CRM operator JWT is rejected independently of mobile expiry.
      await expect(
        strategy.validate({ sub: user.id, email, role: 'ADMIN' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      jest.useRealTimers();
    }
  });

  it('extends the mobile deadline only for explicit interaction, with no absolute maximum', async () => {
    const start = Date.parse('2026-11-18T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    jest.useFakeTimers({ now: start });
    try {
      const initial = await auth.loginMobileWithCrmProof(
        proof({ aud: 'hermes-crm-mobile' }),
      );
      for (let dayNumber = 1; dayNumber <= 7; dayNumber++) {
        const interaction = start + dayNumber * (day - 1_000);
        jest.setSystemTime(interaction);
        const result = await auth.mobileActivity(user.id, sessionId);
        expect(result.expiresAt.getTime()).toBe(interaction + day);
        expect(session.expiresAt.getTime()).toBe(interaction + day);
      }
      jest.setSystemTime(session.expiresAt.getTime() - 1);
      await expect(
        auth.refreshMobile(initial.refreshToken),
      ).resolves.toMatchObject({ expiresAt: session.expiresAt });
      jest.setSystemTime(session.expiresAt.getTime());
      await expect(
        auth.mobileActivity(user.id, sessionId),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not return a positive TTL when the session expires during the DB read', async () => {
    const start = Date.parse('2026-11-18T12:00:00.000Z');
    jest.useFakeTimers({ now: start });
    try {
      await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
      db.mobileSession.findFirst.mockImplementationOnce(async () => {
        jest.setSystemTime(session.expiresAt);
        return { ...session };
      });
      await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('revokes lost phone sessions only for the configured web operator', async () => {
    await expect(
      auth.revokeAllMobileForOperator(user.id, 'other@example.invalid'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.mobileSession.updateMany).not.toHaveBeenCalled();
    await auth.revokeAllMobileForOperator(user.id, email);
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.mobileSession.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('web OTP exchanges for a revocable short JWT and rotates refresh exactly once without activity', async () => {
    const initial = await auth.loginWithCrmProof(proof());
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ typ: 'web', sid: sessionId }),
      expect.objectContaining({ expiresIn: '5m', secret: expect.any(String) }),
    );
    expect(initial.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const expiry = webSession.expiresAt.getTime();
    const results = await Promise.allSettled([
      auth.refreshWeb(initial.refreshToken), auth.refreshWeb(initial.refreshToken),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(webSession.expiresAt.getTime()).toBe(expiry);
    await expect(auth.logoutWebWithRefresh(initial.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.logoutWebWithRefresh((results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken))
      .resolves.toEqual({ revoked: true });
    await expect(auth.checkWeb(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reexchanges fresh admin proof into the same web session, without extending idle or duplicating records', async () => {
    const initial = await auth.loginWithCrmProof(proof());
    const expiry = webSession.expiresAt.getTime();
    const renewed = await auth.loginWithCrmProof(proof(), initial.refreshToken);
    expect(renewed.refreshToken).not.toBe(initial.refreshToken);
    expect(renewed.expiresAt.getTime()).toBe(expiry);
    expect(db.webSession.create).toHaveBeenCalledTimes(1);
    await expect(auth.loginWithCrmProof(proof(), initial.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.webSession.create).toHaveBeenCalledTimes(1);
    await expect(auth.refreshWeb(renewed.refreshToken)).resolves.toMatchObject({ expiresAt: webSession.expiresAt });
  });

  it('cannot use an admin reexchange to revive an expired or revoked web session', async () => {
    const initial = await auth.loginWithCrmProof(proof());
    webSession.expiresAt = new Date(Date.now());
    await expect(auth.loginWithCrmProof(proof(), initial.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.webSession.create).toHaveBeenCalledTimes(1);
  });

  it('web inactivity expires exactly at 24h, independent of GET, refresh and JWT validation', async () => {
    const start = Date.parse('2026-11-18T12:00:00.000Z');
    const day = 86_400_000;
    jest.useFakeTimers({ now: start });
    try {
      const initial = await auth.loginWithCrmProof(proof());
      const strategy = new JwtStrategy(config as never, db as never);
      jest.setSystemTime(start + day - 1);
      const rotated = await auth.refreshWeb(initial.refreshToken);
      expect(rotated.expiresAt.getTime()).toBe(start + day);
      expect((await auth.checkWeb(user.id, sessionId)).idleRemainingMs).toBe(1);
      await expect(strategy.validate({ sub: user.id, email, role: 'ADMIN', typ: 'web', sid: sessionId, exp: Math.floor(Date.now() / 1000) + 300 }))
        .resolves.toMatchObject({ sessionType: 'web' });
      jest.setSystemTime(start + day);
      await expect(auth.checkWeb(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.refreshWeb(rotated.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.webActivity(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(strategy.validate({ sub: user.id, email, role: 'ADMIN', typ: 'web', sid: sessionId, exp: Math.floor(Date.now() / 1000) + 300 }))
        .rejects.toBeInstanceOf(UnauthorizedException);
    } finally { jest.useRealTimers(); }
  });

  it('web activity alone extends idle without any absolute cap, and revocation stops it', async () => {
    const start = Date.parse('2026-11-18T12:00:00.000Z');
    const day = 86_400_000;
    jest.useFakeTimers({ now: start });
    try {
      await auth.loginWithCrmProof(proof());
      for (let index = 1; index <= 7; index++) {
        jest.setSystemTime(start + index * (day - 1000));
        await auth.webActivity(user.id, sessionId);
        expect(webSession.expiresAt.getTime()).toBe(Date.now() + day);
      }
      await expect(auth.revokeAllWebForOperator(user.id, 'other@example.invalid')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.revokeAllWebForOperator(user.id, email)).resolves.toEqual({ revokedSessions: 1 });
      await expect(auth.webActivity(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally { jest.useRealTimers(); }
  });

  it('rejects legacy CRM operator JWT and password entry while leaving unrelated users unchanged', async () => {
    const strategy = new JwtStrategy(config as never, db as never);
    await expect(strategy.validate({ sub: user.id, email, role: 'ADMIN' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.login({ email, password: 'synthetic-password' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.register({ email, password: 'synthetic-password', name: 'Operator' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    storedUser = { ...storedUser, email: 'different-admin@example.invalid' };
    await expect(strategy.validate({ sub: user.id, email: 'different-admin@example.invalid', role: 'ADMIN' }))
      .resolves.toMatchObject({ id: user.id });
  });
});

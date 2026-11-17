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
  let storedUser = { ...user };
  let session: {
    id: string;
    userId: string;
    refreshHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  };
  const upsert = jest.fn(async (args: { update: Record<string, unknown> }) => {
    Object.assign(storedUser, args.update);
    return { ...storedUser };
  });
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
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const previous = new Set(consumed);
      try {
        return await fn(db);
      } catch (error) {
        consumed.clear();
        previous.forEach((jti) => consumed.add(jti));
        throw error;
      }
    }),
  };
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
    await expect(auth.loginWithCrmProof(proof())).rejects.toBeInstanceOf(UnauthorizedException);
    storedUser.isActive = true;
    storedUser.role = UserRole.SALES_AGENT;
    await expect(auth.loginWithCrmProof(proof())).rejects.toBeInstanceOf(UnauthorizedException);
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
    const waitingProof = proof({ aud: 'hermes-crm-mobile', exp: Math.floor(Date.now() / 1000) + 1 });
    db.$queryRaw.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return [{ id: user.id }];
    });
    await expect(auth.loginMobileWithCrmProof(waitingProof)).rejects.toBeInstanceOf(UnauthorizedException);
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
    await expect(auth.loginMobileWithCrmProof(proof())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.loginWithCrmProof(proof({ aud: 'hermes-crm-mobile' }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.consumedCrmProof.create).not.toHaveBeenCalled();
  });

  it('rotates refresh via CAS, rejects replay and does not extend idle window', async () => {
    const initial = await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sid: sessionId, typ: 'mobile' }),
      { expiresIn: '5m' },
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

  it('rejects expired session on refresh, activity, check and JWT validation', async () => {
    const initial = await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
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
    // Existing web JWTs are still independent of mobile session lifetime.
    await expect(
      strategy.validate({ sub: user.id, email, role: 'ADMIN' }),
    ).resolves.toMatchObject({ id: user.id });
  });

  it('allows 29 minutes idle but rejects at the exact 30-minute server deadline', async () => {
    const initial = await auth.loginMobileWithCrmProof(proof({ aud: 'hermes-crm-mobile' }));
    const expiry = session.expiresAt.getTime();
    jest.useFakeTimers({ now: expiry - 60_000 });
    try {
      await expect(auth.checkMobile(user.id, sessionId)).resolves.toMatchObject({ active: true });
      jest.setSystemTime(expiry);
      await expect(auth.checkMobile(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.refreshMobile(initial.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.mobileActivity(user.id, sessionId)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally { jest.useRealTimers(); }
  });

  it('revokes lost phone sessions only for the configured web operator', async () => {
    await expect(auth.revokeAllMobileForOperator(user.id, 'other@example.invalid')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.mobileSession.updateMany).not.toHaveBeenCalled();
    await auth.revokeAllMobileForOperator(user.id, email);
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.mobileSession.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

import { createHmac, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';

// Opt in ONLY to a disposable local test database with migrations already applied.
const url = process.env.HERMES_G2_TEST_DATABASE_URL;
const local =
  url &&
  /^postgres(?:ql)?:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1):\d+\/hermes_g2(?:\?|$)/.test(
    url,
  );
const run = local ? describe : describe.skip;
const secret = 'hermes-g2-local-test-secret-minimum-32-characters';

run('mobile G2 against disposable PostgreSQL', () => {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: url || 'postgresql://test:test@127.0.0.1:1/hermes_g2' },
    },
  });
  const email = `g2-${randomUUID()}@example.test`;
  const config = {
    get: (key: string) =>
      (
        ({
          CRM_HERMES_PROOF_SECRET: secret,
          CRM_OPERATOR_EMAIL: email,
        }) as Record<string, string>
      )[key],
    getOrThrow: () => secret,
  };
  const jwt = {
    sign: (_payload: unknown) => 'local-signed-token-not-used-over-http',
  };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
  );
  const strategy = new JwtStrategy(config as never, prisma as never);
  const jtis: string[] = [];

  function proof(audience: 'hermes-crm' | 'hermes-crm-mobile' = 'hermes-crm', jti = randomUUID()) {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    if (!jtis.includes(jti)) jtis.push(jti);
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      JSON.stringify({
        iss: 'undercodeec-admin',
        aud: audience,
        sub: email,
        role: 'ADMIN',
        jti,
        iat: now,
        exp: now + 120,
      }),
    ).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
  }

  afterAll(async () => {
    await prisma.mobileSession.deleteMany({ where: { user: { email } } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.consumedCrmProof.deleteMany({ where: { jti: { in: jtis } } });
    await prisma.$disconnect();
  });

  it('one winner across web/mobile; disabled operator stays disabled on both', async () => {
    const sharedJti = randomUUID();
    const results = await Promise.allSettled([
      service.loginWithCrmProof(proof('hermes-crm', sharedJti)),
      service.loginMobileWithCrmProof(proof('hermes-crm-mobile', sharedJti)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await prisma.consumedCrmProof.count({ where: { jti: jtis[0] } }),
    ).toBe(1);

    await prisma.user.update({ where: { email }, data: { isActive: false } });
    const inactiveJti = randomUUID();
    await expect(
      service.loginMobileWithCrmProof(proof('hermes-crm-mobile', inactiveJti)),
    ).rejects.toThrow();
    expect(
      await prisma.consumedCrmProof.count({ where: { jti: jtis[1] } }),
    ).toBe(0);
    await expect(service.loginWithCrmProof(proof('hermes-crm', inactiveJti))).rejects.toThrow();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email } })).isActive,
    ).toBe(false);
    await prisma.user.update({ where: { email }, data: { isActive: true } });
  });

  it('refresh CAS allows exactly one winner; idle expiry and logout revoke JWT', async () => {
    const login = await service.loginMobileWithCrmProof(proof('hermes-crm-mobile'));
    const session = await prisma.mobileSession.findFirstOrThrow({
      where: { user: { email }, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const expiry = session.expiresAt.getTime();
    const refreshed = await Promise.allSettled([
      service.refreshMobile(login.refreshToken),
      service.refreshMobile(login.refreshToken),
    ]);
    expect(
      refreshed.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      refreshed.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        await prisma.mobileSession.findUniqueOrThrow({
          where: { id: session.id },
        })
      ).expiresAt.getTime(),
    ).toBe(expiry);

    const claims = {
      sub: session.userId,
      email,
      role: 'ADMIN',
      sid: session.id,
      typ: 'mobile',
    };
    await expect(strategy.validate(claims)).resolves.toMatchObject({
      sessionId: session.id,
    });
    await service.logoutMobile(session.userId, session.id);
    await expect(strategy.validate(claims)).rejects.toThrow();

    const second = await service.loginMobileWithCrmProof(proof('hermes-crm-mobile'));
    const expiring = await prisma.mobileSession.findUniqueOrThrow({
      where: { id: second.refreshToken.split('.')[0] },
    });
    await prisma.mobileSession.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(service.refreshMobile(second.refreshToken)).rejects.toThrow();
    await expect(
      service.mobileActivity(expiring.userId, expiring.id),
    ).rejects.toThrow();
    await expect(
      service.checkMobile(expiring.userId, expiring.id),
    ).rejects.toThrow();
  });

  it('web operator can revoke all phone sessions without revoking web access', async () => {
    const mobile = await service.loginMobileWithCrmProof(proof('hermes-crm-mobile'));
    const account = await prisma.user.findUniqueOrThrow({ where: { email } });
    const revoked = await service.revokeAllMobileForOperator(account.id, email);
    expect(revoked.revokedSessions).toBeGreaterThanOrEqual(1);
    await expect(service.refreshMobile(mobile.refreshToken)).rejects.toThrow();
    await expect(service.loginWithCrmProof(proof('hermes-crm'))).resolves.toHaveProperty('accessToken');
  });

  it('only one phone stays active after sequential and concurrent logins', async () => {
    const first = await service.loginMobileWithCrmProof(proof('hermes-crm-mobile'));
    const second = await service.loginMobileWithCrmProof(proof('hermes-crm-mobile'));
    await expect(service.refreshMobile(first.refreshToken)).rejects.toThrow();
    expect((await prisma.mobileSession.count({ where: { user: { email }, revokedAt: null } }))).toBe(1);
    const concurrent = await Promise.allSettled([
      service.loginMobileWithCrmProof(proof('hermes-crm-mobile')),
      service.loginMobileWithCrmProof(proof('hermes-crm-mobile')),
    ]);
    expect(concurrent.some((result) => result.status === 'fulfilled')).toBe(true);
    expect((await prisma.mobileSession.count({ where: { user: { email }, revokedAt: null } }))).toBe(1);
    await expect(service.refreshMobile(second.refreshToken)).rejects.toThrow();
  });

  it('serializes web revocation with a simultaneous new mobile login', async () => {
    const account = await prisma.user.findUniqueOrThrow({ where: { email } });
    const attempts = await Promise.allSettled([
      service.loginMobileWithCrmProof(proof('hermes-crm-mobile')),
      service.revokeAllMobileForOperator(account.id, email),
    ]);
    expect(attempts.every((result) => result.status === 'fulfilled')).toBe(true);
    expect((await prisma.mobileSession.count({ where: { user: { email }, revokedAt: null } }))).toBeLessThanOrEqual(1);
  });
});

import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { mobileJwtKey } from '../src/auth/mobile-jwt-key';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { PrismaService } from '../src/prisma/prisma.service';

// No database, SMTP, network services or production configuration: only localhost HTTP.
const jwtSecret = 'synthetic-web-jwt-key-at-least-thirty-two-characters';
const proofSecret = 'synthetic-proof-hmac-key-at-least-thirty-two-characters';
const operator = 'operator@example.test';
const operatorId = 'operator-synthetic';
type Account = { id: string; email: string; name: string; role: UserRole; isActive: boolean };
type Session = { id: string; userId: string; refreshHash: string; expiresAt: Date; revokedAt: Date | null };

function memoryPrisma() {
  const users = new Map<string, Account>();
  const sessions = new Map<string, Session>();
  const consumed = new Set<string>();
  users.set(operatorId, { id: operatorId, email: operator, name: 'Synthetic operator', role: UserRole.ADMIN, isActive: true });
  const matches = (session: Session, where: {
    id?: string; userId?: string; refreshHash?: string; revokedAt?: null;
    expiresAt?: { gt: Date };
  }) =>
    (!where.id || session.id === where.id) &&
    (!where.userId || session.userId === where.userId) &&
    (!where.refreshHash || session.refreshHash === where.refreshHash) &&
    (where.revokedAt === undefined || session.revokedAt === null) &&
    (!where.expiresAt || session.expiresAt > where.expiresAt.gt);
  const db = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        [...users.values()].find((item) => item.id === where.id || item.email === where.email) ?? null),
      upsert: jest.fn(async ({ where, create }: { where: { email: string }; create: Account }) => {
        let found = [...users.values()].find((item) => item.email === where.email);
        if (!found) {
          found = { ...create, id: randomUUID(), isActive: true };
          users.set(found.id, found);
        }
        return { ...found };
      }),
    },
    consumedCrmProof: {
      create: jest.fn(async ({ data }: { data: { jti: string } }) => {
        if (consumed.has(data.jti)) throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' });
        consumed.add(data.jti);
      }),
    },
    mobileSession: {
      create: jest.fn(async ({ data }: { data: Pick<Session, 'userId' | 'refreshHash' | 'expiresAt'> }) => {
        const session = { ...data, id: randomUUID(), revokedAt: null };
        sessions.set(session.id, session);
        return { ...session };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const session = sessions.get(where.id);
        return session ? { ...session, user: { ...users.get(session.userId)! } } : null;
      }),
      findFirst: jest.fn(async ({ where }: { where: Parameters<typeof matches>[1] }) => {
        const session = [...sessions.values()].find((item) => matches(item, where));
        return session ? { ...session } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Parameters<typeof matches>[1]; data: Partial<Session> }) => {
        let count = 0;
        for (const session of sessions.values()) {
          if (matches(session, where)) { Object.assign(session, data); count++; }
        }
        return { count };
      }),
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (action: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const before = new Set(consumed);
      try { return await action(db); }
      catch (error) { consumed.clear(); for (const jti of before) consumed.add(jti); throw error; }
    }),
  };
  return { db, users, sessions, consumed };
}

describe('G2 mobile/web auth HTTP contract (synthetic, in-memory Prisma)', () => {
  let app: INestApplication;
  let state: ReturnType<typeof memoryPrisma>;
  let sequence = 0;
  const http = () => request(app.getHttpServer() as App);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const proof = (aud: 'hermes-crm' | 'hermes-crm-mobile', overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'undercodeec-admin', aud, sub: operator, role: 'ADMIN', jti: `synthetic-http-proof-${++sequence}`, iat: now, exp: now + 120, ...overrides })).toString('base64url');
    return `${header}.${body}.${createHmac('sha256', proofSecret).update(`${header}.${body}`).digest('base64url')}`;
  };
  const mobileLogin = async () => {
    const response = await http().post('/api/auth/mobile/crm-proof').send({ proof: proof('hermes-crm-mobile') }).expect(200);
    expect(response.body).toEqual(expect.objectContaining({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresAt: expect.any(String) }));
    return response.body as { accessToken: string; refreshToken: string; expiresAt: string };
  };
  const webLogin = async () => {
    const response = await http().post('/api/auth/crm-proof').send({ proof: proof('hermes-crm') }).expect(200);
    return response.body.accessToken as string;
  };

  beforeEach(async () => {
    state = memoryPrisma();
    const config = {
      get: (key: string, fallback?: string) => ({ JWT_SECRET: jwtSecret, CRM_HERMES_PROOF_SECRET: proofSecret, CRM_OPERATOR_EMAIL: operator })[key] ?? fallback,
      getOrThrow: (key: string) => ({ JWT_SECRET: jwtSecret })[key],
    };
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({ secret: jwtSecret, signOptions: { expiresIn: '7d' } })],
      controllers: [AuthController],
      providers: [AuthService, JwtStrategy, { provide: ConfigService, useValue: config }, { provide: PrismaService, useValue: state.db }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app.close(); });

  it('separates signed proof audiences, rejects invalid and replayed proofs before creating sessions', async () => {
    const web = proof('hermes-crm');
    const mobile = proof('hermes-crm-mobile');
    await http().post('/api/auth/mobile/crm-proof').send({ proof: web }).expect(401);
    await http().post('/api/auth/crm-proof').send({ proof: mobile }).expect(401);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: `${mobile}x` }).expect(401);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: proof('hermes-crm-mobile', { exp: 1 }) }).expect(401);
    expect(state.consumed.size).toBe(0);
    expect(state.sessions.size).toBe(0);
    await http().post('/api/auth/crm-proof').send({ proof: web }).expect(200);
    await http().post('/api/auth/crm-proof').send({ proof: web }).expect(401);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: mobile }).expect(200);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: mobile }).expect(401);
    expect(state.consumed.size).toBe(2);
    const shared = "'shared-cross-audience-jti-123456789'";
    await http().post('/api/auth/crm-proof').send({ proof: proof('hermes-crm', { jti: shared }) }).expect(200);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: proof('hermes-crm-mobile', { jti: shared }) }).expect(401);
    expect(state.consumed.size).toBe(3);
  });

  it('enforces real JWT/role guards on web and mobile routes (200, 401, 403)', async () => {
    const web = await webLogin();
    const mobile = await mobileLogin();
    await http().get('/api/auth/profile').set(bearer(web)).expect(200);
    const check = await http().get('/api/auth/mobile/session').set(bearer(mobile.accessToken)).expect(200);
    const checkBody = check.body as { active: boolean; expiresAt: string; idleRemainingMs: number };
    expect(typeof checkBody.idleRemainingMs).toBe('number');
    expect(checkBody).toEqual({ active: true, expiresAt: mobile.expiresAt, idleRemainingMs: checkBody.idleRemainingMs });
    expect(checkBody.idleRemainingMs).toBeGreaterThan(0);
    expect(checkBody.idleRemainingMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    await http().get('/api/auth/mobile/session').expect(401);
    await http().get('/api/auth/mobile/session').set(bearer(web)).expect(401);
    await http().get('/api/auth/profile').set(bearer(mobile.accessToken)).expect(403);
    await http().post('/api/auth/register').set(bearer(mobile.accessToken)).send({}).expect(403);
    await http().post('/api/auth/mobile/revoke-all').set(bearer(mobile.accessToken)).expect(403);
    await http().post('/api/auth/mobile/revoke-all').expect(401);
    await http().post('/api/auth/mobile/revoke-all').set(bearer('invalid')).expect(401);
    state.users.get(operatorId)!.role = UserRole.SALES_AGENT;
    await http().post('/api/auth/mobile/revoke-all').set(bearer(web)).expect(403);
  });

  it('rotates refresh without extending idle time; replay cannot log out winning rotation', async () => {
    const mobile = await mobileLogin();
    const session = state.sessions.get(mobile.refreshToken.split('.')[0])!;
    const initialExpiry = session.expiresAt.getTime();
    const rotatedResponse = await http().post('/api/auth/mobile/refresh').send({ refreshToken: mobile.refreshToken }).expect(200);
    const rotated = rotatedResponse.body as { refreshToken: string; accessToken: string; expiresAt: string };
    expect(rotated.refreshToken).not.toBe(mobile.refreshToken);
    expect(Date.parse(rotated.expiresAt)).toBe(initialExpiry);
    await http().post('/api/auth/mobile/refresh').send({ refreshToken: mobile.refreshToken }).expect(401);
    await http().post('/api/auth/mobile/logout-refresh').send({ refreshToken: mobile.refreshToken }).expect(401);
    await http().get('/api/auth/mobile/session').set(bearer(rotated.accessToken)).expect(200);
    await http().post('/api/auth/mobile/activity').set(bearer(rotated.accessToken)).expect(200);
    expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(initialExpiry);
    await http().post('/api/auth/mobile/logout').set(bearer(rotated.accessToken)).expect(200);
    await http().get('/api/auth/mobile/session').set(bearer(rotated.accessToken)).expect(401);
    await http().post('/api/auth/mobile/refresh').send({ refreshToken: rotated.refreshToken }).expect(401);
  });

  it('logout-refresh works without access JWT and does not rotate; expired refresh returns 401', async () => {
    const mobile = await mobileLogin();
    const session = state.sessions.get(mobile.refreshToken.split('.')[0])!;
    const expiredAccess = app.get(JwtService).sign({ sub: operatorId, email: operator, role: UserRole.ADMIN, sid: session.id, typ: 'mobile' }, { secret: mobileJwtKey(jwtSecret), expiresIn: -1 });
    await http().get('/api/auth/mobile/session').set(bearer(expiredAccess)).expect(401);
    const response = await http().post('/api/auth/mobile/logout-refresh').send({ refreshToken: mobile.refreshToken }).expect(200);
    expect(response.body).toEqual({ revoked: true });
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(state.db.mobileSession.create).toHaveBeenCalledTimes(1);
    await http().post('/api/auth/mobile/logout-refresh').send({ refreshToken: mobile.refreshToken }).expect(401);
    await http().get('/api/auth/mobile/session').set(bearer(mobile.accessToken)).expect(401);
    const second = await mobileLogin();
    state.sessions.get(second.refreshToken.split('.')[0])!.expiresAt = new Date(Date.now() - 1);
    await http().post('/api/auth/mobile/logout-refresh').send({ refreshToken: second.refreshToken }).expect(401);
    await http().post('/api/auth/mobile/refresh').send({ refreshToken: second.refreshToken }).expect(401);
    await http().get('/api/auth/mobile/session').set(bearer(second.accessToken)).expect(401);
  });

  it('web revoke-all terminates mobile only, leaving existing web JWT usable', async () => {
    const web = await webLogin();
    const mobile = await mobileLogin();
    const response = await http().post('/api/auth/mobile/revoke-all').set(bearer(web)).expect(200);
    expect(response.body).toEqual({ revokedSessions: 1 });
    await http().get('/api/auth/mobile/session').set(bearer(mobile.accessToken)).expect(401);
    await http().post('/api/auth/mobile/refresh').send({ refreshToken: mobile.refreshToken }).expect(401);
    await http().get('/api/auth/profile').set(bearer(web)).expect(200);
    await http().post('/api/auth/mobile/revoke-all').set(bearer(web)).expect(200, { revokedSessions: 0 });
  });

  it('rejects mismatched operator and inactive accounts without revoking their web tokens', async () => {
    const web = await webLogin();
    const mobile = await mobileLogin();
    state.users.get(operatorId)!.email = 'different@example.test';
    await http().post('/api/auth/mobile/revoke-all').set(bearer(web)).expect(401);
    await http().get('/api/auth/mobile/session').set(bearer(mobile.accessToken)).expect(401);
    state.users.get(operatorId)!.email = operator;
    state.users.get(operatorId)!.isActive = false;
    await http().get('/api/auth/profile').set(bearer(web)).expect(401);
    await http().post('/api/auth/mobile/crm-proof').send({ proof: proof('hermes-crm-mobile') }).expect(401);
  });
});

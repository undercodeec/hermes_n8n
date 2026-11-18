/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Optional local cross-repository HTTP integration loads an independently checked-out Express API. */
// Opt-in only: migrate fresh, disposable loopback databases (hermes_g4_cross_test_<32 hex>
// and crm_g4_cross_test_<32 hex>), run Mailpit bound to 127.0.0.1, then set the five
// HERMES_G4_CROSS_* variables below. Never use shared databases, a real SMTP relay,
// the production OTP API, or Meta. The provider path points at a local UnderCodeEC
// backend checkout containing the test-only router-factory operator override.
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { MobileInboxController } from '../src/mobile-inbox/mobile-inbox.controller';
import { MobileInboxGuard } from '../src/mobile-inbox/mobile-inbox.guard';
import { MobileInboxService } from '../src/mobile-inbox/mobile-inbox.service';
import { PrismaService } from '../src/prisma/prisma.service';

const pgUrl = process.env.HERMES_G4_CROSS_POSTGRES_URL;
const mysqlUrl = process.env.HERMES_G4_CROSS_MYSQL_URL;
const mailpitBase = process.env.HERMES_G4_CROSS_MAILPIT_HTTP;
const smtpPort = process.env.HERMES_G4_CROSS_MAILPIT_SMTP_PORT;
const providerPath = process.env.HERMES_G4_CROSS_PROVIDER_BACKEND;
const run = [pgUrl, mysqlUrl, mailpitBase, smtpPort, providerPath].some(Boolean)
  ? describe
  : describe.skip;

function localDatabase(
  value: string | undefined,
  prefix: string,
  protocol: string,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === `${protocol}:` &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      /^\d+$/.test(url.port) &&
      Boolean(url.username && url.password) &&
      new RegExp(`^/${prefix}[a-f0-9]{32}$`).test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
async function post(url: string, body: object, bearer?: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    code: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

run('isolated HTTP OTP + SMTP capture + Hermes mobile/web contract', () => {
  let prisma: PrismaClient;
  let mysql: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<[Array<Record<string, unknown>>, unknown]>;
    end: () => Promise<void>;
  };
  let provider: Server;
  let hermes: INestApplication;
  let providerBase: string;
  let hermesBase: string;
  const email = 'isolated-operator@example.test';
  const proofSecret = randomBytes(48).toString('hex');
  const jwtSecret = randomBytes(48).toString('hex');
  const hashSecret = randomBytes(48).toString('hex');

  beforeAll(async () => {
    // Refuse to connect, including for reads, until BOTH database destinations are verified.
    if (
      !localDatabase(pgUrl, 'hermes_g4_cross_test_', 'postgresql') ||
      !localDatabase(mysqlUrl, 'crm_g4_cross_test_', 'mysql') ||
      !mailpitBase ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(mailpitBase) ||
      !smtpPort ||
      !/^\d+$/.test(smtpPort) ||
      !providerPath
    )
      throw new Error('Local disposable integration prerequisites required');
    const requireProvider = createRequire(join(providerPath, 'package.json'));
    const express = requireProvider('express');
    const mysqlDriver = requireProvider('mysql2/promise');
    const nodemailer = requireProvider('nodemailer');
    const { createCrmAuthRouter } = requireProvider('./crmAuthRoutes');
    const { createCrmOtpStore } = requireProvider('./crmOtpStore');
    mysql = mysqlDriver.createPool(mysqlUrl!);
    prisma = new PrismaClient({ datasources: { db: { url: pgUrl! } } });
    // Fresh, explicitly migrated disposable databases only: no DELETE of pre-existing data.
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.mobileSession.count()).toBe(0);
    const [otpRows] = await mysql.query(
      'SELECT COUNT(*) AS rows_count FROM crm_auth_otp',
    );
    expect(otpRows[0].rows_count).toBe(0);
    const smtp = nodemailer.createTransport({
      host: '127.0.0.1',
      port: Number(smtpPort),
      secure: false,
      tls: { rejectUnauthorized: true },
    });
    const router = createCrmAuthRouter({
      store: createCrmOtpStore({
        pool: mysql,
        config: { cooldownMs: 1, ipMaxRequests: 30 },
      }),
      operatorEmail: email, // internal synthetic fixture; production server never overrides it
      hashSecret: () => hashSecret,
      proofSecret: () => proofSecret,
      sendCode: async ({ to, code }: { to: string; code: string }) => {
        await smtp.sendMail({
          from: 'integration@example.test',
          to,
          subject: 'Hermes integration code',
          text: `One-time code: ${code}`,
        });
      },
      createAdminSession: () => 'synthetic-web-session',
    });
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use('/api/crm/auth', router);
    provider = await new Promise((resolve) => {
      const server = expressApp.listen(0, '127.0.0.1', () =>
        resolve(server as Server),
      );
    });
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('Provider is not listening on TCP');
    providerBase = `http://127.0.0.1:${address.port}`;
    const config = {
      get: (key: string, fallback?: string) =>
        ({
          JWT_SECRET: jwtSecret,
          CRM_HERMES_PROOF_SECRET: proofSecret,
          CRM_OPERATOR_EMAIL: email,
        })[key] ?? fallback,
      getOrThrow: (key: string) => ({ JWT_SECRET: jwtSecret })[key],
    };
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: jwtSecret,
          signOptions: { expiresIn: '7d' },
        }),
      ],
      controllers: [AuthController, MobileInboxController],
      providers: [
        AuthService,
        JwtStrategy,
        MobileInboxGuard,
        MobileInboxService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    hermes = module.createNestApplication();
    hermes.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await hermes.listen(0, '127.0.0.1');
    hermesBase = await hermes.getUrl();
  });

  afterAll(async () => {
    if (hermes) await hermes.close();
    if (provider)
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    if (prisma) await prisma.$disconnect();
    if (mysql) await mysql.end();
  });

  it('captures mail only locally; OTP audiences, replay, phone replacement and web revocation work over HTTP', async () => {
    let lastMailId: string | undefined;
    const codeFromMailpit = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await fetch(`${mailpitBase}/api/v1/messages`);
        const inbox = (await response.json()) as {
          messages?: Array<{ ID: string }>;
        };
        const next = inbox.messages?.find((item) => item.ID !== lastMailId);
        if (next) {
          lastMailId = next.ID;
          const message = (await (
            await fetch(`${mailpitBase}/api/v1/message/${next.ID}`)
          ).json()) as { Text?: string };
          const code = /\b\d{8}\b/.exec(message.Text ?? '')?.[0];
          if (code) return code;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Mailpit did not capture a local synthetic OTP');
    };
    const issueProof = async (mobile: boolean) => {
      expect(
        (await post(`${providerBase}/api/crm/auth/request-code`, { email }))
          .code,
      ).toBe(200);
      const code = await codeFromMailpit(); // never print OTP or proof
      const verified = await post(
        `${providerBase}/api/crm/auth/${mobile ? 'mobile/' : ''}verify-code`,
        { email, code },
      );
      expect(verified.code).toBe(200);
      expect(typeof verified.json.proof).toBe('string');
      expect(
        (
          await post(`${providerBase}/api/crm/auth/mobile/verify-code`, {
            email,
            code,
          })
        ).code,
      ).toBe(400);
      if (mobile) expect(verified.json.adminToken).toBeUndefined();
      return verified.json.proof as string;
    };
    const mobileProof = await issueProof(true);
    expect(
      (await post(`${hermesBase}/api/auth/crm-proof`, { proof: mobileProof }))
        .code,
    ).toBe(401);
    const first = await post(`${hermesBase}/api/auth/mobile/crm-proof`, {
      proof: mobileProof,
    });
    expect(first.code).toBe(200);
    expect(
      (
        await post(`${hermesBase}/api/auth/mobile/crm-proof`, {
          proof: mobileProof,
        })
      ).code,
    ).toBe(401);
    const firstAccess = first.json.accessToken as string;
    expect(
      (
        await fetch(`${hermesBase}/api/mobile/inbox`, {
          headers: { authorization: `Bearer ${firstAccess}` },
        })
      ).status,
    ).toBe(200);
    const webProof = await issueProof(false);
    expect(
      (
        await post(`${hermesBase}/api/auth/mobile/crm-proof`, {
          proof: webProof,
        })
      ).code,
    ).toBe(401);
    const web = await post(`${hermesBase}/api/auth/crm-proof`, {
      proof: webProof,
    });
    expect(web.code).toBe(200);
    const webAccess = web.json.accessToken as string;
    const secondProof = await issueProof(true);
    const second = await post(`${hermesBase}/api/auth/mobile/crm-proof`, {
      proof: secondProof,
    });
    expect(second.code).toBe(200);
    expect(
      (
        await fetch(`${hermesBase}/api/auth/mobile/session`, {
          headers: { authorization: `Bearer ${firstAccess}` },
        })
      ).status,
    ).toBe(401);
    const secondAccess = second.json.accessToken as string;
    const revocation = await post(
      `${hermesBase}/api/auth/mobile/revoke-all`,
      {},
      webAccess,
    );
    expect(revocation.code).toBe(200);
    expect(revocation.json.revokedSessions).toBe(1);
    expect(
      (
        await fetch(`${hermesBase}/api/auth/mobile/session`, {
          headers: { authorization: `Bearer ${secondAccess}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${hermesBase}/api/auth/profile`, {
          headers: { authorization: `Bearer ${webAccess}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${hermesBase}/api/mobile/inbox`, {
          headers: { authorization: `Bearer ${secondAccess}` },
        })
      ).status,
    ).toBe(401);
  });
});

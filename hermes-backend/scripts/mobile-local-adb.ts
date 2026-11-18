// Deliberately NOT AppModule: only the real OTP router and the two read/auth
// controllers are registered. No Meta, Redis, outgoing reply, or .env loading.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import {
  MessageDirection, MessageSender, MessageType, PrismaClient,
} from '@prisma/client';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { MobileInboxController } from '../src/mobile-inbox/mobile-inbox.controller';
import { MobileInboxGuard } from '../src/mobile-inbox/mobile-inbox.guard';
import { MobileInboxService } from '../src/mobile-inbox/mobile-inbox.service';
import { PrismaService } from '../src/prisma/prisma.service';

const email = 'isolated-operator@example.test';
const pgUrl = process.env.DATABASE_URL ?? '';
const myUrl = process.env.HERMES_LOCAL_ADB_MYSQL_URL ?? '';
const smtpPort = process.env.HERMES_LOCAL_ADB_SMTP_PORT ?? '';
const providerPath = process.env.HERMES_LOCAL_ADB_PROVIDER_BACKEND ?? '';
const rehearsalSeconds = Number(process.env.HERMES_LOCAL_ADB_REHEARSAL_SECONDS ?? '0');

function disposableUrl(value: string, protocol: string, database: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${protocol}:` && url.hostname === '127.0.0.1' &&
      /^\d+$/.test(url.port) && !!url.username && !!url.password &&
      new RegExp(`^/${database}[a-f0-9]{32}$`).test(url.pathname) &&
      !url.search && !url.hash;
  } catch { return false; }
}

// Rehearsal runs against the actual HTTP listeners; credentials stay in memory.
async function smoke(conversationId: string) {
  const otp = 'http://127.0.0.1:18081';
  const api = 'http://127.0.0.1:18082';
  const send = async (url: string, body: object) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const base of [otp, api]) {
    if (!(await fetch(`${base}/__qa/health`)).ok) throw new Error('Health check failed');
  }
  if ((await send(`${otp}/api/crm/auth/request-code`, { email })).status !== 200)
    throw new Error('OTP request failed');
  let code: string | undefined;
  for (let attempt = 0; attempt < 30 && !code; attempt++) {
    const inbox = await (await fetch('http://127.0.0.1:18083/api/v1/messages')).json() as {
      messages?: Array<{ ID: string }>;
    };
    const id = inbox.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`http://127.0.0.1:18083/api/v1/message/${encodeURIComponent(id)}`)).json() as { Text?: string };
      code = /\b\d{8}\b/.exec(message.Text ?? '')?.[0];
    }
    if (!code) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!code) throw new Error('Local mail capture failed');
  const verified = await send(`${otp}/api/crm/auth/mobile/verify-code`, { email, code });
  if (!verified.ok) throw new Error('OTP verification failed');
  const { proof } = await verified.json() as { proof: string };
  const exchanged = await send(`${api}/api/auth/mobile/crm-proof`, { proof });
  if (!exchanged.ok) throw new Error('Hermes proof exchange failed');
  const { accessToken } = await exchanged.json() as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const inbox = await fetch(`${api}/api/mobile/inbox`, { headers });
  if (!inbox.ok) throw new Error('Mobile inbox failed');
  const page = await inbox.json() as { data: Array<{ id: string }> };
  if (page.data.length !== 1 || page.data[0].id !== conversationId)
    throw new Error('Synthetic conversation not found');
  const messages = await fetch(`${api}/api/mobile/inbox/${conversationId}/messages`, { headers });
  if (!messages.ok || ((await messages.json()) as { data: unknown[] }).data.length !== 2)
    throw new Error('Synthetic messages not found');
  console.log('Local HTTP rehearsal passed (OTP → Mailpit → Hermes → inbox); credentials redacted.');
}

async function main() {
  if (!disposableUrl(pgUrl, 'postgresql', 'hermes_local_adb_') ||
      !disposableUrl(myUrl, 'mysql', 'crm_local_adb_') ||
      !/^\d+$/.test(smtpPort) || !providerPath ||
      !Number.isInteger(rehearsalSeconds) || rehearsalSeconds < 0 || rehearsalSeconds > 120)
    throw new Error('Disposable loopback prerequisites missing');

  const requireProvider = createRequire(join(providerPath, 'package.json'));
  const express = requireProvider('express');
  const mysqlDriver = requireProvider('mysql2/promise');
  const nodemailer = requireProvider('nodemailer');
  const { createCrmAuthRouter } = requireProvider('./crmAuthRoutes');
  const { createCrmOtpStore } = requireProvider('./crmOtpStore');
  const mysql = mysqlDriver.createPool(myUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: pgUrl } } });
  let provider: Server | undefined;
  let hermes: INestApplication | undefined;
  try {
    // Never seed an existing database, even one with a plausible name.
    if (await prisma.contact.count() !== 0 || await prisma.user.count() !== 0 ||
        await prisma.conversation.count() !== 0 || await prisma.message.count() !== 0)
      throw new Error('PostgreSQL fixture must be empty');
    const [rows] = await mysql.query('SELECT COUNT(*) AS total FROM crm_auth_otp');
    if (Number(rows[0].total) !== 0) throw new Error('MariaDB fixture must be empty');

    const contact = await prisma.contact.create({ data: {
      waId: 'synthetic-wa-local-qa', phone: '+15550100001', name: 'Contacto sintético',
    } });
    const conversation = await prisma.conversation.create({ data: {
      contactId: contact.id, channel: 'whatsapp', status: 'ACTIVE',
    } });
    for (const [index, content] of ['Hola, ¿hay disponibilidad?', 'Sí, esta es una demostración local.'].entries()) {
      await prisma.message.create({ data: {
        contactId: contact.id, conversationId: conversation.id,
        direction: index === 0 ? MessageDirection.INBOUND : MessageDirection.OUTBOUND,
        sender: index === 0 ? MessageSender.CONTACT : MessageSender.HUMAN,
        type: MessageType.TEXT, content,
      } });
    }

    const jwtSecret = randomBytes(48).toString('hex');
    const proofSecret = randomBytes(48).toString('hex');
    const hashSecret = randomBytes(48).toString('hex');
    const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: Number(smtpPort), secure: false });
    const router = createCrmAuthRouter({
      store: createCrmOtpStore({ pool: mysql, config: { cooldownMs: 1000, ipMaxRequests: 30 } }),
      operatorEmail: email,
      hashSecret: () => hashSecret,
      proofSecret: () => proofSecret,
      sendCode: async ({ to, code }: { to: string; code: string }) => {
        if (to !== email) throw new Error('Unexpected SMTP recipient');
        await smtp.sendMail({ from: 'qa@example.test', to, subject: 'Código local QA', text: `Código: ${code}` });
      },
      createAdminSession: () => 'synthetic-web-session',
    });
    const expressApp = express();
    expressApp.disable('x-powered-by');
    expressApp.use(express.json({ limit: '8kb' }));
    expressApp.use('/api/crm/auth', router);
    expressApp.get('/__qa/health', (_req: unknown, res: { json: (body: object) => void }) => res.json({ ready: true }));

    const localSettings: Record<string, string> = {
      JWT_SECRET: jwtSecret, CRM_HERMES_PROOF_SECRET: proofSecret, CRM_OPERATOR_EMAIL: email,
    };
    const config = {
      get: (key: string, fallback?: string) => localSettings[key] ?? fallback,
      getOrThrow: (key: string) => key === 'JWT_SECRET' ? jwtSecret : undefined,
    };
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: jwtSecret, signOptions: { expiresIn: '7d' } })],
      controllers: [AuthController, MobileInboxController],
      providers: [AuthService, JwtStrategy, MobileInboxGuard, MobileInboxService,
        { provide: ConfigService, useValue: config }, { provide: PrismaService, useValue: prisma }],
    }).compile();
    hermes = module.createNestApplication({ logger: false });
    hermes.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
      transform: true, transformOptions: { enableImplicitConversion: true } }));
    hermes.getHttpAdapter().get('/__qa/health', (_req: unknown, res: { json: (body: object) => void }) => res.json({ ready: true }));
    // Bind both BEFORE declaring ready; an occupied port fails closed.
    await hermes.listen(18082, '127.0.0.1');
    provider = await new Promise<Server>((resolve, reject) => {
      const server: Server = expressApp.listen(18081, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
    });
    if (rehearsalSeconds > 0) await smoke(conversation.id);
    console.log('QA local ready: OTP http://127.0.0.1:18081 ; Hermes http://127.0.0.1:18082 ; Ctrl+C to stop.');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      if (rehearsalSeconds > 0) setTimeout(resolve, rehearsalSeconds * 1000);
    });
  } finally {
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    if (hermes) await hermes.close();
    await prisma.$disconnect();
    await mysql.end();
  }
}

void main().catch(() => {
  // Never emit driver errors: URLs, OTP/proofs or JWTs could be present.
  console.error('QA local startup/cleanup failed; no credentials are printed.');
  process.exitCode = 1;
});

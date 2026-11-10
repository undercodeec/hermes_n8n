import {
  ConversationStatus,
  MessageDirection,
  MessageSender,
  PrismaClient,
  TaskStatus,
  TaskType,
  UserRole,
} from '@prisma/client';
import { ConversationsService } from '../src/conversations/conversations.service';
import { QueryConversationsDto } from '../src/conversations/dto/query-conversations.dto';
import { MetaService } from '../src/meta/meta.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  Param,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { randomUUID, createHmac } from 'node:crypto';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationEventsService } from '../src/conversations/conversation-events.service';
import { PaymentsService } from '../src/payments/payments.service';
import { FeedbackController } from '../src/feedback/feedback.controller';
import { FeedbackService } from '../src/feedback/feedback.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { Roles } from '../src/common/decorators/roles.decorator';
import type { Request, Response, NextFunction } from 'express';

// Disable generated Prisma 5 .env probing, not the real client/PG engine.
jest.mock('@prisma/client/runtime/library.js', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@prisma/client/runtime/library.js',
  ),
  warnEnvConflicts: () => undefined,
}));
const databaseUrl = process.env.INBOX_ORDER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

// Explicit test-only adapter: the real PaymentsService reads PostgreSQL, while
// res.json preserves a literal JSON null (Nest's default null is an empty body).
// This is NOT the production TransfersController or a payment-flow test.
@Controller('api/transfers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
class LocalTransferReadController {
  constructor(private readonly payments: PaymentsService) {}
  @Get('conversation/:id')
  async read(@Param('id') id: string, @Res() response: Response) {
    response.json(await this.payments.byConversation(id));
  }
}
describeDatabase('Pilot Inbox against disposable PostgreSQL', () => {
  let prisma: PrismaClient;
  let service: ConversationsService;
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 0, minute));
  const chat = (index: number) => `chat-${String(index).padStart(3, '0')}`;
  const ids = Array.from({ length: 68 }, (_, index) => chat(index));
  const minute = (index: number) => (index === 15 ? 14 : index);
  const expected = [...ids.slice(0, 65)]
    .sort(
      (a, b) =>
        minute(Number(b.slice(5))) - minute(Number(a.slice(5))) ||
        (a < b ? -1 : a > b ? 1 : 0),
    )
    .concat(ids.slice(65));
  const list = (query: Partial<QueryConversationsDto> = {}) =>
    service.findAll({ page: 1, limit: 50, ...query });
  function exportFixture(scenario: string, pages: unknown[], detail: unknown) {
    if (process.env.INBOX_ORDER_EXPORT_FIXTURE === '1')
      console.info(
        `INBOX_BROWSER_FIXTURE ${JSON.stringify({ scenario, pages, detail })}`,
      );
  }
  async function message(index: number, suffix: string, time: number) {
    return prisma.message.create({
      data: {
        id: `${chat(index)}-${suffix}`,
        conversationId: chat(index),
        contactId: `contact-${index}`,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        content: 'Synthetic local fixture; never sent',
        createdAt: at(time),
        rawPayload: { privateFixture: 'PRIVATE_RAW_PAYLOAD' },
        metadata: { privateFixture: 'PRIVATE_MESSAGE_METADATA' },
      },
    });
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const name = process.env.INBOX_ORDER_TEST_DATABASE_NAME;
    if (
      url.protocol !== 'postgresql:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      !name ||
      !/^inbox_test_[a-f0-9]{32}$/.test(name) ||
      url.pathname !== `/${name}` ||
      url.username !== 'inbox_test'
    )
      throw new Error(
        'Use scripts/run-inbox-order-integration.mjs with its fresh database',
      );
    // Generated Prisma internal hook: review upon Prisma upgrade.
    const options = {
      datasources: { db: { url: databaseUrl } },
      __internal: {
        configOverride: (config: Record<string, unknown>) => ({
          ...config,
          relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null },
        }),
      },
    };
    prisma = new PrismaClient(options);
    expect(await prisma.conversation.count()).toBe(0);
    service = new ConversationsService(
      prisma as PrismaService,
      {} as MetaService,
    );
    for (let index = 0; index < ids.length; index++) {
      await prisma.contact.create({
        data: {
          id: `contact-${index}`,
          waId: `synthetic-wa-${index}`,
          name: index % 2 === 0 ? 'Fixture Match' : 'Other Fixture',
          phone: `synthetic-phone-${index}`,
        },
      });
      await prisma.conversation.create({
        data: {
          id: chat(index),
          contactId: `contact-${index}`,
          status:
            index % 2 === 0
              ? ConversationStatus.ACTIVE
              : ConversationStatus.CLOSED,
          updatedAt: at(200 - index),
          state: {
            create: {
              detectedIntent: index % 3 === 0 ? 'Purchase' : 'support',
            },
          },
          metadata:
            index % 3 === 0
              ? {
                  pilotOrigin: 'meta_ad',
                  pilotOriginEvidence: 'meta_referral_ad',
                  pilotAd: { sourceId: `synthetic-ad-${index}` },
                  privateFixture: 'PRIVATE_CONVERSATION_METADATA',
                }
              : index % 3 === 1
                ? {
                    pilotOrigin: 'organic',
                    pilotOriginEvidence: 'meta_referral_post',
                  }
                : {},
        },
      });
      if (index < 65) {
        await message(index, 'old', -100);
        await message(index, 'a', minute(index));
        await message(index, 'z', minute(index));
      }
    }
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('globally ranks >50 chats, ties, previews and empty chats without duplicates', async () => {
    const first = await list();
    const second = await list({ page: 2 });
    expect(first).toMatchObject({
      total: 68,
      totalPages: 2,
      page: 1,
      limit: 50,
    });
    expect([...first.data, ...second.data].map((item) => item.id)).toEqual(
      expected,
    );
    expect(
      new Set([...first.data, ...second.data].map((item) => item.id)).size,
    ).toBe(68);
    expect(first.data[49].id).toBe(chat(14));
    expect(second.data[0].id).toBe(chat(15));
    expect(first.data[0].messages[0].id).toBe(`${chat(64)}-z`);
    expect(first.data[0]._count.messages).toBe(3);
    expect(second.data.slice(-3).map((item) => item.messages)).toEqual([
      [],
      [],
      [],
    ]);
    expect(await list({ page: 3 })).toMatchObject({
      data: [],
      total: 68,
      totalPages: 2,
    });
    exportFixture('initial', [first, second], await service.findOne(chat(64)));
  });
  it('does not promote non-message or priority activity', async () => {
    await prisma.conversation.update({
      where: { id: chat(0) },
      data: { status: ConversationStatus.PAUSED, updatedAt: at(1000) },
    });
    await prisma.humanHandoff.create({ data: { conversationId: chat(0) } });
    await prisma.task.create({
      data: {
        conversationId: chat(2),
        title: 'Synthetic review',
        type: TaskType.PAYMENT_VERIFICATION,
      },
    });
    await prisma.task.create({
      data: {
        conversationId: chat(4),
        title: 'Completed review',
        type: TaskType.PAYMENT_VERIFICATION,
        status: TaskStatus.COMPLETED,
      },
    });
    const result = await list({ limit: 100 });
    expect(result.data.map((item) => item.id)).toEqual(expected);
    expect(result.data.find((item) => item.id === chat(0))?.isPriority).toBe(
      true,
    );
    expect(result.data.find((item) => item.id === chat(2))?.isPriority).toBe(
      true,
    );
    expect(result.data.find((item) => item.id === chat(4))?.isPriority).toBe(
      false,
    );
  });
  it('applies legacy filters and pilot origin before ranking with correct counts/pages', async () => {
    const query = {
      status: ConversationStatus.ACTIVE,
      query: 'fIxTuRe mAtCh',
      intent: 'PURCHASE',
      from: at(130).toISOString(),
      to: at(200).toISOString(),
      limit: 3,
      origin: 'meta_ad' as const,
    };
    const filtered = expected.filter(
      (id) => Number(id.slice(5)) % 6 === 0 && id !== chat(0),
    );
    const collected: string[] = [];
    for (let page = 1; page <= Math.ceil(filtered.length / 3); page++) {
      const result = await list({ ...query, page });
      expect(result.total).toBe(filtered.length);
      expect(result.totalPages).toBe(Math.ceil(filtered.length / 3));
      collected.push(...result.data.map((item) => item.id));
      expect(
        result.data.every((item) => item.attribution?.origin === 'meta_ad'),
      ).toBe(true);
    }
    expect(collected).toEqual(filtered);
    for (const [origin, remainder] of [
      ['meta_ad', 0],
      ['organic', 1],
      ['unknown', 2],
    ] as const) {
      expect(
        (await list({ origin, limit: 100 })).data.map((item) => item.id),
      ).toEqual(expected.filter((id) => Number(id.slice(5)) % 3 === remainder));
    }
    expect(
      (await list({ priorityOnly: true })).data.map((item) => item.id),
    ).toEqual([chat(2), chat(0)]);
    expect(
      (await list({ priorityOnly: true, origin: 'meta_ad' })).data.map(
        (item) => item.id,
      ),
    ).toEqual([chat(0)]);
    expect(
      (await list({ query: 'synthetic-phone-64' })).data.map((item) => item.id),
    ).toEqual([chat(64)]);
    expect(
      (await list({ query: 'synthetic-wa-63' })).data.map((item) => item.id),
    ).toEqual([chat(63)]);
    expect(await list({ query: 'no-such-fixture' })).toMatchObject({
      data: [],
      total: 0,
      totalPages: 0,
    });
  });
  it('moves old/empty chats on message refresh without touching conversation timestamps', async () => {
    await message(0, 'fresh', 2000);
    await message(67, 'fresh', 2001);
    const first = await list();
    const second = await list({ page: 2 });
    expect(first.data.slice(0, 2).map((item) => item.id)).toEqual([
      chat(67),
      chat(0),
    ]);
    expect(first.data[0].updatedAt).toEqual(at(133));
    expect(
      new Set([...first.data, ...second.data].map((item) => item.id)).size,
    ).toBe(68);
    exportFixture(
      'new-message',
      [first, second],
      await service.findOne(chat(67)),
    );
  });
  it('keeps ranking, hydration, inbound aggregate and attribution in the same concurrent snapshot', async () => {
    let inserted = false;
    const observed = prisma.$extends({
      query: {
        conversation: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (args.select && !inserted) {
              inserted = true;
              await prisma.message.create({
                data: {
                  id: `${chat(66)}-concurrent`,
                  conversationId: chat(66),
                  contactId: 'contact-66',
                  direction: MessageDirection.INBOUND,
                  sender: MessageSender.CONTACT,
                  content: 'Synthetic concurrent inbound',
                  createdAt: at(3000),
                },
              });
            }
            return rows;
          },
        },
      },
    });
    const concurrent = new ConversationsService(
      observed as unknown as PrismaService,
      {} as MetaService,
    );
    const snapshot = await concurrent.findAll({ page: 1, limit: 100 });
    expect(inserted).toBe(true);
    expect(snapshot.data.at(-1)).toMatchObject({
      id: chat(66),
      messages: [],
      _count: { messages: 0 },
      replyWindow: { lastInboundAt: null },
    });
    const refreshed = await list();
    expect(refreshed.data[0]).toMatchObject({
      id: chat(66),
      _count: { messages: 1 },
      replyWindow: { lastInboundAt: at(3000) },
    });
  });
  it('preserves safe pilot projections and public assigned user in actual nested JSON', async () => {
    const agent = await prisma.user.create({
      data: {
        id: 'synthetic-agent',
        email: 'agent@example.invalid',
        name: 'Synthetic Agent',
        password: 'SYNTHETIC_PASSWORD_HASH_MUST_NOT_LEAVE_DB',
      },
    });
    await prisma.humanHandoff.create({
      data: { conversationId: chat(3), assignedAgentId: agent.id },
    });
    const listed = await list({ limit: 100 });
    const detail = await service.findOne(chat(3));
    const row = listed.data.find((item) => item.id === chat(3));
    for (const handoffs of [row?.handoffs, detail.handoffs]) {
      expect(handoffs?.[0].assignedAgent).toEqual({
        id: agent.id,
        email: agent.email,
        name: agent.name,
        role: agent.role,
      });
    }
    const json = JSON.stringify([listed, detail]);
    expect(json).not.toContain(agent.password);
    expect(json).not.toMatch(
      /"(?:password|isActive|accessToken|refreshToken|rawPayload)":/,
    );
    expect(json).not.toContain('PRIVATE_RAW_PAYLOAD');
    expect(json).not.toContain('PRIVATE_MESSAGE_METADATA');
    expect(json).not.toContain('PRIVATE_CONVERSATION_METADATA');
    expect(
      (await service.findOne(chat(0))).handoffs[0].assignedAgent,
    ).toBeNull();
    expect(row?.attribution).toMatchObject({
      origin: 'meta_ad',
      initialAdSourceId: 'synthetic-ad-3',
    });
  });
  const volumeTest = process.env.INBOX_ORDER_SERVE_LOCAL === '1' ? it.skip : it;
  volumeTest(
    'measures 10,000 chats and 200,000 additional messages on the pilot schema',
    async () => {
      for (let start = 0; start < 10_000; start += 500) {
        const indexes = Array.from(
          { length: 500 },
          (_, offset) => start + offset,
        );
        await prisma.contact.createMany({
          data: indexes.map((index) => ({
            id: `volume-contact-${index}`,
            waId: `synthetic-volume-${index}`,
          })),
        });
        await prisma.conversation.createMany({
          data: indexes.map((index) => ({
            id: `volume-chat-${String(index).padStart(5, '0')}`,
            contactId: `volume-contact-${index}`,
          })),
        });
        await prisma.message.createMany({
          data: indexes.flatMap((index) =>
            Array.from({ length: 20 }, (_, messageIndex) => ({
              id: `volume-message-${index}-${messageIndex}`,
              conversationId: `volume-chat-${String(index).padStart(5, '0')}`,
              contactId: `volume-contact-${index}`,
              direction: MessageDirection.OUTBOUND,
              sender: MessageSender.HERMES,
              content: 'Synthetic benchmark; never sent',
              createdAt: at(4000 + index + messageIndex),
            })),
          ),
        });
      }
      const durations: number[] = [];
      for (let sample = 0; sample < 10; sample++) {
        const started = performance.now();
        const result = await list({ page: sample % 2 === 0 ? 1 : 100 });
        durations.push(Math.round(performance.now() - started));
        expect(result.total).toBe(10_068);
        expect(result.data).toHaveLength(50);
        if (sample % 2 === 0)
          expect(result.data[0].id).toBe('volume-chat-09999');
      }
      const sorted = [...durations].sort((a, b) => a - b);
      const concurrentMs: number[] = [];
      for (let wave = 0; wave < 3; wave++) {
        await Promise.all(
          Array.from({ length: 4 }, async (_, reader) => {
            const started = performance.now();
            const result = await list({ page: reader % 2 === 0 ? 1 : 100 });
            concurrentMs.push(Math.round(performance.now() - started));
            expect(result.total).toBe(10_068);
            expect(result.data).toHaveLength(50);
          }),
        );
      }
      const sortedConcurrent = [...concurrentMs].sort((a, b) => a - b);
      console.info('INBOX_VOLUME_EVIDENCE', {
        chats: await prisma.conversation.count(),
        messages: await prisma.message.count(),
        samplesMs: durations,
        p50Ms: sorted[4],
        p95Ms: sorted[9],
        concurrentReaders: 4,
        concurrentSamplesMs: concurrentMs,
        concurrentP95Ms: sortedConcurrent[11],
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    },
    120_000,
  );

  it('serves real Nest auth/conversations and protected CRM detail dependencies against PostgreSQL', async () => {
    const serveLocal = process.env.INBOX_ORDER_SERVE_LOCAL === '1';
    const proofSecret =
      process.env.INBOX_LOCAL_PROOF_SECRET ??
      'inbox-local-synthetic-proof-20261110-only';
    expect(proofSecret).toBe('inbox-local-synthetic-proof-20261110-only');
    const jwtSecret = randomUUID() + randomUUID();
    const config = new ConfigService({
      JWT_SECRET: jwtSecret,
      CRM_HERMES_PROOF_SECRET: proofSecret,
      CRM_OPERATOR_EMAIL: 'gerencia@undercodeec.com',
    });
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: jwtSecret }),
      ],
      controllers: [
        AuthController,
        ConversationsController,
        LocalTransferReadController,
        FeedbackController,
      ],
      providers: [
        AuthService,
        JwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: ConversationsService, useValue: service },
        {
          provide: PaymentsService,
          useFactory: () => {
            const blocked = new Proxy(
              {},
              {
                get() {
                  throw new Error(
                    'External/mutating payment collaborator forbidden in local QA',
                  );
                },
              },
            );
            return new PaymentsService(
              prisma as PrismaService,
              config,
              blocked as ConstructorParameters<typeof PaymentsService>[2],
              blocked as ConstructorParameters<typeof PaymentsService>[3],
              blocked as ConstructorParameters<typeof PaymentsService>[4],
            );
          },
        },
        {
          provide: FeedbackService,
          useValue: new FeedbackService(prisma as PrismaService),
        },
        {
          provide: ConversationEventsService,
          useValue: new ConversationEventsService(),
        },
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    let stop: (() => void) | undefined;
    // No production AppModule, workers, Redis, Meta, SMTP or external config.
    // Only real auth exchange may write its synthetic user. Reject all other
    // mutations BEFORE dispatch, including replies/payments/status edits.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!req.url.startsWith('/api/')) req.url = `/api${req.url}`;
      if (req.method === 'GET' && req.url === '/api/__inbox_local_stop') {
        res.json({ stopped: true });
        stop?.();
        return;
      }
      if (
        req.method !== 'GET' &&
        !(req.method === 'POST' && req.url === '/api/auth/crm-proof')
      ) {
        res.status(405).json({ error: 'Local QA harness is read-only' });
        return;
      }
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
      }),
    );
    try {
      await app.listen(serveLocal ? 3312 : 0, '127.0.0.1');
      const base = await app.getUrl();
      expect((await fetch(`${base}/conversations`)).status).toBe(401);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'undercodeec-admin',
          aud: 'hermes-crm',
          sub: 'gerencia@undercodeec.com',
          role: 'ADMIN',
          jti: randomUUID(),
          iat: now,
          exp: now + 120,
        }),
      ).toString('base64url');
      const unsigned = `${header}.${payload}`;
      const proof = `${unsigned}.${createHmac('sha256', proofSecret).update(unsigned).digest('base64url')}`;
      const authResponse = await fetch(`${base}/auth/crm-proof`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proof }),
      });
      expect(authResponse.status).toBe(200);
      const auth = (await authResponse.json()) as { accessToken: string };
      const headers = { authorization: `Bearer ${auth.accessToken}` };
      const response = await fetch(`${base}/conversations?page=1&limit=50`, {
        headers,
      });
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        data: Array<{ id: string }>;
        total: number;
      };
      expect(page.total).toBe(serveLocal ? 68 : 10_068);
      expect(page.data).toHaveLength(50);
      // Mirror page.jsx Promise.all on a seeded chat with no payment/feedback.
      const selectedId = 'chat-066';
      const paths = [
        `/conversations/${selectedId}`,
        `/conversations/${selectedId}/messages?page=1&limit=50`,
        `/transfers/conversation/${selectedId}`,
        `/feedback/conversation/${selectedId}`,
      ];
      const reads = await Promise.all(
        paths.map((path) => fetch(`${base}${path}`, { headers })),
      );
      expect(reads.map((read) => read.status)).toEqual([200, 200, 200, 200]);
      expect(await reads[0].json()).toMatchObject({ id: selectedId });
      expect(await reads[1].json()).toMatchObject({ totalPages: 1 });
      expect(reads[2].headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await reads[2].text()).toBe('null');
      expect(await reads[3].json()).toEqual({
        data: [],
        summary: { total: 0, good: 0, bad: 0, reasons: {} },
      });
      for (const path of paths.slice(2)) {
        expect((await fetch(`${base}${path}`)).status).toBe(401);
      }
      for (const path of ['/transfers/synthetic/approve', '/feedback']) {
        expect(
          (await fetch(`${base}${path}`, { method: 'POST', headers })).status,
        ).toBe(405);
      }
      expect(
        (
          await fetch(`${base}/conversations/chat-000/reply`, {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await fetch(`${base}/auth/crm-proof`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ proof }),
          })
        ).status,
      ).toBe(401);
      if (!serveLocal) return;
      console.info(
        'INBOX_LOCAL_NEST_READY http://127.0.0.1:3312 real Nest auth + service + disposable PostgreSQL; read-only, auto-close in 10 minutes',
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 600_000);
        // Explicit loopback-only stop endpoint, never part of the product API.
        stop = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } finally {
      await app.close();
    }
  }, 660_000);
});

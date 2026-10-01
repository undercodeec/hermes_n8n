import { randomInt } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, AddressInfo } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import {
  AdvertisingConsentChoice,
  AdvertisingEventType,
  AdvertisingProvider,
  AdvertisingSyncStatus,
  LeadStage,
  MetaWebhookInboxStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { AdvertisingService } from '../src/advertising/advertising.service';
import { AdvertisingSyncJobData } from '../src/advertising/advertising.constants';
import { AttributionIntentsController } from '../src/advertising/advertising.controller';
import { AttributionRegistrationGuard } from '../src/advertising/attribution-registration.guard';
import { GoogleDataManagerService } from '../src/advertising/google-data-manager.service';
import { AutoReplyService } from '../src/auto-replies/auto-reply.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { CampaignsService } from '../src/campaigns/campaigns.service';
import { ConversationGuardService } from '../src/conversation-guard/conversation-guard.service';
import { ConversationEventsService } from '../src/conversations/conversation-events.service';
import { HandoffService } from '../src/handoff/handoff.service';
import { HermesService } from '../src/hermes/hermes.service';
import { LeadsService } from '../src/leads/leads.service';
import { MetaService } from '../src/meta/meta.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookController } from '../src/webhook/webhook.controller';
import { WebhookService } from '../src/webhook/webhook.service';
import { MetaWebhookDto } from '../src/webhook/dto/meta-webhook.dto';

const testUrl = process.env.ADS_D_TEST_DATABASE_URL;
if (!testUrl)
  throw new Error(
    'ADS_D_TEST_DATABASE_URL is required for isolated Phase D integration',
  );
const parsed = new URL(testUrl);
if (
  !['127.0.0.1', 'localhost', 'postgres'].includes(parsed.hostname) ||
  !/^ads_d_test_[a-z0-9_]+$/i.test(parsed.pathname.slice(1))
) {
  throw new Error(
    'Phase D integration requires a dedicated local ads_d_test_* database',
  );
}

describe('Phase D signed inbound correlation in isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let advertising: AdvertisingService;
  let webhook: WebhookService;
  let controller: WebhookController;
  const eventKeys: string[] = [];
  const waIds: string[] = [];
  const touchIds: string[] = [];
  const leadIds: string[] = [];
  const userIds: string[] = [];
  const integrationIds: string[] = [];
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const secret = 'synthetic-app-secret-for-phase-d';
  const pepper = 'synthetic-reference-pepper-for-phase-d-123456';

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const config = {
      get: (key: string) =>
        key === 'META_APP_SECRET'
          ? secret
          : key === 'META_WEBHOOK_VERIFY_TOKEN'
            ? 'synthetic-verify-token'
            : key === 'AD_ATTRIBUTION_REFERENCE_PEPPER'
              ? pepper
              : undefined,
    } as ConfigService;
    advertising = new AdvertisingService(
      prisma,
      config,
      {} as Queue<AdvertisingSyncJobData>,
    );
    webhook = new WebhookService(
      config,
      prisma,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {
        findOrCreateForConversation: ({
          contactId,
          conversationId,
        }: {
          contactId: string;
          conversationId: string;
        }) =>
          prisma.lead.upsert({
            where: { conversationId },
            create: { contactId, conversationId },
            update: {},
          }),
      } as unknown as LeadsService,
      {
        markReplied: jest.fn().mockResolvedValue(undefined),
        findHumanManagedRecipient: jest.fn().mockResolvedValue(null),
      } as unknown as CampaignsService,
      { enqueue } as unknown as AutoReplyService,
      {
        inspect: jest.fn().mockResolvedValue({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      advertising,
      {
        publishCustomerMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as ConversationEventsService,
      {} as AutomatedDeliveryService,
    );
    controller = new WebhookController(webhook);
  });

  beforeEach(() => {
    enqueue.mockClear();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.metaWebhookInbox.deleteMany({
      where: { eventKey: { in: eventKeys } },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: leadIds } } });
    await prisma.advertisingSyncJob.deleteMany({
      where: { conversion: { leadId: { in: leadIds } } },
    });
    await prisma.advertisingConversion.deleteMany({
      where: { touchId: { in: touchIds } },
    });
    await prisma.advertisingAttribution.deleteMany({
      where: { touchId: { in: touchIds } },
    });
    await prisma.advertisingTouch.deleteMany({
      where: { id: { in: touchIds } },
    });
    await prisma.advertisingConversionMapping.deleteMany({
      where: { integrationId: { in: integrationIds } },
    });
    await prisma.advertisingIntegration.deleteMany({
      where: { id: { in: integrationIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.contact.deleteMany({ where: { waId: { in: waIds } } });
    await prisma.$disconnect();
  });

  async function receive(
    waId: string,
    wamid: string,
    content: string,
    scan = true,
  ) {
    const dto: MetaWebhookDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'synthetic-account',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '', phone_number_id: '' },
                contacts: [{ wa_id: waId, profile: { name: 'Fixture' } }],
                messages: [
                  {
                    id: wamid,
                    from: waId,
                    timestamp: '1',
                    type: 'text',
                    text: { body: content },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(dto));
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    eventKeys.push(`message:${wamid}`);
    await controller.receive(
      dto as unknown as Record<string, unknown>,
      raw,
      signature,
    );
    if (!scan) {
      return prisma.metaWebhookInbox.findUniqueOrThrow({
        where: { eventKey: `message:${wamid}` },
      });
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await prisma.metaWebhookInbox.findUnique({
        where: { eventKey: `message:${wamid}` },
      });
      if (row?.status === MetaWebhookInboxStatus.COMPLETED) return row;
      await webhook.scan();
      await wait(20);
    }
    throw new Error('Signed fixture did not complete in isolated PostgreSQL');
  }

  async function freeLoopbackPort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it('rejects the ACK if the inbox write fails and processes a redelivery once', async () => {
    const suffix = randomInt(100000, 999999).toString();
    const waId = `593994${suffix}`;
    const wamid = `wamid.ads-h-ack-${suffix}`;
    const eventKey = `message:${wamid}`;
    waIds.push(waId);

    const write = jest
      .spyOn(prisma.metaWebhookInbox, 'createMany')
      .mockRejectedValueOnce(new Error('synthetic inbox write failure'));
    try {
      await expect(receive(waId, wamid, 'Hola', false)).rejects.toThrow(
        'synthetic inbox write failure',
      );
      expect(await prisma.metaWebhookInbox.count({ where: { eventKey } })).toBe(
        0,
      );
      expect(await prisma.message.count({ where: { wamid } })).toBe(0);
    } finally {
      write.mockRestore();
    }

    const recovered = await receive(waId, wamid, 'Hola');
    expect(recovered.status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(await prisma.metaWebhookInbox.count({ where: { eventKey } })).toBe(
      1,
    );
    expect(await prisma.message.count({ where: { wamid } })).toBe(1);
    expect(
      await prisma.conversation.count({ where: { contact: { waId } } }),
    ).toBe(1);
    expect(await prisma.lead.count({ where: { contact: { waId } } })).toBe(1);
  });

  it('keeps one message, conversation, lead, claim and milestone across replays and a second contact', async () => {
    const issued = await advertising.createContactIntent({
      consent: {
        adStorage: AdvertisingConsentChoice.DENIED,
        analyticsStorage: AdvertisingConsentChoice.DENIED,
        adUserData: AdvertisingConsentChoice.DENIED,
        adPersonalization: AdvertisingConsentChoice.DENIED,
        source: 'PHASE_D_FIXTURE',
        recordedAt: new Date().toISOString(),
      },
    });
    const touch = await prisma.advertisingTouch.findFirstOrThrow({
      where: { referenceLast4: issued.reference.slice(-4) },
      orderBy: { createdAt: 'desc' },
    });
    touchIds.push(touch.id);
    const suffix = randomInt(100000, 999999).toString();
    const firstWa = `593991${suffix}`;
    const secondWa = `593992${suffix}`;
    waIds.push(firstWa, secondWa);
    const wamid = `wamid.ads-d-${suffix}`;
    const content = `Hola. ${issued.messageSuffix}`;
    const first = await receive(firstWa, wamid, content);
    expect(first.outcome).toBe('confirmed');
    for (let i = 0; i < 5; i++) await receive(firstWa, wamid, content);
    await Promise.all(
      Array.from({ length: 5 }, () => receive(firstWa, wamid, content)),
    );
    expect(await prisma.message.count({ where: { wamid } })).toBe(1);
    expect(
      await prisma.conversation.count({
        where: { contact: { waId: firstWa } },
      }),
    ).toBe(1);
    expect(
      await prisma.lead.count({ where: { contact: { waId: firstWa } } }),
    ).toBe(1);
    expect(
      (
        await prisma.advertisingTouch.findUniqueOrThrow({
          where: { id: touch.id },
        })
      ).useCount,
    ).toBe(1);
    expect(
      await prisma.advertisingAttribution.count({
        where: { touchId: touch.id },
      }),
    ).toBe(1);
    expect(
      await prisma.advertisingConversion.count({
        where: { touchId: touch.id, eventType: 'CONVERSATION_STARTED' },
      }),
    ).toBe(1);
    const second = await receive(
      secondWa,
      `wamid.ads-d-second-${suffix}`,
      content,
    );
    expect(second.outcome).toBe('used');
    expect(
      await prisma.advertisingAttribution.count({
        where: { touchId: touch.id },
      }),
    ).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('acknowledges only a durable inbox row and recovers attribution after a transient failure', async () => {
    const issued = await advertising.createContactIntent({
      consent: {
        adStorage: AdvertisingConsentChoice.DENIED,
        analyticsStorage: AdvertisingConsentChoice.DENIED,
        adUserData: AdvertisingConsentChoice.DENIED,
        adPersonalization: AdvertisingConsentChoice.DENIED,
        source: 'PHASE_H_FIXTURE',
        recordedAt: new Date().toISOString(),
      },
    });
    const touch = await prisma.advertisingTouch.findFirstOrThrow({
      where: { referenceLast4: issued.reference.slice(-4) },
      orderBy: { createdAt: 'desc' },
    });
    touchIds.push(touch.id);
    const suffix = randomInt(100000, 999999).toString();
    const waId = `593993${suffix}`;
    const wamid = `wamid.ads-h-recovery-${suffix}`;
    waIds.push(waId);
    const scan = jest.spyOn(webhook, 'scan').mockResolvedValueOnce(undefined);
    const pending = await receive(
      waId,
      wamid,
      `Hola. ${issued.messageSuffix}`,
      false,
    );
    scan.mockRestore();
    expect(pending.status).toBe(MetaWebhookInboxStatus.PENDING);
    expect(await prisma.message.count({ where: { wamid } })).toBe(0);

    const claim = jest
      .spyOn(advertising, 'claimReference')
      .mockRejectedValueOnce(
        new Error('synthetic transient attribution outage'),
      );
    try {
      await webhook.scan();
      const failed = await prisma.metaWebhookInbox.findUniqueOrThrow({
        where: { eventKey: `message:${wamid}` },
      });
      expect(failed.status).toBe(MetaWebhookInboxStatus.FAILED);
      expect(failed.outcome).toBe('attribution_retry');
      expect(await prisma.message.count({ where: { wamid } })).toBe(1);
      expect(
        (
          await prisma.advertisingTouch.findUniqueOrThrow({
            where: { id: touch.id },
          })
        ).useCount,
      ).toBe(0);

      // An expired lease is what a new worker sees after a restart.
      await prisma.metaWebhookInbox.update({
        where: { id: failed.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      await webhook.scan();
      const recovered = await prisma.metaWebhookInbox.findUniqueOrThrow({
        where: { id: failed.id },
      });
      expect(recovered.status).toBe(MetaWebhookInboxStatus.COMPLETED);
      expect(recovered.outcome).toBe('confirmed');
      expect(await prisma.message.count({ where: { wamid } })).toBe(1);
      expect(
        (
          await prisma.advertisingTouch.findUniqueOrThrow({
            where: { id: touch.id },
          })
        ).useCount,
      ).toBe(1);
      expect(
        await prisma.advertisingAttribution.count({
          where: { touchId: touch.id },
        }),
      ).toBe(1);
    } finally {
      claim.mockRestore();
    }
  });

  it('links a signed reference to a qualified CRM job and intercepted validation HTTP', async () => {
    const suffix = randomInt(100000, 999999).toString();
    const waId = `593995${suffix}`;
    const wamid = `wamid.ads-h-path-${suffix}`;
    waIds.push(waId);
    const consent = {
      adStorage: AdvertisingConsentChoice.GRANTED,
      analyticsStorage: AdvertisingConsentChoice.DENIED,
      adUserData: AdvertisingConsentChoice.GRANTED,
      adPersonalization: AdvertisingConsentChoice.DENIED,
      source: 'PHASE_H_SYNTHETIC_PATH',
      recordedAt: new Date().toISOString(),
    };
    const issued = await advertising.createContactIntent({
      gclid: `synthetic-click-${suffix}`,
      consent,
    });
    const touch = await prisma.advertisingTouch.findFirstOrThrow({
      where: { referenceLast4: issued.reference.slice(-4) },
      orderBy: { createdAt: 'desc' },
    });
    touchIds.push(touch.id);

    const inbox = await receive(waId, wamid, `Hola. ${issued.messageSuffix}`);
    expect(inbox.outcome).toBe('confirmed');
    const lead = await prisma.lead.findFirstOrThrow({
      where: { contact: { waId } },
    });
    leadIds.push(lead.id);
    const user = await prisma.user.create({
      data: {
        email: `ads-h-${suffix}@example.test`,
        password: 'synthetic-fixture-no-login',
        name: 'H Fixture',
      },
    });
    userIds.push(user.id);
    const integration = await prisma.advertisingIntegration.create({
      data: {
        provider: AdvertisingProvider.GOOGLE_ADS,
        accountId: '7181578237',
        loginAccountId: '1112223333',
        conversionCustomerId: '3394423093',
        conversionSyncEnabled: true,
      },
    });
    integrationIds.push(integration.id);
    await prisma.advertisingConversionMapping.create({
      data: {
        integrationId: integration.id,
        eventType: AdvertisingEventType.LEAD_QUALIFIED,
        conversionActionId: '987654321',
        exportEnabled: true,
      },
    });
    const config = {
      get: (key: string) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
    } as ConfigService;
    const leads = new LeadsService(
      prisma,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isActive: () => false } as unknown as ClsService,
      config,
    );
    await leads.update(lead.id, { stage: LeadStage.QUALIFIED }, user.id);
    const conversion = await prisma.advertisingConversion.findUniqueOrThrow({
      where: {
        leadId_eventType: {
          leadId: lead.id,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
        },
      },
      include: { syncJob: true },
    });
    expect(conversion.syncJob?.status).toBe(AdvertisingSyncStatus.PENDING);
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add,
    } as unknown as Queue<AdvertisingSyncJobData>;
    await new AdvertisingService(prisma, config, queue).prepareSync(
      conversion.id,
    );
    expect(add).toHaveBeenCalledTimes(1);
    const job = await prisma.advertisingSyncJob.findUniqueOrThrow({
      where: { conversionId: conversion.id },
    });
    expect(job.status).toBe(AdvertisingSyncStatus.QUEUED);
    expect(job.validateOnly).toBe(true);
    const dataManager = new GoogleDataManagerService(prisma, config);
    const accessToken = jest
      .spyOn(
        dataManager as unknown as { accessToken: () => Promise<string> },
        'accessToken',
      )
      .mockResolvedValue('synthetic-token');
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { requestId: 'synthetic-path-validation' },
    });
    try {
      await dataManager.ingest(job.id);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][1]).toMatchObject({
        validateOnly: true,
        events: [
          {
            transactionId: conversion.idempotencyKey,
            adIdentifiers: { gclid: `synthetic-click-${suffix}` },
          },
        ],
        destinations: [{ productDestinationId: '987654321' }],
      });
      expect(
        (
          await prisma.advertisingSyncJob.findUniqueOrThrow({
            where: { id: job.id },
          })
        ).status,
      ).toBe(AdvertisingSyncStatus.VALIDATED);
      expect(await prisma.message.count({ where: { wamid } })).toBe(1);
      expect(
        await prisma.advertisingAttribution.count({
          where: { leadId: lead.id, touchId: touch.id },
        }),
      ).toBe(1);
    } finally {
      post.mockRestore();
      accessToken.mockRestore();
    }
  });

  (process.env.ADS_H_WEB_ROOT ? it : it.skip)(
    'registers a web BFF v2 intent through Nest and resolves its signed reference',
    async () => {
      const webRoot = process.env.ADS_H_WEB_ROOT!;
      if (!existsSync(join(webRoot, '.next', 'BUILD_ID'))) {
        throw new Error('Phase H BFF fixture requires a current Next build');
      }
      const redisUrl = process.env.ADS_E_TEST_REDIS_URL;
      if (!redisUrl)
        throw new Error('Phase H BFF fixture requires isolated Redis');
      const webPort = await freeLoopbackPort();
      const webOrigin = `http://127.0.0.1:${webPort}`;
      const integrationKey = 'synthetic-phase-h-bff-integration-key-123456789';
      const config = {
        get: (key: string) =>
          key === 'REDIS_URL'
            ? redisUrl
            : key === 'AD_ATTRIBUTION_INTEGRATION_KEY'
              ? integrationKey
              : key === 'AD_ATTRIBUTION_ALLOWED_ORIGINS'
                ? webOrigin
                : key === 'AD_ATTRIBUTION_REFERENCE_PEPPER'
                  ? pepper
                  : undefined,
        getOrThrow: (key: string) => {
          if (key === 'REDIS_URL') return redisUrl;
          throw new Error(`Missing synthetic fixture setting: ${key}`);
        },
      } as ConfigService;
      const guard = new AttributionRegistrationGuard(config);
      let app: INestApplication | undefined;
      let webProcess: ReturnType<typeof spawn> | undefined;
      const suffix = randomInt(100000, 999999).toString();
      const clickId = `synthetic-bff-${suffix}`;
      try {
        const testingModule = await Test.createTestingModule({
          controllers: [AttributionIntentsController],
          providers: [
            { provide: ConfigService, useValue: config },
            { provide: AdvertisingService, useValue: advertising },
            { provide: AttributionRegistrationGuard, useValue: guard },
          ],
        })
          .overrideGuard(AttributionRegistrationGuard)
          .useValue(guard)
          .compile();
        app = testingModule.createNestApplication({ logger: false });
        app.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
          }),
        );
        await app.listen(0, '127.0.0.1');
        const hermesUrl = await app.getUrl();
        webProcess = spawn(
          process.execPath,
          [
            join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
            'start',
            '-H',
            '127.0.0.1',
            '-p',
            String(webPort),
          ],
          {
            cwd: webRoot,
            env: {
              ...process.env,
              HERMES_API_URL: `${hermesUrl}/api`,
              HERMES_ATTRIBUTION_KEY: integrationKey,
              ATTRIBUTION_ALLOWED_ORIGINS: webOrigin,
            },
            stdio: 'ignore',
            windowsHide: true,
          },
        );
        let ready = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          if (webProcess.exitCode !== null) break;
          try {
            const probe = await fetch(`${webOrigin}/api/attribution/whatsapp`, {
              signal: AbortSignal.timeout(1000),
            });
            if (probe.status === 405) {
              ready = true;
              break;
            }
          } catch {
            // Next has not opened its loopback listener yet.
          }
          await wait(100);
        }
        expect(ready).toBe(true);
        const now = new Date();
        const visitedAt = new Date(now.getTime() - 10_000).toISOString();
        const touch = {
          landingPath: '/es',
          visitedAt,
          clickIds: { gclid: clickId, gbraid: null, wbraid: null },
          utm: {
            id: `synthetic-id-${suffix}`,
            source: 'google',
            medium: 'cpc',
            campaign: 'h_fixture',
            content: null,
            term: null,
          },
        };
        const response = await fetch(`${webOrigin}/api/attribution/whatsapp`, {
          method: 'POST',
          headers: {
            Origin: webOrigin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            schemaVersion: 2,
            source: 'undercodeec_web',
            occurredAt: now.toISOString(),
            firstTouch: touch,
            lastTouch: touch,
            consent: {
              analyticsStorage: 'denied',
              adStorage: 'granted',
              adUserData: 'granted',
              adPersonalization: 'denied',
              capturedAt: now.toISOString(),
              policyVersion: 'qa-h-e05',
            },
          }),
          signal: AbortSignal.timeout(8000),
        });
        expect(response.status).toBe(201);
        const issued = (await response.json()) as {
          reference: string;
          expiresAt: string;
        };
        expect(issued.reference).toMatch(/^UC-[A-Z2-7]{22}$/);
        const storedTouch = await prisma.advertisingTouch.findFirstOrThrow({
          where: { gclid: clickId },
        });
        touchIds.push(storedTouch.id);
        expect(storedTouch.utmId).toBe(`synthetic-id-${suffix}`);
        expect(storedTouch.referenceLast4).toBe(issued.reference.slice(-4));
        const waId = `593996${suffix}`;
        const wamid = `wamid.ads-h-bff-${suffix}`;
        waIds.push(waId);
        const inbox = await receive(
          waId,
          wamid,
          `Hola. Referencia: ${issued.reference}`,
        );
        expect(inbox.outcome).toBe('confirmed');
        expect(
          (
            await prisma.advertisingTouch.findUniqueOrThrow({
              where: { id: storedTouch.id },
            })
          ).useCount,
        ).toBe(1);
        expect(
          await prisma.advertisingAttribution.count({
            where: { touchId: storedTouch.id },
          }),
        ).toBe(1);
        expect(await prisma.message.count({ where: { wamid } })).toBe(1);
      } finally {
        const touch = await prisma.advertisingTouch.findFirst({
          where: { gclid: clickId },
          select: { id: true },
        });
        if (touch && !touchIds.includes(touch.id)) touchIds.push(touch.id);
        if (webProcess && webProcess.exitCode === null) {
          webProcess.kill();
          await Promise.race([once(webProcess, 'exit'), wait(5000)]);
        }
        if (app) await app.close();
        (
          guard as unknown as { redis: { disconnect: () => void } }
        ).redis.disconnect();
      }
    },
    60_000,
  );
});

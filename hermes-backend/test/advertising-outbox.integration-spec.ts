import { randomInt } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Queue, Worker } from 'bullmq';
import {
  AdvertisingEventType,
  AdvertisingAttributionStatus,
  AdvertisingConsentChoice,
  AdvertisingProvider,
  AdvertisingSyncStatus,
  LeadStage,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AdvertisingService } from '../src/advertising/advertising.service';
import { AdvertisingProcessor } from '../src/advertising/advertising.processor';
import { GoogleDataManagerService } from '../src/advertising/google-data-manager.service';
import { GoogleAdsReportingService } from '../src/advertising/google-ads-reporting.service';
import { AdvertisingSyncJobData } from '../src/advertising/advertising.constants';
import { AdvertisingReconciliationService } from '../src/advertising/advertising-reconciliation.service';
import { LeadsService } from '../src/leads/leads.service';
import { PrismaService } from '../src/prisma/prisma.service';

const testUrl = process.env.ADS_E_TEST_DATABASE_URL;
if (!testUrl) throw new Error('ADS_E_TEST_DATABASE_URL is required');
const parsed = new URL(testUrl);
if (
  !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
  !/^ads_[de]_test_[a-z0-9_]+$/i.test(parsed.pathname.slice(1))
) {
  throw new Error('Phase E requires a dedicated local ads_*_test_* database');
}
const testRedisUrl = process.env.ADS_E_TEST_REDIS_URL;
if (testRedisUrl) {
  const redis = new URL(testRedisUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    Number(redis.port) < 1024
  ) {
    throw new Error('Phase E Redis must be a dedicated local port');
  }
}

describe('Phase E durable CRM milestones in isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let leads: LeadsService;
  let advertising: AdvertisingService;
  let contactId: string;
  let userId: string;
  let leadId: string;
  let touchId: string;
  let integrationId: string;
  let bullQueue: Queue<AdvertisingSyncJobData> | undefined;
  const suffix = randomInt(100_000_000, 999_999_999).toString();

  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const config = {
      get: (key: string) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED'
          ? 'true'
          : key === 'ADVERTISING_GOOGLE_SEND_ENABLED'
            ? 'false'
            : key === 'CRM_FRONTEND_URL'
              ? 'https://crm.example.test'
              : undefined,
    } as ConfigService;
    const contact = await prisma.contact.create({
      data: { waId: `59399${suffix}`, phone: `59399${suffix}` },
    });
    contactId = contact.id;
    const user = await prisma.user.create({
      data: {
        email: `ads-e-${suffix}@example.test`,
        password: 'synthetic-fixture-no-login',
        name: 'Ads E Fixture',
      },
    });
    userId = user.id;
    leads = new LeadsService(
      prisma,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isActive: () => false } as unknown as ClsService,
      config,
    );
    advertising = new AdvertisingService(prisma, config, {
      add: jest.fn(),
      getJob: jest.fn(),
    } as unknown as Queue<AdvertisingSyncJobData>);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (leadId) {
      await prisma.auditLog.deleteMany({ where: { entityId: leadId } });
      await prisma.advertisingSyncJob.deleteMany({
        where: { conversion: { leadId } },
      });
      await prisma.advertisingConversion.deleteMany({ where: { leadId } });
      await prisma.advertisingAttribution.deleteMany({ where: { leadId } });
      await prisma.lead.deleteMany({ where: { id: leadId } });
    }
    if (touchId)
      await prisma.advertisingTouch.deleteMany({ where: { id: touchId } });
    if (integrationId) {
      await prisma.advertisingConversionMapping.deleteMany({
        where: { integrationId },
      });
      await prisma.advertisingIntegration.deleteMany({
        where: { id: integrationId },
      });
    }
    if (contactId)
      await prisma.contact.deleteMany({ where: { id: contactId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    if (bullQueue) {
      await bullQueue.obliterate({ force: true });
      await bullQueue.close();
    }
  });

  it('commits QUALIFIED and WON with one conversion and one outbox row each', async () => {
    const lead = await leads.create({ contactId, stage: LeadStage.QUALIFIED });
    leadId = lead.id;
    const qualified = await prisma.advertisingConversion.findUniqueOrThrow({
      where: {
        leadId_eventType: {
          leadId,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
        },
      },
      include: { syncJob: true },
    });
    expect(qualified.syncJob?.status).toBe(AdvertisingSyncStatus.PENDING);
    expect(qualified.syncJob?.validateOnly).toBe(true);

    await leads.update(leadId, { stage: LeadStage.PROPOSAL }, userId);
    await expect(
      leads.update(leadId, { stage: LeadStage.WON }, userId),
    ).rejects.toThrow();
    expect(
      (await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).stage,
    ).toBe(LeadStage.PROPOSAL);
    await leads.update(
      leadId,
      {
        stage: LeadStage.WON,
        contractedAmount: 1200,
        commercialCurrency: 'USD',
        contractReference: `contract-${suffix}`,
      },
      userId,
    );
    const won = await prisma.advertisingConversion.findUniqueOrThrow({
      where: {
        leadId_eventType: {
          leadId,
          eventType: AdvertisingEventType.CONTRACT_WON,
        },
      },
      include: { syncJob: true },
    });
    expect(Number(won.value)).toBe(1200);
    expect(won.syncJob?.status).toBe(AdvertisingSyncStatus.PENDING);
    expect(
      await prisma.advertisingConversion.count({ where: { leadId } }),
    ).toBe(2);

    await expect(
      leads.update(leadId, { contractedAmount: 1500 }, userId),
    ).rejects.toThrow();
    expect(
      Number(
        (
          await prisma.advertisingConversion.findUniqueOrThrow({
            where: { id: won.id },
          })
        ).value,
      ),
    ).toBe(1200);
  });

  it('recovers a missing outbox row and grants exactly one of five SQL claims', async () => {
    const qualified = await prisma.advertisingConversion.findUniqueOrThrow({
      where: {
        leadId_eventType: {
          leadId,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
        },
      },
      include: { syncJob: true },
    });
    await prisma.advertisingSyncJob.delete({
      where: { id: qualified.syncJob!.id },
    });
    const reconciler = new AdvertisingReconciliationService(
      prisma,
      advertising,
    );
    await reconciler.scan();
    const recovered = await prisma.advertisingSyncJob.findUniqueOrThrow({
      where: { conversionId: qualified.id },
    });
    expect(recovered.status).toBe(AdvertisingSyncStatus.PENDING);
    await prisma.advertisingSyncJob.update({
      where: { id: recovered.id },
      data: { status: AdvertisingSyncStatus.QUEUED },
    });
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => advertising.claimSyncJob(recovered.id)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await prisma.advertisingSyncJob.findUniqueOrThrow({
          where: { id: recovered.id },
        })
      ).status,
    ).toBe(AdvertisingSyncStatus.RETRYING);
  });

  (testRedisUrl ? it : it.skip)(
    'restores an orphaned BullMQ job and blocks an old real send',
    async () => {
      const redis = new URL(testRedisUrl!);
      bullQueue = new Queue<AdvertisingSyncJobData>(`ads-e-test-${suffix}`, {
        connection: { host: redis.hostname, port: Number(redis.port) },
      });
      const integration = await prisma.advertisingIntegration.create({
        data: {
          provider: AdvertisingProvider.GOOGLE_ADS,
          accountId: '7181578237',
          loginAccountId: '1112223333',
          conversionCustomerId: '3394423093',
          conversionSyncEnabled: true,
        },
      });
      integrationId = integration.id;
      await prisma.advertisingConversionMapping.create({
        data: {
          integrationId,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          conversionActionId: '987654321',
          exportEnabled: true,
        },
      });
      const touch = await prisma.advertisingTouch.create({
        data: {
          referenceHash: suffix.padStart(64, '0'),
          referenceLast4: suffix.slice(-4),
          expiresAt: new Date(Date.now() + 60_000),
          gclid: `synthetic-${suffix}`,
          adUserData: AdvertisingConsentChoice.GRANTED,
        },
      });
      touchId = touch.id;
      await prisma.advertisingAttribution.create({
        data: {
          touchId,
          contactId,
          leadId,
          status: AdvertisingAttributionStatus.CONFIRMED,
          attributedAt: new Date(),
        },
      });
      const conversion = await prisma.advertisingConversion.findUniqueOrThrow({
        where: {
          leadId_eventType: {
            leadId,
            eventType: AdvertisingEventType.LEAD_QUALIFIED,
          },
        },
      });
      await prisma.advertisingSyncJob.update({
        where: { conversionId: conversion.id },
        data: { status: AdvertisingSyncStatus.PENDING, nextAttemptAt: null },
      });
      const liveAdvertising = new AdvertisingService(
        prisma,
        {
          get: (key: string) =>
            key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
        } as ConfigService,
        bullQueue,
      );
      await liveAdvertising.prepareSync(conversion.id);
      const queued = await prisma.advertisingSyncJob.findUniqueOrThrow({
        where: { conversionId: conversion.id },
      });
      expect(queued.status).toBe(AdvertisingSyncStatus.QUEUED);
      expect(queued.destinationSnapshot).toEqual({
        operatingAccountId: '3394423093',
        loginAccountId: '1112223333',
        conversionActionId: '987654321',
      });
      const lostJob = await bullQueue.getJob(queued.id);
      expect(lostJob).not.toBeNull();
      await lostJob!.remove();
      expect(await bullQueue.getJob(queued.id)).toBeUndefined();
      const reconciler = new AdvertisingReconciliationService(
        prisma,
        liveAdvertising,
      );
      await reconciler.scan();
      expect(await bullQueue.getJob(queued.id)).not.toBeUndefined();
      expect(await bullQueue.getJobCounts('waiting')).toMatchObject({
        waiting: 1,
      });

      await prisma.advertisingSyncJob.update({
        where: { id: queued.id },
        data: { validateOnly: false },
      });
      const dataManager = new GoogleDataManagerService(prisma, {
        get: (key: string) =>
          key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      } as ConfigService);
      const post = jest
        .spyOn(axios, 'post')
        .mockRejectedValue(new Error('Outbound network forbidden in fixture'));
      const processor = new AdvertisingProcessor(
        dataManager,
        {} as GoogleAdsReportingService,
        bullQueue,
        liveAdvertising,
      );
      await processor.process({
        name: 'conversion',
        data: { syncJobId: queued.id },
      } as Job<AdvertisingSyncJobData>);
      expect(post).not.toHaveBeenCalled();
      expect(
        (
          await prisma.advertisingSyncJob.findUniqueOrThrow({
            where: { id: queued.id },
          })
        ).status,
      ).toBe(AdvertisingSyncStatus.RETRYING);
      post.mockRestore();
    },
  );

  (testRedisUrl ? it : it.skip)(
    'reconciles a committed outbox row when queue insertion fails',
    async () => {
      const conversion = await prisma.advertisingConversion.findUniqueOrThrow({
        where: {
          leadId_eventType: {
            leadId,
            eventType: AdvertisingEventType.LEAD_QUALIFIED,
          },
        },
        include: { syncJob: true },
      });
      const syncJobId = conversion.syncJob!.id;
      const previous = await bullQueue!.getJob(syncJobId);
      if (previous) await previous.remove();
      await prisma.advertisingSyncJob.update({
        where: { id: syncJobId },
        data: { status: AdvertisingSyncStatus.PENDING, nextAttemptAt: null },
      });
      const config = {
        get: (key: string) =>
          key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      } as ConfigService;
      const unavailableQueue = {
        getJob: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockRejectedValue(new Error('synthetic Redis outage')),
      } as unknown as Queue<AdvertisingSyncJobData>;
      const interrupted = new AdvertisingService(
        prisma,
        config,
        unavailableQueue,
      );
      await expect(interrupted.prepareSync(conversion.id)).rejects.toThrow(
        'synthetic Redis outage',
      );
      expect(await bullQueue!.getJob(syncJobId)).toBeUndefined();
      expect(
        (
          await prisma.advertisingSyncJob.findUniqueOrThrow({
            where: { id: syncJobId },
          })
        ).status,
      ).toBe(AdvertisingSyncStatus.QUEUED);

      const resumed = new AdvertisingService(prisma, config, bullQueue!);
      await new AdvertisingReconciliationService(prisma, resumed).scan();
      expect(await bullQueue!.getJob(syncJobId)).not.toBeUndefined();
      expect(
        await prisma.advertisingSyncJob.count({
          where: { conversionId: conversion.id },
        }),
      ).toBe(1);
    },
  );

  (testRedisUrl ? it : it.skip)(
    'validates the recovered SQL job through an intercepted Data Manager request',
    async () => {
      const conversion = await prisma.advertisingConversion.findUniqueOrThrow({
        where: {
          leadId_eventType: {
            leadId,
            eventType: AdvertisingEventType.LEAD_QUALIFIED,
          },
        },
        include: { syncJob: true },
      });
      const syncJobId = conversion.syncJob!.id;
      await prisma.advertisingSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: AdvertisingSyncStatus.QUEUED,
          validateOnly: true,
          nextAttemptAt: null,
        },
      });
      const dataManager = new GoogleDataManagerService(prisma, {
        get: (key: string) =>
          key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      } as ConfigService);
      const accessToken = jest
        .spyOn(
          dataManager as unknown as { accessToken: () => Promise<string> },
          'accessToken',
        )
        .mockResolvedValue('synthetic-token');
      const post = jest.spyOn(axios, 'post').mockResolvedValue({
        data: { requestId: 'synthetic-validation-request' },
      });
      try {
        await expect(dataManager.ingest(syncJobId)).resolves.toEqual({
          requestId: 'synthetic-validation-request',
          validateOnly: true,
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toBe(
          'https://datamanager.googleapis.com/v1/events:ingest',
        );
        expect(post.mock.calls[0][1]).toMatchObject({
          validateOnly: true,
          events: [{ transactionId: conversion.idempotencyKey }],
          destinations: [{ productDestinationId: '987654321' }],
        });
        expect(
          (
            await prisma.advertisingSyncJob.findUniqueOrThrow({
              where: { id: syncJobId },
            })
          ).status,
        ).toBe(AdvertisingSyncStatus.VALIDATED);
      } finally {
        post.mockRestore();
        accessToken.mockRestore();
      }
    },
  );

  (testRedisUrl ? it : it.skip)(
    'allows one validation request when five BullMQ workers race on the same SQL job',
    async () => {
      const redis = new URL(testRedisUrl!);
      const qualified = await prisma.advertisingConversion.findUniqueOrThrow({
        where: {
          leadId_eventType: {
            leadId,
            eventType: AdvertisingEventType.LEAD_QUALIFIED,
          },
        },
        include: { syncJob: true },
      });
      const oldJob = await bullQueue!.getJob(qualified.syncJob!.id);
      if (oldJob) await oldJob.remove();
      await prisma.advertisingConversionMapping.create({
        data: {
          integrationId,
          eventType: AdvertisingEventType.CONTRACT_WON,
          conversionActionId: '987654322',
          exportEnabled: true,
        },
      });
      const conversion = await prisma.advertisingConversion.findUniqueOrThrow({
        where: {
          leadId_eventType: {
            leadId,
            eventType: AdvertisingEventType.CONTRACT_WON,
          },
        },
        include: { syncJob: true },
      });
      const config = {
        get: (key: string) =>
          key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      } as ConfigService;
      const liveAdvertising = new AdvertisingService(
        prisma,
        config,
        bullQueue!,
      );
      await liveAdvertising.prepareSync(conversion.id);
      const syncJobId = conversion.syncJob!.id;
      for (let index = 1; index < 5; index++) {
        await bullQueue!.add(
          'conversion',
          { syncJobId },
          { jobId: `synthetic-duplicate-${suffix}-${index}` },
        );
      }
      const dataManager = new GoogleDataManagerService(prisma, config);
      const accessToken = jest
        .spyOn(
          dataManager as unknown as { accessToken: () => Promise<string> },
          'accessToken',
        )
        .mockResolvedValue('synthetic-token');
      const post = jest.spyOn(axios, 'post').mockResolvedValue({
        data: { requestId: 'synthetic-five-worker-validation' },
      });
      const processor = new AdvertisingProcessor(
        dataManager,
        {} as GoogleAdsReportingService,
        bullQueue!,
        liveAdvertising,
      );
      const process = jest.fn((job: Job<AdvertisingSyncJobData>) =>
        processor.process(job),
      );
      const workers = Array.from(
        { length: 5 },
        () =>
          new Worker<AdvertisingSyncJobData>(bullQueue!.name, process, {
            connection: { host: redis.hostname, port: Number(redis.port) },
          }),
      );
      try {
        let drained = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const counts = await bullQueue!.getJobCounts('waiting', 'active');
          if (
            counts.waiting === 0 &&
            counts.active === 0 &&
            process.mock.calls.length === 5
          ) {
            drained = true;
            break;
          }
          await wait(25);
        }
        expect(drained).toBe(true);
        expect(process).toHaveBeenCalledTimes(5);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1]).toMatchObject({
          validateOnly: true,
          events: [{ transactionId: conversion.idempotencyKey }],
          destinations: [{ productDestinationId: '987654322' }],
        });
        expect(
          (
            await prisma.advertisingSyncJob.findUniqueOrThrow({
              where: { id: syncJobId },
            })
          ).status,
        ).toBe(AdvertisingSyncStatus.VALIDATED);
        expect(
          await prisma.advertisingSyncJob.count({
            where: { conversionId: conversion.id },
          }),
        ).toBe(1);
      } finally {
        await Promise.all(workers.map((worker) => worker.close()));
        post.mockRestore();
        accessToken.mockRestore();
      }
    },
    30_000,
  );
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  AdvertisingConsentChoice,
  AdvertisingEventType,
  AdvertisingSyncStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingService } from './advertising.service';
import {
  CreateContactIntentDto,
  UpdateAdvertisingIntegrationDto,
} from './dto/advertising.dto';

const consent = {
  adStorage: AdvertisingConsentChoice.DENIED,
  analyticsStorage: AdvertisingConsentChoice.GRANTED,
  adUserData: AdvertisingConsentChoice.GRANTED,
  adPersonalization: AdvertisingConsentChoice.DENIED,
  source: 'CMP',
  recordedAt: '2026-09-17T12:00:00.000Z',
};

function transactionalContactIntent(
  touchCreate: jest.Mock,
  conversionCreate: jest.Mock,
) {
  return {
    $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        advertisingTouch: { create: touchCreate },
        advertisingConversion: { create: conversionCreate },
      }),
    ),
  } as unknown as PrismaService;
}

describe('AdvertisingService', () => {
  it('reads advertising status without creating an integration', async () => {
    const prisma = {
      advertisingIntegration: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      advertisingConversionMapping: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      advertisingSyncJob: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      { get: jest.fn() } as unknown as ConfigService,
      {} as Queue,
    );
    await expect(service.getIntegrationStatus()).resolves.toMatchObject({
      conversionSyncEnabled: false,
      realSendsEnabled: false,
      mappings: [],
      syncCounts: [],
    });
    expect(prisma.advertisingIntegration.findUnique).toHaveBeenCalled();
    expect(prisma.advertisingIntegration.upsert).not.toHaveBeenCalled();
  });
  it('restores a missing diagnostics job for an already submitted request', async () => {
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sync-1',
          status: AdvertisingSyncStatus.SUBMITTED,
          googleRequestId: 'request-1',
          validateOnly: false,
        }),
      },
    };
    const queue = { getJob: jest.fn().mockResolvedValue(null), add: jest.fn() };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      queue as unknown as Queue,
    );
    await service.recoverDiagnostics('sync-1');
    expect(queue.add).toHaveBeenCalledWith(
      'diagnostics',
      { syncJobId: 'sync-1' },
      expect.objectContaining({ jobId: 'diagnostics-sync-1' }),
    );
  });
  it('resolves a concurrent unique collision to the same recorded event', async () => {
    const existing = {
      id: 'conversion-1',
      value: null,
      currency: null,
      commercialReference: null,
    };
    const prisma = {
      $transaction: jest.fn().mockRejectedValue({ code: 'P2002' }),
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as Queue,
    );
    const prepareSync = jest
      .spyOn(service, 'prepareSync')
      .mockResolvedValue(undefined);
    await expect(service.recordQualifiedLead('lead-1')).resolves.toBe(existing);
    expect(prepareSync).toHaveBeenCalledWith('conversion-1');
  });

  it('does not replace a terminal LOST stage with an operator WON event', async () => {
    const tx = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          contactId: 'contact-1',
          stage: 'LOST',
        }),
        update: jest.fn(),
      },
      advertisingAttribution: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      advertisingSyncJob: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const service = new AdvertisingService(
      {
        $transaction: jest.fn((callback) => callback(tx)),
      } as unknown as PrismaService,
      {} as ConfigService,
      {} as Queue,
    );
    await expect(
      service.recordOperatorEvent(
        'lead-1',
        {
          eventType: AdvertisingEventType.CONTRACT_WON,
          value: 100,
          currency: 'USD',
          commercialReference: 'contract-1',
        },
        'operator-1',
      ),
    ).rejects.toThrow();
    expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.NaN])(
    'rejects an operator WON event with nonpositive or invalid value %s',
    async (value) => {
      const prisma = { $transaction: jest.fn() };
      const service = new AdvertisingService(
        prisma as unknown as PrismaService,
        {} as ConfigService,
        {} as Queue,
      );
      await expect(
        service.recordOperatorEvent(
          'lead-1',
          {
            eventType: AdvertisingEventType.CONTRACT_WON,
            value,
            currency: 'USD',
            commercialReference: 'contract-1',
          },
          'operator-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects an operator WON event without a meaningful reference', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as Queue,
    );
    await expect(
      service.recordOperatorEvent(
        'lead-1',
        {
          eventType: AdvertisingEventType.CONTRACT_WON,
          value: 100,
          currency: 'USD',
          commercialReference: '   ',
        },
        'operator-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('keeps a recorded commercial milestone immutable on replay', async () => {
    const existing = {
      id: 'conversion-1',
      eventType: AdvertisingEventType.CONTRACT_WON,
      occurredAt: new Date('2026-09-20T12:00:00Z'),
      value: { toString: () => '100' },
      currency: 'USD',
      commercialReference: 'contract-1',
      source: 'CRM_OPERATOR',
      verifiedByUserId: 'operator-1',
    };
    const tx = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          contactId: 'contact-1',
          stage: 'WON',
        }),
        update: jest.fn(),
      },
      advertisingAttribution: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        update: jest.fn(),
      },
      advertisingSyncJob: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const service = new AdvertisingService(
      {
        $transaction: jest.fn((callback) => callback(tx)),
      } as unknown as PrismaService,
      {} as ConfigService,
      {} as Queue,
    );
    jest.spyOn(service, 'prepareSync').mockResolvedValue(undefined);
    await expect(
      service.recordOperatorEvent(
        'lead-1',
        {
          eventType: AdvertisingEventType.CONTRACT_WON,
          value: 200,
          currency: 'USD',
          commercialReference: 'contract-1',
        },
        'operator-1',
      ),
    ).rejects.toThrow();
    expect(tx.advertisingConversion.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes the sync intent inside the same transaction as a new qualified event', async () => {
    const tx = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead-1',
          contactId: 'contact-1',
          stage: 'QUALIFIED',
        }),
      },
      advertisingAttribution: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conversion-1' }),
      },
      advertisingSyncJob: {
        create: jest.fn().mockResolvedValue({ id: 'sync-1' }),
      },
      auditLog: { create: jest.fn() },
    };
    const service = new AdvertisingService(
      {
        $transaction: jest.fn((callback) => callback(tx)),
      } as unknown as PrismaService,
      { get: jest.fn().mockReturnValue('false') } as unknown as ConfigService,
      {} as Queue,
    );
    jest.spyOn(service, 'prepareSync').mockResolvedValue(undefined);
    await service.recordQualifiedLead(
      'lead-1',
      new Date('2026-09-20T12:00:00Z'),
    );
    expect(tx.advertisingSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversionId: 'conversion-1',
        status: 'PENDING',
        validateOnly: true,
      }),
    });
  });

  it('recovers a late attribution and queues the existing pending job', async () => {
    const touch = {
      id: 'touch-late',
      adUserData: AdvertisingConsentChoice.GRANTED,
    };
    const conversion = {
      id: 'conversion-late',
      leadId: 'lead-1',
      verified: true,
      eventType: AdvertisingEventType.LEAD_QUALIFIED,
      touch: null as typeof touch | null,
    };
    const job = { id: 'sync-late', status: 'PENDING' };
    const prisma = {
      advertisingConversion: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(conversion)),
        updateMany: jest.fn().mockImplementation(() => {
          conversion.touch = touch;
          return { count: 1 };
        }),
      },
      advertisingAttribution: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'attribution-late', touchId: touch.id }),
      },
      advertisingSyncJob: {
        upsert: jest.fn().mockResolvedValue(job),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: 'action-1',
          integration: {
            conversionSyncEnabled: true,
            accountId: '7181578237',
            loginAccountId: '1112223333',
            conversionCustomerId: '3394423093',
          },
        }),
      },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const config = {
      get: jest.fn((key: string) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      ),
    };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      queue as unknown as Queue,
    );
    await service.prepareSync('conversion-late');
    expect(prisma.advertisingConversion.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversion-late', touchId: null },
      data: { attributionId: 'attribution-late', touchId: 'touch-late' },
    });
    expect(prisma.advertisingSyncJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversionId: 'conversion-late' } }),
    );
    expect(prisma.advertisingSyncJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sync-late' }),
        data: {
          destinationSnapshot: {
            operatingAccountId: '3394423093',
            loginAccountId: '1112223333',
            conversionActionId: 'action-1',
          },
        },
      }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it.each([
    AdvertisingSyncStatus.FAILED,
    AdvertisingSyncStatus.SUBMITTED,
    AdvertisingSyncStatus.VALIDATED,
    AdvertisingSyncStatus.ACCEPTED,
    AdvertisingSyncStatus.CANCELLED,
  ])('never enqueues a %s sync job again', async (status) => {
    const prisma = {
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversion-terminal',
          leadId: 'lead-1',
          verified: true,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          touch: {
            id: 'touch-1',
            adUserData: AdvertisingConsentChoice.GRANTED,
          },
        }),
      },
      advertisingSyncJob: {
        upsert: jest.fn().mockResolvedValue({ id: 'sync-1', status }),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: 'action-1',
          integration: {
            conversionSyncEnabled: true,
            accountId: 'account-1',
            conversionCustomerId: '3394423093',
          },
        }),
      },
    };
    const queue = { add: jest.fn() };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      { get: jest.fn().mockReturnValue('true') } as unknown as ConfigService,
      queue as unknown as Queue,
    );
    await service.prepareSync('conversion-terminal');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not rewrite or enqueue an old child-account snapshot', async () => {
    const historicalSnapshot = {
      operatingAccountId: '7181578237',
      loginAccountId: '3394423093',
      conversionActionId: '7809705049',
    };
    const prisma = {
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversion-old',
          leadId: 'lead-1',
          verified: true,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          touch: { adUserData: AdvertisingConsentChoice.GRANTED },
        }),
      },
      advertisingSyncJob: {
        upsert: jest.fn().mockResolvedValue({
          id: 'sync-old',
          status: AdvertisingSyncStatus.PENDING,
          destinationSnapshot: historicalSnapshot,
        }),
        updateMany: jest.fn(),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: '7809705049',
          integration: {
            conversionSyncEnabled: true,
            accountId: '7181578237',
            conversionCustomerId: '3394423093',
          },
        }),
      },
    };
    const queue = { add: jest.fn() };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      { get: jest.fn(() => 'true') } as unknown as ConfigService,
      queue as unknown as Queue,
    );
    await service.prepareSync('conversion-old');
    expect(prisma.advertisingSyncJob.updateMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(historicalSnapshot.operatingAccountId).toBe('7181578237');
  });

  it.each(['accountId', 'loginAccountId', 'conversionCustomerId'])(
    'rejects a non-normalized %s in integration configuration',
    async (field) => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      const payload = {
        accountId: '7181578237',
        loginAccountId: '1112223333',
        conversionCustomerId: '3394423093',
        conversionSyncEnabled: false,
        metricsSyncEnabled: true,
        [field]: '339-442-3093',
      };
      await expect(
        pipe.transform(payload, {
          type: 'body',
          metatype: UpdateAdvertisingIntegrationDto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('claims a queued sync job atomically for one worker and rejects terminal replay', async () => {
    const status = { value: AdvertisingSyncStatus.QUEUED };
    const updateMany = jest
      .fn()
      .mockImplementation(
        ({
          where,
          data,
        }: {
          where: { status: AdvertisingSyncStatus };
          data: { status: AdvertisingSyncStatus };
        }) => {
          if (status.value !== where.status) return { count: 0 };
          status.value = data.status;
          return { count: 1 };
        },
      );
    const service = new AdvertisingService(
      { advertisingSyncJob: { updateMany } } as unknown as PrismaService,
      { get: jest.fn(() => 'true') } as unknown as ConfigService,
      {} as Queue,
    );
    const claimed = await Promise.all(
      Array.from({ length: 5 }, () => service.claimSyncJob('sync-1')),
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(status.value).toBe(AdvertisingSyncStatus.RETRYING);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sync-1', status: AdvertisingSyncStatus.QUEUED },
        data: expect.objectContaining({
          status: AdvertisingSyncStatus.RETRYING,
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
  });

  it('retries a failed BullMQ job instead of adding a second logical job', async () => {
    const prisma = {
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversion-1',
          leadId: 'lead-1',
          verified: true,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          touch: {
            id: 'touch-1',
            adUserData: AdvertisingConsentChoice.GRANTED,
          },
        }),
      },
      advertisingSyncJob: {
        upsert: jest.fn().mockResolvedValue({
          id: 'sync-1',
          status: AdvertisingSyncStatus.QUEUED,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: 'action-1',
          integration: {
            conversionSyncEnabled: true,
            accountId: 'account-1',
            conversionCustomerId: '3394423093',
          },
        }),
      },
    };
    const retry = jest.fn().mockResolvedValue(undefined);
    const queue = {
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue('failed'),
        retry,
      }),
      add: jest.fn(),
    };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      { get: jest.fn(() => 'true') } as unknown as ConfigService,
      queue as unknown as Queue,
    );
    await service.prepareSync('conversion-1');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('quarantines a completed queue job whose DB state is still nonterminal', async () => {
    const prisma = {
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversion-1',
          leadId: 'lead-1',
          verified: true,
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          touch: {
            id: 'touch-1',
            adUserData: AdvertisingConsentChoice.GRANTED,
          },
        }),
      },
      advertisingSyncJob: {
        upsert: jest.fn().mockResolvedValue({
          id: 'sync-1',
          status: AdvertisingSyncStatus.QUEUED,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: 'action-1',
          integration: {
            conversionSyncEnabled: true,
            accountId: 'account-1',
            conversionCustomerId: '3394423093',
          },
        }),
      },
    };
    const queue = {
      getJob: jest.fn().mockResolvedValue({
        getState: jest.fn().mockResolvedValue('completed'),
      }),
      add: jest.fn(),
    };
    const service = new AdvertisingService(
      prisma as unknown as PrismaService,
      { get: jest.fn(() => 'true') } as unknown as ConfigService,
      queue as unknown as Queue,
    );
    await service.prepareSync('conversion-1');
    expect(prisma.advertisingSyncJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'sync-1', status: AdvertisingSyncStatus.QUEUED },
      data: {
        status: AdvertisingSyncStatus.FAILED,
        errorCode: 'QUEUE_COMPLETED_UNRESOLVED',
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
  it.each([undefined, '2026-09-17T12:00:00.000Z'])(
    'accepts the existing contact-intent DTO with visit time %s',
    async (visitedAt) => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      });
      const result: CreateContactIntentDto = await pipe.transform(
        {
          gclid: 'Exact_Gclid-123',
          landingPage: 'https://undercodeec.com/servicios',
          ...(visitedAt ? { visitedAt } : {}),
          consent: { ...consent, adStorage: AdvertisingConsentChoice.GRANTED },
        },
        { type: 'body', metatype: CreateContactIntentDto },
      );
      expect(result).toBeInstanceOf(CreateContactIntentDto);
      expect(result.visitedAt).toBe(visitedAt);
      expect(result.gclid).toBe('Exact_Gclid-123');
    },
  );

  it('rejects an unsupported schema version at the strict DTO boundary', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        { schemaVersion: 3, consent },
        {
          type: 'body',
          metatype: CreateContactIntentDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts v2 first/last and persists only the independent last campaign as operational touch', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const input = {
      schemaVersion: 2,
      firstTouch: {
        gclid: 'A',
        utmId: 'ID_A',
        landingPage: 'https://undercodeec.com/',
        visitedAt: '2026-09-29T12:00:00Z',
      },
      lastTouch: {
        utmCampaign: 'beta',
        landingPage: 'https://undercodeec.com/servicios',
        visitedAt: '2026-09-29T12:01:00Z',
      },
      consent: { ...consent, adStorage: AdvertisingConsentChoice.GRANTED },
    };
    const dto = (await pipe.transform(input, {
      type: 'body',
      metatype: CreateContactIntentDto,
    })) as CreateContactIntentDto;
    const touchCreate = jest.fn(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'touch-v2',
        ...data,
      }),
    );
    const service = new AdvertisingService(
      transactionalContactIntent(touchCreate, jest.fn().mockResolvedValue({})),
      config,
      {} as Queue,
    );
    await service.createContactIntent(dto);
    const data = touchCreate.mock.calls[0][0].data;
    expect(data.gclid).toBeUndefined();
    expect(data.utmCampaign).toBe('beta');
    expect(data.metadata).toEqual({
      schemaVersion: 2,
      firstTouch: input.firstTouch,
    });
    expect(data.visitedAt).toEqual(new Date(input.lastTouch.visitedAt));
  });

  it('does not store v2 first/last advertising data when ad storage is denied', async () => {
    const touchCreate = jest.fn(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'touch-denied',
        ...data,
      }),
    );
    const service = new AdvertisingService(
      transactionalContactIntent(touchCreate, jest.fn().mockResolvedValue({})),
      config,
      {} as Queue,
    );
    await service.createContactIntent({
      schemaVersion: 2,
      firstTouch: { gclid: 'A', visitedAt: '2026-09-29T12:00:00Z' },
      lastTouch: { utmCampaign: 'beta', visitedAt: '2026-09-29T12:01:00Z' },
      consent,
    });
    const data = touchCreate.mock.calls[0][0].data;
    expect(data.gclid).toBeUndefined();
    expect(data.utmCampaign).toBeUndefined();
    expect(data.metadata).toBeUndefined();
  });

  it('rejects v2 fields without a version and a reversed first/last order', async () => {
    const service = new AdvertisingService(
      {} as PrismaService,
      config,
      {} as Queue,
    );
    const firstTouch = { gclid: 'A', visitedAt: '2026-09-29T12:02:00Z' };
    const lastTouch = { gclid: 'B', visitedAt: '2026-09-29T12:01:00Z' };
    await expect(
      service.createContactIntent({
        firstTouch,
        lastTouch,
        consent,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createContactIntent({
        schemaVersion: 2,
        firstTouch,
        lastTouch,
        consent,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createContactIntent({
        schemaVersion: 2,
        gclid: 'ambiguous',
        firstTouch: { ...lastTouch },
        lastTouch,
        consent,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'AD_ATTRIBUTION_REFERENCE_PEPPER') {
        return 'test-reference-pepper-at-least-32-characters';
      }
      return fallback;
    }),
  } as unknown as ConfigService;

  it('rolls back the touch when creating its click conversion fails', async () => {
    const touchCreate = jest.fn().mockResolvedValue({ id: 'touch-rollback' });
    const conversionCreate = jest
      .fn()
      .mockRejectedValue(new Error('conversion failed'));
    const transaction = jest.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          advertisingTouch: { create: touchCreate },
          advertisingConversion: { create: conversionCreate },
        }),
    );
    const service = new AdvertisingService(
      { $transaction: transaction } as unknown as PrismaService,
      config,
      {} as Queue,
    );

    await expect(service.createContactIntent({ consent })).rejects.toThrow(
      'conversion failed',
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(touchCreate).toHaveBeenCalledTimes(1);
    expect(conversionCreate).toHaveBeenCalledTimes(1);
  });

  it('creates an opaque reference and preserves click identifiers exactly', async () => {
    const touchCreate = jest.fn().mockImplementation(({ data }) => ({
      id: 'touch-1',
      ...data,
    }));
    const conversionCreate = jest.fn().mockResolvedValue({ id: 'event-1' });
    const prisma = transactionalContactIntent(touchCreate, conversionCreate);
    const service = new AdvertisingService(prisma, config, {} as Queue);

    const result = await service.createContactIntent({
      gclid: 'Exact_Gclid-123',
      utmCampaign: 'es-b2b',
      consent: { ...consent, adStorage: AdvertisingConsentChoice.GRANTED },
    });

    expect(result.reference).toMatch(/^UC-[A-Z2-7]{22}$/);
    expect(touchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gclid: 'Exact_Gclid-123',
        utmCampaign: 'es-b2b',
        referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        referenceLast4: result.reference.slice(-4),
      }),
    });
    expect(JSON.stringify(touchCreate.mock.calls)).not.toContain(
      result.reference,
    );
    expect(conversionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: AdvertisingEventType.WHATSAPP_CLICK,
        verified: false,
      }),
    });
  });

  it.each([
    AdvertisingConsentChoice.DENIED,
    AdvertisingConsentChoice.UNSPECIFIED,
  ])(
    'does not persist advertising identifiers with adStorage %s',
    async (adStorage) => {
      const touchCreate = jest.fn(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: 'touch-1',
          ...data,
        }),
      );
      const service = new AdvertisingService(
        transactionalContactIntent(
          touchCreate,
          jest.fn().mockResolvedValue({}),
        ),
        config,
        {} as Queue,
      );
      await service.createContactIntent({
        gclid: 'blocked-gclid',
        gbraid: 'blocked-gbraid',
        wbraid: 'blocked-wbraid',
        utmSource: 'blocked-source',
        utmMedium: 'blocked-medium',
        utmCampaign: 'blocked-campaign',
        utmContent: 'blocked-content',
        utmTerm: 'blocked-term',
        consent: { ...consent, adStorage },
      });
      const data = touchCreate.mock.calls[0][0].data;
      for (const field of [
        'gclid',
        'gbraid',
        'wbraid',
        'utmSource',
        'utmMedium',
        'utmCampaign',
        'utmContent',
        'utmTerm',
      ]) {
        expect(data[field]).toBeUndefined();
      }
      expect(data.adStorage).toBe(adStorage);
    },
  );

  it('keeps visit time separate from the click conversion time', async () => {
    const visitedAt = '2026-09-17T12:00:00.000Z';
    const touchCreate = jest.fn(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'touch-1',
        ...data,
      }),
    );
    const conversionCreate = jest.fn(
      ({ data }: { data: { occurredAt: Date } }) => Promise.resolve(data),
    );
    const service = new AdvertisingService(
      transactionalContactIntent(touchCreate, conversionCreate),
      config,
      {} as Queue,
    );
    await service.createContactIntent({ visitedAt, consent });
    expect(touchCreate.mock.calls[0][0].data.visitedAt).toEqual(
      new Date(visitedAt),
    );
    expect(
      conversionCreate.mock.calls[0][0].data.occurredAt.getTime(),
    ).toBeGreaterThan(Date.parse(visitedAt));
  });

  it('does not resolve a message with no exact reference', async () => {
    const service = new AdvertisingService(
      {} as PrismaService,
      config,
      {} as Queue,
    );
    await expect(
      service.claimReference({
        messageContent: 'Hola, eliminé la referencia',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('confirms a valid reference transactionally and creates one conversation event', async () => {
    const serviceForReference = new AdvertisingService(
      transactionalContactIntent(
        jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'touch-1', ...data })),
        jest.fn().mockResolvedValue({}),
      ),
      config,
      {} as Queue,
    );
    const issued = await serviceForReference.createContactIntent({ consent });

    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'attribution-1' }),
      },
      advertisingTouch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'touch-1',
          expiresAt: new Date(Date.now() + 60_000),
          useCount: 0,
          maxUses: 1,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findUnique: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'conversation-conversion-1' }),
      },
      advertisingSyncJob: {
        create: jest.fn().mockResolvedValue({ id: 'sync-1' }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Hola. Referencia: ${issued.reference}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'confirmed' });
    expect(tx.advertisingAttribution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'CONFIRMED',
        inboundMessageId: 'message-1',
      }),
    });
    expect(tx.advertisingConversion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: AdvertisingEventType.CONVERSATION_STARTED,
        idempotencyKey: 'conversation-started:lead-1',
      }),
    });
    expect(tx.advertisingSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversionId: 'conversation-conversion-1',
        status: AdvertisingSyncStatus.PENDING,
      }),
    });
  });

  it('does not attribute an expired reference', async () => {
    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: { findUnique: jest.fn().mockResolvedValue(null) },
      advertisingTouch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'touch-expired',
          expiresAt: new Date(Date.now() - 1),
          useCount: 0,
          maxUses: 1,
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Referencia: UC-${'A'.repeat(22)}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'expired' });
  });

  it.each([
    ['invalid', null, 'invalid'],
    [
      'already consumed by another contact',
      {
        id: 'touch-used',
        expiresAt: new Date(Date.now() + 60_000),
        useCount: 1,
        maxUses: 1,
      },
      'used',
    ],
  ])(
    'records a %s reference without creating attribution',
    async (_label, touch, status) => {
      const tx = {
        $executeRaw: jest.fn(),
        advertisingAttribution: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        advertisingTouch: {
          findUnique: jest.fn().mockResolvedValue(touch),
          update: jest.fn(),
        },
        advertisingConversion: { create: jest.fn() },
      };
      const service = new AdvertisingService(
        {
          $transaction: jest.fn((callback) => callback(tx)),
        } as unknown as PrismaService,
        config,
        {} as Queue,
      );
      await expect(
        service.claimReference({
          messageContent: `Referencia: UC-${'A'.repeat(22)}`,
          contactId: 'second-contact',
          conversationId: 'second-conversation',
          inboundMessageId: 'second-message',
        }),
      ).resolves.toEqual({ status });
      expect(tx.advertisingAttribution.create).not.toHaveBeenCalled();
      expect(tx.advertisingTouch.update).not.toHaveBeenCalled();
      expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
    },
  );

  it('treats a repeated inbound message as already confirmed', async () => {
    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: {
        findUnique: jest.fn().mockResolvedValue({ id: 'attribution-1' }),
      },
      advertisingTouch: { findUnique: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Referencia: UC-${'B'.repeat(22)}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'confirmed' });
    expect(tx.advertisingTouch.findUnique).not.toHaveBeenCalled();
  });
});

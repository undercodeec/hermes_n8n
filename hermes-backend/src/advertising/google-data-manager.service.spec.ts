/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { createHash } from 'crypto';
import axios, { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import {
  AdvertisingConsentChoice,
  AdvertisingEventType,
  AdvertisingSyncStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleDataManagerService } from './google-data-manager.service';

describe('GoogleDataManagerService', () => {
  afterEach(() => jest.restoreAllMocks());

  function readyJob(validateOnly = false) {
    const job = {
      id: 'sync-ready',
      status: AdvertisingSyncStatus.RETRYING,
      validateOnly,
      conversion: {
        eventType: AdvertisingEventType.LEAD_QUALIFIED,
        occurredAt: new Date('2026-09-17T12:00:00Z'),
        idempotencyKey: 'lead:1:LEAD_QUALIFIED',
        value: null,
        contact: null,
        touch: {
          gclid: 'gclid',
          gbraid: null,
          wbraid: null,
          adUserData: AdvertisingConsentChoice.GRANTED,
          adPersonalization: AdvertisingConsentChoice.DENIED,
        },
      },
    };
    const mapping = {
      exportEnabled: true,
      conversionActionId: '123',
      integration: { conversionSyncEnabled: true, accountId: '456' },
    };
    const settings = { sync: 'true', send: 'true', include: 'false' };
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(job)),
        update: jest.fn(),
      },
      advertisingConversionMapping: {
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(mapping)),
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED'
          ? settings.sync
          : key === 'ADVERTISING_GOOGLE_SEND_ENABLED'
            ? settings.send
            : key === 'ADVERTISING_GOOGLE_INCLUDE_USER_DATA'
              ? settings.include
              : undefined,
      ),
    };
    const service = new GoogleDataManagerService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
    return { job, mapping, settings, prisma, service };
  }

  it('sends a qualified lead without a monetary value', async () => {
    const { service, job } = readyJob(true);
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await service.ingest(job.id);
    const body = post.mock.calls[0][1] as { events: Record<string, unknown>[] };
    expect(body.events[0]).not.toHaveProperty('conversionValue');
    expect(body.events[0]).not.toHaveProperty('currency');
  });

  it.each([
    [null, 'USD', 'contract-1'],
    [new Prisma.Decimal(0), 'USD', 'contract-1'],
    [new Prisma.Decimal(100), null, 'contract-1'],
    [new Prisma.Decimal(100), 'USD', '  '],
  ])(
    'blocks incomplete WON value data before HTTP',
    async (value, currency, commercialReference) => {
      const { service, prisma, job } = readyJob(true);
      prisma.advertisingSyncJob.findUnique.mockResolvedValue({
        ...job,
        conversion: {
          ...job.conversion,
          eventType: AdvertisingEventType.CONTRACT_WON,
          value,
          currency,
          commercialReference,
        },
      });
      const post = jest.spyOn(axios, 'post');
      await expect(service.ingest(job.id)).rejects.toMatchObject({
        code: 'INVALID_COMMERCIAL_VALUE',
        transient: false,
      });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('uses the real stored WON amount and currency in validateOnly', async () => {
    const { service, prisma, job } = readyJob(true);
    prisma.advertisingSyncJob.findUnique.mockResolvedValue({
      ...job,
      conversion: {
        ...job.conversion,
        eventType: AdvertisingEventType.CONTRACT_WON,
        idempotencyKey: 'lead:synthetic-1:CONTRACT_WON',
        value: new Prisma.Decimal(100),
        currency: 'USD',
        commercialReference: 'synthetic-contract-1',
      },
    });
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await service.ingest(job.id);
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        validateOnly: true,
        events: [
          expect.objectContaining({
            transactionId: 'lead:synthetic-1:CONTRACT_WON',
            conversionValue: 100,
            currency: 'USD',
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it('hashes the existing international WhatsApp phone only with the user-data flag', async () => {
    const { service, prisma, job, settings } = readyJob(true);
    const contact = {
      email: null,
      phone: '593999739534',
      waId: '593999739534',
    };
    prisma.advertisingSyncJob.findUnique.mockResolvedValue({
      ...job,
      conversion: { ...job.conversion, contact },
    });
    settings.include = 'true';
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await service.ingest(job.id);
    const hash = createHash('sha256')
      .update('+593999739534')
      .digest('hex')
      .toUpperCase();
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        encoding: 'HEX',
        events: [
          expect.objectContaining({
            userData: {
              userIdentifiers: [{ phoneNumber: hash }],
            },
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it('does not infer an international phone from arbitrary CRM digits', async () => {
    const { service, prisma, job, settings } = readyJob(true);
    prisma.advertisingSyncJob.findUnique.mockResolvedValue({
      ...job,
      conversion: {
        ...job.conversion,
        contact: { email: null, phone: '0999739534', waId: '593999739534' },
      },
    });
    settings.include = 'true';
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await service.ingest(job.id);
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        events: [expect.not.objectContaining({ userData: expect.anything() })],
      }),
      expect.any(Object),
    );
  });

  it.each(['mapping', 'integration', 'consent', 'sync'] as const)(
    'blocks an old job when %s is disabled or revoked',
    async (condition) => {
      const { job, mapping, settings, service } = readyJob();
      if (condition === 'mapping') mapping.exportEnabled = false;
      if (condition === 'integration')
        mapping.integration.conversionSyncEnabled = false;
      if (condition === 'consent')
        job.conversion.touch.adUserData = AdvertisingConsentChoice.DENIED;
      if (condition === 'sync') settings.sync = 'false';
      const post = jest.spyOn(axios, 'post');
      const expectedCode =
        condition === 'mapping'
          ? 'NOT_ELIGIBLE'
          : condition === 'consent'
            ? 'DENIED_CONSENT'
            : 'RUNTIME_STOP';
      await expect(service.ingest(job.id)).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('checks the switches again after token retrieval and before HTTP', async () => {
    const { service, settings } = readyJob();
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockImplementation(() => {
        settings.send = 'false';
        return Promise.resolve('token');
      }),
    });
    const post = jest.spyOn(axios, 'post');
    await expect(service.ingest('sync-ready')).rejects.toMatchObject({
      code: 'RUNTIME_STOP',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('blocks consent revoked while acquiring the token', async () => {
    const { service, job } = readyJob();
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockImplementation(() => {
        job.conversion.touch.adUserData = AdvertisingConsentChoice.DENIED;
        return Promise.resolve('token');
      }),
    });
    const post = jest.spyOn(axios, 'post');
    await expect(service.ingest(job.id)).rejects.toMatchObject({
      code: 'RUNTIME_STOP',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP_400', 400, false],
    ['HTTP_401', 401, false],
    ['HTTP_403', 403, false],
    ['HTTP_429', 429, true],
    ['HTTP_503', 503, true],
    ['ECONNRESET', undefined, true],
    ['ETIMEDOUT', undefined, true],
  ])(
    'classifies %s without dropping the job',
    async (expectedCode, status, transient) => {
      const { service, prisma } = readyJob();
      Object.defineProperty(service, 'accessToken', {
        value: jest.fn().mockResolvedValue('token'),
      });
      const failure = Object.assign(new AxiosError('Google request failed'), {
        code: status === undefined ? expectedCode : undefined,
        response: status === undefined ? undefined : { status },
      });
      jest.spyOn(axios, 'post').mockRejectedValue(failure);
      await expect(service.ingest('sync-ready')).rejects.toMatchObject({
        code: expectedCode,
        transient,
      });
      expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: transient
              ? AdvertisingSyncStatus.RETRYING
              : AdvertisingSyncStatus.FAILED,
            errorCode: expectedCode,
          }),
        }),
      );
    },
  );

  it('does not turn a diagnostics HTTP failure into a conversion retry', async () => {
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sync-submitted',
          status: AdvertisingSyncStatus.SUBMITTED,
          googleRequestId: 'request-1',
          validateOnly: false,
        }),
        update: jest.fn(),
      },
    };
    const service = new GoogleDataManagerService(
      prisma as unknown as PrismaService,
      { get: jest.fn() } as unknown as ConfigService,
    );
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    jest.spyOn(axios, 'get').mockRejectedValue(
      Object.assign(new AxiosError('Unavailable'), {
        response: { status: 503 },
      }),
    );
    await expect(service.diagnose('sync-submitted')).rejects.toMatchObject({
      code: 'HTTP_503',
      transient: true,
    });
    expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          status: AdvertisingSyncStatus.RETRYING,
        }),
      }),
    );
  });

  it('quarantines HTTP success without a request ID for a real upload', async () => {
    const { service, prisma } = readyJob();
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await expect(service.ingest('sync-ready')).rejects.toMatchObject({
      code: 'MISSING_REQUEST_ID',
      transient: false,
    });
    expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AdvertisingSyncStatus.FAILED,
          errorCode: 'MISSING_REQUEST_ID',
        }),
      }),
    );
  });

  it('preserves field warnings while recording a submitted real request', async () => {
    const { service, prisma } = readyJob();
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const fieldWarnings = [
      { field: 'events[0].adIdentifiers', reason: 'TEST_WARNING' },
    ];
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        requestId: 'request-1',
        fieldWarnings,
      },
    });
    await expect(service.ingest('sync-ready')).resolves.toEqual({
      requestId: 'request-1',
      validateOnly: false,
    });
    expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AdvertisingSyncStatus.SUBMITTED,
          warnings: fieldWarnings,
        }),
      }),
    );
  });

  it.each([
    [['PROCESSING'], AdvertisingSyncStatus.SUBMITTED],
    [['SUCCESS'], AdvertisingSyncStatus.ACCEPTED],
    [['PARTIAL_SUCCESS'], AdvertisingSyncStatus.PARTIAL],
    [['FAILED'], AdvertisingSyncStatus.FAILED],
    [['SUCCESS', 'FAILED'], AdvertisingSyncStatus.FAILED],
  ])(
    'maps diagnostics %p to %s without reingesting',
    async (statuses, expected) => {
      const prisma = {
        advertisingSyncJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'sync-submitted',
            status: AdvertisingSyncStatus.SUBMITTED,
            googleRequestId: 'request-1',
            validateOnly: false,
          }),
          update: jest.fn(),
        },
      };
      const service = new GoogleDataManagerService(
        prisma as unknown as PrismaService,
        { get: jest.fn() } as unknown as ConfigService,
      );
      Object.defineProperty(service, 'accessToken', {
        value: jest.fn().mockResolvedValue('token'),
      });
      const post = jest.spyOn(axios, 'post');
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: {
          requestStatusPerDestination: statuses.map((requestStatus) => ({
            requestStatus,
          })),
        },
      });
      await expect(service.diagnose('sync-submitted')).resolves.toBe(expected);
      expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expected }),
        }),
      );
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([
    AdvertisingSyncStatus.VALIDATED,
    AdvertisingSyncStatus.ACCEPTED,
    AdvertisingSyncStatus.CANCELLED,
  ])('does not ingest terminal job %s on replay', async (status) => {
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'sync-terminal', status }),
      },
      advertisingConversionMapping: { findUnique: jest.fn() },
    };
    const post = jest.spyOn(axios, 'post');
    const service = new GoogleDataManagerService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
    );
    await expect(service.ingest('sync-terminal')).rejects.toMatchObject({
      code: 'TERMINAL_JOB',
      transient: false,
    });
    expect(
      prisma.advertisingConversionMapping.findUnique,
    ).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('uses Data Manager ingest with stable transaction id and validateOnly', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sync-1',
          validateOnly: true,
          status: AdvertisingSyncStatus.QUEUED,
          destinationSnapshot: {
            operatingAccountId: 'snapshot-account',
            loginAccountId: 'snapshot-login',
            conversionActionId: 'snapshot-action',
          },
          conversion: {
            eventType: AdvertisingEventType.LEAD_QUALIFIED,
            occurredAt: new Date('2026-09-17T12:00:00.000Z'),
            idempotencyKey: 'lead:lead-1:LEAD_QUALIFIED',
            value: new Prisma.Decimal(25),
            currency: 'EUR',
            contact: null,
            touch: {
              gclid: 'exact-gclid',
              gbraid: null,
              wbraid: null,
              adUserData: AdvertisingConsentChoice.GRANTED,
              adPersonalization: AdvertisingConsentChoice.DENIED,
            },
          },
        }),
        update,
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          eventType: AdvertisingEventType.LEAD_QUALIFIED,
          conversionActionId: '123456789',
          exportEnabled: true,
          integration: {
            conversionSyncEnabled: true,
            accountId: '1112223333',
            loginAccountId: '9998887777',
          },
        }),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : fallback,
      ),
    } as unknown as ConfigService;
    const service = new GoogleDataManagerService(prisma, config);
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { requestId: 'google-request-1' },
    });

    await expect(service.ingest('sync-1')).resolves.toEqual({
      requestId: 'google-request-1',
      validateOnly: true,
    });
    expect(post).toHaveBeenCalledWith(
      'https://datamanager.googleapis.com/v1/events:ingest',
      expect.objectContaining({
        validateOnly: true,
        destinations: [
          {
            operatingAccount: {
              accountType: 'GOOGLE_ADS',
              accountId: 'snapshot-account',
            },
            loginAccount: {
              accountType: 'GOOGLE_ADS',
              accountId: 'snapshot-login',
            },
            productDestinationId: 'snapshot-action',
          },
        ],
        events: [
          expect.objectContaining({
            transactionId: 'lead:lead-1:LEAD_QUALIFIED',
            adIdentifiers: { gclid: 'exact-gclid' },
            eventTimestamp: '2026-09-17T12:00:00.000Z',
          }),
        ],
      }),
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      }),
    );
    const body = post.mock.calls[0][1] as { events: Record<string, unknown>[] };
    expect(body.events[0]).not.toHaveProperty('conversionValue');
    expect(body.events[0]).not.toHaveProperty('currency');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'sync-1' },
      data: expect.objectContaining({
        status: AdvertisingSyncStatus.VALIDATED,
        googleRequestId: 'google-request-1',
      }),
    });
  });

  it('stops an old real-send job when the current send switch is off', async () => {
    const job = {
      id: 'sync-real',
      status: AdvertisingSyncStatus.RETRYING,
      validateOnly: false,
      conversion: {
        eventType: AdvertisingEventType.LEAD_QUALIFIED,
        occurredAt: new Date(),
        idempotencyKey: 'lead:1:LEAD_QUALIFIED',
        value: null,
        contact: null,
        touch: {
          gclid: 'gclid',
          gbraid: null,
          wbraid: null,
          adUserData: AdvertisingConsentChoice.GRANTED,
          adPersonalization: AdvertisingConsentChoice.DENIED,
        },
      },
    };
    const mapping = {
      exportEnabled: true,
      conversionActionId: '123',
      integration: { conversionSyncEnabled: true, accountId: '456' },
    };
    const prisma = {
      advertisingSyncJob: { findUnique: jest.fn().mockResolvedValue(job) },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue(mapping),
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
      ),
    };
    const service = new GoogleDataManagerService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    const post = jest.spyOn(axios, 'post');
    await expect(service.ingest('sync-real')).rejects.toMatchObject({
      code: 'RUNTIME_STOP',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('accepts an empty validateOnly response without fabricating a request ID', async () => {
    const job = {
      id: 'sync-dry',
      status: AdvertisingSyncStatus.RETRYING,
      validateOnly: true,
      conversion: {
        eventType: AdvertisingEventType.LEAD_QUALIFIED,
        occurredAt: new Date(),
        idempotencyKey: 'lead:1:LEAD_QUALIFIED',
        value: null,
        contact: null,
        touch: {
          gclid: 'gclid',
          gbraid: null,
          wbraid: null,
          adUserData: AdvertisingConsentChoice.GRANTED,
          adPersonalization: AdvertisingConsentChoice.DENIED,
        },
      },
    };
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        update: jest.fn(),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue({
          exportEnabled: true,
          conversionActionId: '123',
          integration: { conversionSyncEnabled: true, accountId: '456' },
        }),
      },
    };
    const service = new GoogleDataManagerService(
      prisma as unknown as PrismaService,
      {
        get: jest.fn((key: string) =>
          key === 'ADVERTISING_GOOGLE_SYNC_ENABLED' ? 'true' : 'false',
        ),
      } as unknown as ConfigService,
    );
    Object.defineProperty(service, 'accessToken', {
      value: jest.fn().mockResolvedValue('token'),
    });
    jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await expect(service.ingest('sync-dry')).resolves.toEqual({
      requestId: null,
      validateOnly: true,
    });
    expect(prisma.advertisingSyncJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AdvertisingSyncStatus.VALIDATED,
          googleRequestId: null,
        }),
      }),
    );
  });
});

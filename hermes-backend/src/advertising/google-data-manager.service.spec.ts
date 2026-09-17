/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import axios from 'axios';
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

  it('uses Data Manager ingest with stable transaction id and validateOnly', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      advertisingSyncJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sync-1',
          validateOnly: true,
          status: AdvertisingSyncStatus.QUEUED,
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
            accountId: '1112223333',
            loginAccountId: '9998887777',
          },
        }),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
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
    expect(update).toHaveBeenCalledWith({
      where: { id: 'sync-1' },
      data: expect.objectContaining({
        status: AdvertisingSyncStatus.VALIDATED,
        googleRequestId: 'google-request-1',
      }),
    });
  });
});

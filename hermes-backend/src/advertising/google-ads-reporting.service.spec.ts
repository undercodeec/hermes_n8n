/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingSyncJobData } from './advertising.constants';
import { GoogleAdsReportingService } from './google-ads-reporting.service';

describe('GoogleAdsReportingService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses ADC and does not send a deprecated developer-token header', async () => {
    const prisma = {
      advertisingIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          accountId: '718-157-8237',
          loginAccountId: '339-442-3093',
          metricsSyncEnabled: true,
          accountCurrency: 'EUR',
          accountTimeZone: 'Europe/Madrid',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      advertisingDailyMetric: { upsert: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'ADVERTISING_GOOGLE_METRICS_ENABLED' ? 'true' : fallback,
      ),
    } as unknown as ConfigService;
    const service = new GoogleAdsReportingService(
      prisma,
      config,
      {} as unknown as Queue<AdvertisingSyncJobData>,
    );
    const auth = (
      service as unknown as {
        auth: { getClient: jest.Mock };
      }
    ).auth;
    auth.getClient = jest.fn().mockResolvedValue({
      getAccessToken: jest.fn().mockResolvedValue({ token: 'adc-token' }),
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: [] });

    await expect(service.sync('2026-09-01', '2026-09-02')).resolves.toEqual({
      synchronizedRows: 0,
      from: '2026-09-01',
      to: '2026-09-02',
    });

    expect(post).toHaveBeenCalledWith(
      'https://googleads.googleapis.com/v25/customers/7181578237/googleAds:searchStream',
      expect.objectContaining({
        query: expect.stringContaining('FROM campaign'),
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer adc-token',
          'login-customer-id': '3394423093',
        },
      }),
    );
    expect(post.mock.calls[0][2]?.headers).not.toHaveProperty(
      'developer-token',
    );
  });
});

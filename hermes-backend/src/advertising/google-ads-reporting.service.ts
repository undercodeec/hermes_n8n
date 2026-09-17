import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import axios from 'axios';
import { Queue } from 'bullmq';
import { GoogleAuth } from 'google-auth-library';
import { AdvertisingProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADVERTISING_QUEUE,
  AdvertisingSyncJobData,
} from './advertising.constants';

interface GoogleAdsRow {
  customer?: { currencyCode?: string; timeZone?: string };
  campaign?: { id?: string; name?: string; status?: string };
  segments?: { date?: string };
  metrics?: { impressions?: string; clicks?: string; costMicros?: string };
}

interface GoogleAdsBatch {
  results?: GoogleAdsRow[];
}

@Injectable()
export class GoogleAdsReportingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GoogleAdsReportingService.name);
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/adwords'],
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(ADVERTISING_QUEUE)
    private readonly queue: Queue<AdvertisingSyncJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (
      this.config.get<string>('ADVERTISING_GOOGLE_METRICS_ENABLED') !== 'true'
    ) {
      return;
    }
    const every = Math.max(
      3_600_000,
      Number(
        this.config.get('ADVERTISING_METRICS_SYNC_INTERVAL_MS') || 21600000,
      ),
    );
    try {
      await this.queue.add(
        'metrics',
        {},
        { jobId: 'scheduled-google-ads-metrics', repeat: { every } },
      );
    } catch (error) {
      this.logger.warn(
        `Could not schedule Google Ads metrics: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async syncRecent() {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    return this.sync(this.formatDate(start), this.formatDate(end));
  }

  async sync(from: string, to: string) {
    this.assertDateRange(from, to);
    const integration = await this.prisma.advertisingIntegration.findUnique({
      where: { provider: AdvertisingProvider.GOOGLE_ADS },
    });
    if (!integration?.metricsSyncEnabled || !integration.accountId) {
      throw new ServiceUnavailableException(
        'Google Ads metrics are pending connection',
      );
    }
    if (
      this.config.get<string>('ADVERTISING_GOOGLE_METRICS_ENABLED') !== 'true'
    ) {
      throw new ServiceUnavailableException(
        'Google Ads metrics synchronization is disabled',
      );
    }
    const customerId = integration.accountId.replace(/-/g, '');
    const version = this.config.get<string>('GOOGLE_ADS_API_VERSION', 'v25');
    const query = `
      SELECT
        customer.currency_code,
        customer.time_zone,
        campaign.id,
        campaign.name,
        campaign.status,
        segments.date,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'
    `;
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token)
      throw new ServiceUnavailableException('Google authentication failed');
    const response = await axios.post<GoogleAdsBatch[]>(
      `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`,
      { query },
      {
        timeout: Number(this.config.get('GOOGLE_API_TIMEOUT_MS') || 15000),
        headers: {
          Authorization: `Bearer ${token.token}`,
          ...(integration.loginAccountId
            ? {
                'login-customer-id': integration.loginAccountId.replace(
                  /-/g,
                  '',
                ),
              }
            : {}),
        },
      },
    );
    const rows = response.data.flatMap((batch) => batch.results || []);
    for (const row of rows) {
      if (!row.campaign?.id || !row.segments?.date) continue;
      await this.prisma.advertisingDailyMetric.upsert({
        where: {
          integrationId_campaignId_metricDate: {
            integrationId: integration.id,
            campaignId: row.campaign.id,
            metricDate: new Date(`${row.segments.date}T00:00:00.000Z`),
          },
        },
        create: {
          integrationId: integration.id,
          campaignId: row.campaign.id,
          campaignName: row.campaign.name || row.campaign.id,
          campaignStatus: row.campaign.status || 'UNKNOWN',
          metricDate: new Date(`${row.segments.date}T00:00:00.000Z`),
          impressions: BigInt(row.metrics?.impressions || '0'),
          clicks: BigInt(row.metrics?.clicks || '0'),
          costMicros: BigInt(row.metrics?.costMicros || '0'),
          currency:
            row.customer?.currencyCode || integration.accountCurrency || 'EUR',
          accountTimeZone:
            row.customer?.timeZone || integration.accountTimeZone || 'UTC',
        },
        update: {
          campaignName: row.campaign.name || row.campaign.id,
          campaignStatus: row.campaign.status || 'UNKNOWN',
          impressions: BigInt(row.metrics?.impressions || '0'),
          clicks: BigInt(row.metrics?.clicks || '0'),
          costMicros: BigInt(row.metrics?.costMicros || '0'),
          currency:
            row.customer?.currencyCode || integration.accountCurrency || 'EUR',
          accountTimeZone:
            row.customer?.timeZone || integration.accountTimeZone || 'UTC',
          syncedAt: new Date(),
        },
      });
    }
    const first = rows[0];
    await this.prisma.advertisingIntegration.update({
      where: { id: integration.id },
      data: {
        lastMetricsSyncAt: new Date(),
        accountCurrency:
          first?.customer?.currencyCode || integration.accountCurrency,
        accountTimeZone:
          first?.customer?.timeZone || integration.accountTimeZone,
      },
    });
    return { synchronizedRows: rows.length, from, to };
  }

  async list(from: string, to: string) {
    this.assertDateRange(from, to);
    const integration = await this.prisma.advertisingIntegration.findUnique({
      where: { provider: AdvertisingProvider.GOOGLE_ADS },
    });
    if (!integration) return [];
    const rows = await this.prisma.advertisingDailyMetric.findMany({
      where: {
        integrationId: integration.id,
        metricDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      orderBy: [{ metricDate: 'desc' }, { campaignName: 'asc' }],
    });
    return rows.map((row) => ({
      ...row,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      costMicros: Number(row.costMicros),
      cost: Number(row.costMicros) / 1_000_000,
    }));
  }

  private assertDateRange(from: string, to: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Dates must use YYYY-MM-DD');
    }
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (!Number.isFinite(days) || days < 0 || days > 93) {
      throw new BadRequestException('Date range must be between 0 and 93 days');
    }
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}

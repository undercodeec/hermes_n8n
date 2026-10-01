import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AdvertisingSyncStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingService } from './advertising.service';

@Injectable()
export class AdvertisingReconciliationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AdvertisingReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private conversionCursor?: string;
  private jobCursor?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly advertising: AdvertisingService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.scan(), 10_000);
    this.timer.unref();
    void this.scan();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const conversionWhere: Prisma.AdvertisingConversionWhereInput = {
        verified: true,
        leadId: { not: null },
        syncJob: { is: null },
        ...(this.conversionCursor ? { id: { gt: this.conversionCursor } } : {}),
      };
      const conversions = await this.prisma.advertisingConversion.findMany({
        where: conversionWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 50,
      });
      this.conversionCursor = conversions.at(-1)?.id;
      for (const conversion of conversions) {
        try {
          await this.advertising.prepareSync(conversion.id);
        } catch (error) {
          this.logger.warn(
            `Conversion reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const jobWhere: Prisma.AdvertisingSyncJobWhereInput = {
        status: {
          in: [
            AdvertisingSyncStatus.PENDING,
            AdvertisingSyncStatus.QUEUED,
            AdvertisingSyncStatus.RETRYING,
            AdvertisingSyncStatus.SUBMITTED,
          ],
        },
        ...(this.jobCursor ? { id: { gt: this.jobCursor } } : {}),
      };
      const jobs = await this.prisma.advertisingSyncJob.findMany({
        where: jobWhere,
        select: { id: true, conversionId: true, status: true },
        orderBy: { id: 'asc' },
        take: 50,
      });
      this.jobCursor = jobs.at(-1)?.id;
      for (const job of jobs) {
        try {
          if (job.status === AdvertisingSyncStatus.SUBMITTED) {
            await this.advertising.recoverDiagnostics(job.id);
          } else {
            await this.advertising.prepareSync(job.conversionId);
          }
        } catch (error) {
          this.logger.warn(
            `Sync job reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Advertising reconciliation scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
  }
}

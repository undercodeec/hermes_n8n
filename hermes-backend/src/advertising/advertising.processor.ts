import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AdvertisingSyncStatus } from '@prisma/client';
import {
  ADVERTISING_QUEUE,
  AdvertisingSyncJobData,
} from './advertising.constants';
import {
  GoogleDataManagerService,
  GoogleSyncError,
} from './google-data-manager.service';
import { GoogleAdsReportingService } from './google-ads-reporting.service';

@Processor(ADVERTISING_QUEUE)
export class AdvertisingProcessor extends WorkerHost {
  private readonly logger = new Logger(AdvertisingProcessor.name);

  constructor(
    private readonly dataManager: GoogleDataManagerService,
    private readonly reporting: GoogleAdsReportingService,
    @InjectQueue(ADVERTISING_QUEUE)
    private readonly queue: Queue<AdvertisingSyncJobData>,
  ) {
    super();
  }

  async process(job: Job<AdvertisingSyncJobData>): Promise<void> {
    try {
      if (job.name === 'metrics') {
        await this.reporting.syncRecent();
        return;
      }
      if (!job.data.syncJobId) {
        throw new GoogleSyncError('Missing sync job id', false, 'INVALID_JOB');
      }
      if (job.name === 'diagnostics') {
        const status = await this.dataManager.diagnose(job.data.syncJobId);
        if (status === AdvertisingSyncStatus.SUBMITTED) {
          throw new Error('Google diagnostics are still processing');
        }
        return;
      }
      const result = await this.dataManager.ingest(job.data.syncJobId);
      if (!result.validateOnly) {
        await this.queue.add(
          'diagnostics',
          { syncJobId: job.data.syncJobId },
          {
            jobId: `diagnostics-${job.data.syncJobId}`,
            delay: 30_000,
            attempts: 8,
            backoff: { type: 'exponential', delay: 30_000 },
          },
        );
      }
    } catch (error) {
      if (error instanceof GoogleSyncError && !error.transient) {
        this.logger.warn(
          `Google sync stopped: ${error.code || 'permanent error'}`,
        );
        return;
      }
      throw error;
    }
  }
}

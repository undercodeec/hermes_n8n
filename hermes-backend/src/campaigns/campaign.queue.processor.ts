import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CAMPAIGN_QUEUE } from './campaigns.constants';
import { CampaignJobData, CampaignsService } from './campaigns.service';

@Processor(CAMPAIGN_QUEUE)
export class CampaignQueueProcessor extends WorkerHost {
  constructor(private readonly campaigns: CampaignsService) { super(); }
  async process(job: Job<CampaignJobData>): Promise<void> { await this.campaigns.processSendJob(job.data); }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<CampaignJobData> | undefined, error: Error): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;
    await this.campaigns.markRetryExhausted(job.data, error);
  }
}

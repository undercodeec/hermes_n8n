import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CAMPAIGN_QUEUE } from './campaigns.constants';
import { CampaignJobData, CampaignsService } from './campaigns.service';

@Processor(CAMPAIGN_QUEUE)
export class CampaignQueueProcessor extends WorkerHost {
  constructor(private readonly campaigns: CampaignsService) { super(); }
  async process(job: Job<CampaignJobData>): Promise<void> { await this.campaigns.processSendJob(job.data); }
}

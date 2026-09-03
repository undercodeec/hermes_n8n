import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignQueueProcessor } from './campaign.queue.processor';
import { CAMPAIGN_QUEUE } from './campaigns.constants';
import { MetaModule } from '../meta/meta.module';

@Module({
  imports: [
    MetaModule,
    BullModule.registerQueueAsync({
      name: CAMPAIGN_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limiter: { max: Math.max(1, Number(config.get('CAMPAIGN_SEND_RATE_PER_SECOND') || 2)), duration: 1000 },
        defaultJobOptions: { attempts: 4, backoff: { type: 'exponential', delay: 1500, jitter: 0.25 }, removeOnComplete: { age: 24 * 3600, count: 1000 }, removeOnFail: false },
      }),
    }),
  ],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignQueueProcessor],
  exports: [CampaignsService],
})
export class CampaignsModule {}

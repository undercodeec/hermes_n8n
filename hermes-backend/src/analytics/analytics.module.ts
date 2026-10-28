import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AcquisitionController } from '../attribution-crm/acquisition.controller';
import { AcquisitionService } from '../attribution-crm/acquisition.service';

@Module({
  imports: [CampaignsModule],
  controllers: [AnalyticsController, AcquisitionController],
  providers: [AnalyticsService, AcquisitionService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

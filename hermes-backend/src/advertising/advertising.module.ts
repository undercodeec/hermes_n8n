import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ADVERTISING_QUEUE } from './advertising.constants';
import {
  AdvertisingController,
  AttributionIntentsController,
} from './advertising.controller';
import { AdvertisingListener } from './advertising.listener';
import { AdvertisingProcessor } from './advertising.processor';
import { AdvertisingService } from './advertising.service';
import { AttributionRegistrationGuard } from './attribution-registration.guard';
import { GoogleAdsReportingService } from './google-ads-reporting.service';
import { GoogleDataManagerService } from './google-data-manager.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: ADVERTISING_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
        removeOnFail: false,
      },
    }),
  ],
  controllers: [AttributionIntentsController, AdvertisingController],
  providers: [
    AdvertisingService,
    AttributionRegistrationGuard,
    AdvertisingListener,
    AdvertisingProcessor,
    GoogleDataManagerService,
    GoogleAdsReportingService,
  ],
  exports: [AdvertisingService],
})
export class AdvertisingModule {}

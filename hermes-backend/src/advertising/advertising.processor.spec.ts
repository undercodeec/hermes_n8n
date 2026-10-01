import { Job, Queue } from 'bullmq';
import { AdvertisingService } from './advertising.service';
import { AdvertisingProcessor } from './advertising.processor';
import { AdvertisingSyncJobData } from './advertising.constants';
import { GoogleDataManagerService } from './google-data-manager.service';
import { GoogleAdsReportingService } from './google-ads-reporting.service';

describe('AdvertisingProcessor terminal replay guard', () => {
  const job = {
    name: 'conversion',
    data: { syncJobId: 'sync-1' },
  } as Job<AdvertisingSyncJobData>;

  it('does not call the gateway when another worker owns or finished the job', async () => {
    const ingest = jest.fn();
    const claimSyncJob = jest.fn().mockResolvedValue(false);
    const processor = new AdvertisingProcessor(
      { ingest } as unknown as GoogleDataManagerService,
      {} as GoogleAdsReportingService,
      {} as Queue<AdvertisingSyncJobData>,
      { claimSyncJob } as unknown as AdvertisingService,
    );
    await processor.process(job);
    expect(claimSyncJob).toHaveBeenCalledWith('sync-1');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('sends only after the durable claim succeeds', async () => {
    const ingest = jest.fn().mockResolvedValue({ validateOnly: true });
    const processor = new AdvertisingProcessor(
      { ingest } as unknown as GoogleDataManagerService,
      {} as GoogleAdsReportingService,
      {} as Queue<AdvertisingSyncJobData>,
      {
        claimSyncJob: jest.fn().mockResolvedValue(true),
      } as unknown as AdvertisingService,
    );
    await processor.process(job);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

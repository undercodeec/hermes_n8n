import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingService } from './advertising.service';
import { AdvertisingReconciliationService } from './advertising-reconciliation.service';

describe('AdvertisingReconciliationService', () => {
  it('recovers submitted diagnostics separately from conversion uploads', async () => {
    const prisma = {
      advertisingConversion: { findMany: jest.fn().mockResolvedValue([]) },
      advertisingSyncJob: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sync-submitted',
            conversionId: 'conversion-1',
            status: 'SUBMITTED',
          },
        ]),
      },
    };
    const prepareSync = jest.fn();
    const recoverDiagnostics = jest.fn().mockResolvedValue(undefined);
    const service = new AdvertisingReconciliationService(
      prisma as unknown as PrismaService,
      { prepareSync, recoverDiagnostics } as unknown as AdvertisingService,
    );
    await service.scan();
    expect(recoverDiagnostics).toHaveBeenCalledWith('sync-submitted');
    expect(prepareSync).not.toHaveBeenCalled();
  });
  it('recovers legacy conversions and pending jobs without calling a gateway', async () => {
    const prisma = {
      advertisingConversion: {
        findMany: jest.fn().mockResolvedValue([{ id: 'conversion-old' }]),
      },
      advertisingSyncJob: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'sync-pending', conversionId: 'conversion-pending' },
          ]),
      },
    };
    const prepareSync = jest.fn().mockResolvedValue(undefined);
    const service = new AdvertisingReconciliationService(
      prisma as unknown as PrismaService,
      { prepareSync } as unknown as AdvertisingService,
    );
    await service.scan();
    expect(prepareSync).toHaveBeenCalledWith('conversion-old');
    expect(prepareSync).toHaveBeenCalledWith('conversion-pending');
  });

  it('continues after one conversion fails and avoids overlapping scans', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prisma = {
      advertisingConversion: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'conversion-1' }, { id: 'conversion-2' }]),
      },
      advertisingSyncJob: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prepareSync = jest
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        throw new Error('Redis unavailable');
      })
      .mockResolvedValue(undefined);
    const service = new AdvertisingReconciliationService(
      prisma as unknown as PrismaService,
      { prepareSync } as unknown as AdvertisingService,
    );
    const first = service.scan();
    await service.scan();
    release();
    await first;
    expect(prisma.advertisingConversion.findMany).toHaveBeenCalledTimes(1);
    expect(prepareSync).toHaveBeenCalledTimes(2);
  });
});

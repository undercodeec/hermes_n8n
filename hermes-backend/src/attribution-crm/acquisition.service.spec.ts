import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AcquisitionService } from './acquisition.service';
import { AcquisitionController } from './acquisition.controller';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

describe('AcquisitionService', () => {
  it('requires the CRM JWT and authorized roles', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AcquisitionController,
    ) as UserRole[];
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AcquisitionController,
    ) as Array<{ name: string }>;
    expect(roles).toEqual([UserRole.ADMIN, UserRole.SALES_AGENT]);
    expect(guards.map((guard) => guard.name)).toEqual(
      expect.arrayContaining(['JwtAuthGuard', 'RolesGuard']),
    );
  });
  const prisma = { $queryRaw: jest.fn() } as unknown as PrismaService;
  const config = {
    get: jest.fn().mockReturnValue('0.02'),
  } as unknown as ConfigService;
  const service = new AcquisitionService(prisma, config);

  beforeEach(() => jest.clearAllMocks());

  it('uses Ecuador today when UTC has already advanced to the next day', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-29T02:00:00Z'));
    try {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      const result = await service.summary();
      expect(result.range).toEqual({ from: '2026-09-29', to: '2026-10-28' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects invalid and excessive Ecuador date ranges', async () => {
    await expect(
      service.summary('2026-10-31', '2026-10-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.summary('2025-01-01', '2026-10-28'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.summary('2026-02-30', '2026-03-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.summary(undefined, 'fecha-inválida'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aggregates origins, daily counts and ad IDs without inventing missing IDs or billing', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      {
        day: '2026-10-27',
        origin: 'meta_ad',
        adSourceId: 'ad-1',
        newConversations: 2n,
        inboundMessages: 4n,
        laterAdReferralMessages: 1n,
        qualifiedLeadsVerified: 1n,
        contractsWonVerified: 1n,
        contractsLostVerified: 0n,
        nousRequests: 2n,
      },
      {
        day: '2026-10-28',
        origin: 'unknown',
        adSourceId: null,
        newConversations: 1n,
        inboundMessages: 1n,
        laterAdReferralMessages: 0n,
        qualifiedLeadsVerified: 0n,
        contractsWonVerified: 0n,
        contractsLostVerified: 0n,
        nousRequests: 0n,
      },
    ]);
    const result = await service.summary('2026-10-27', '2026-10-28');
    expect(result.totals).toMatchObject({
      newConversations: 3,
      inboundMessages: 5,
      qualifiedLeadsVerified: 1,
      contractsWonVerified: 1,
      estimatedUsd: 0.04,
      billedUsd: null,
    });
    expect(result.byOrigin).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: 'unknown', newConversations: 1 }),
      ]),
    );
    expect(result.byAd).toEqual([
      expect.objectContaining({ sourceId: 'ad-1', newConversations: 2 }),
    ]);
    expect(result.daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026-10-28', unknown: 1 }),
      ]),
    );
  });
});

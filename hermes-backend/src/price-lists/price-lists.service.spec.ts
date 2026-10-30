import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePriceListDto } from './dto/update-price-list.dto';
import { PriceListsService } from './price-lists.service';

describe('PriceListsService', () => {
  it('clears an existing expiration when validUntil is null', async () => {
    type UpdateArgs = {
      where: { id: string };
      data: Prisma.PriceListUncheckedUpdateInput;
    };
    let capturedUpdateArgs: UpdateArgs | undefined;
    const priceList = {
      id: 'price-list-1',
      validUntil: new Date('2026-12-31T00:00:00.000Z'),
    };
    const priceListDelegate = {
      findUnique: jest.fn().mockResolvedValue(priceList),
      update: jest.fn((args: UpdateArgs) => {
        capturedUpdateArgs = args;
        return Promise.resolve({ ...priceList, validUntil: null });
      }),
    };
    const tx = { priceList: priceListDelegate, auditLog: { create: jest.fn() } };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaService;
    const service = new PriceListsService(prisma);
    const dto = { validUntil: null } as unknown as UpdatePriceListDto;

    await service.update('price-list-1', dto, 'admin-1');

    expect(capturedUpdateArgs?.data).toHaveProperty('validUntil', null);
  });

  it('leaves the expiration untouched when validUntil is omitted', async () => {
    type UpdateArgs = {
      where: { id: string };
      data: Prisma.PriceListUncheckedUpdateInput;
    };
    let capturedUpdateArgs: UpdateArgs | undefined;
    const priceList = {
      id: 'price-list-1',
      name: 'Precio general',
      validUntil: new Date('2026-12-31T00:00:00.000Z'),
    };
    const priceListDelegate = {
      findUnique: jest.fn().mockResolvedValue(priceList),
      update: jest.fn((args: UpdateArgs) => {
        capturedUpdateArgs = args;
        return Promise.resolve({ ...priceList, name: 'Precio actualizado' });
      }),
    };
    const tx = { priceList: priceListDelegate, auditLog: { create: jest.fn() } };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaService;
    const service = new PriceListsService(prisma);

    await service.update('price-list-1', { name: 'Precio actualizado' }, 'admin-1');

    expect(capturedUpdateArgs?.data).not.toHaveProperty('validUntil');
    expect(capturedUpdateArgs?.data).toHaveProperty(
      'name',
      'Precio actualizado',
    );
  });
});

describe('PriceListsService commercial audit', () => {
  const before = {
    id: 'promo-1', isPromotion: true, isActive: false,
    name: 'Oferta sintética', price: '80.00', product: { id: 'product-1' },
  };

  it('stores the administrator and before/after state in the same transaction', async () => {
    const tx = {
      priceList: {
        findUnique: jest.fn().mockResolvedValue(before),
        update: jest.fn().mockResolvedValue({ ...before, isActive: true }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    const service = new PriceListsService(prisma);

    await service.update('promo-1', { isActive: true }, 'admin-1');

    expect(tx.priceList.update).toHaveBeenCalledWith({ where: { id: 'promo-1' }, data: { isActive: true } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'admin-1', entity: 'price_lists', entityId: 'promo-1',
      action: 'PRICE_LIST_UPDATED',
      changes: expect.objectContaining({ before: { isActive: false }, after: { isActive: true }, result: 'SUCCESS' }),
    }) });
  });

  it('does not write audit history when the update fails', async () => {
    const tx = {
      priceList: {
        findUnique: jest.fn().mockResolvedValue(before),
        update: jest.fn().mockRejectedValue(new Error('write failed')),
      },
      auditLog: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    await expect(new PriceListsService(prisma).update('promo-1', { isActive: true }, 'admin-1')).rejects.toThrow('write failed');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns the last audit entry with the responsible user', async () => {
    const findMany = jest.fn().mockResolvedValue([{ createdAt: new Date('2026-10-30T12:00:00Z'), user: { name: 'Admin' } }]);
    const prisma = {
      priceList: { findUnique: jest.fn().mockResolvedValue(before) },
      auditLog: { findMany },
    } as unknown as PrismaService;
    const result = await new PriceListsService(prisma).audit('promo-1');
    expect(result).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { entity: 'price_lists', entityId: 'promo-1' },
      orderBy: { createdAt: 'desc' }, take: 10,
    }));
  });
});

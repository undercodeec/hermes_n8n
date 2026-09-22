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
    const prisma = {
      priceList: priceListDelegate,
    } as unknown as PrismaService;
    const service = new PriceListsService(prisma);
    const dto = { validUntil: null } as unknown as UpdatePriceListDto;

    await service.update('price-list-1', dto);

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
    const prisma = {
      priceList: priceListDelegate,
    } as unknown as PrismaService;
    const service = new PriceListsService(prisma);

    await service.update('price-list-1', { name: 'Precio actualizado' });

    expect(capturedUpdateArgs?.data).not.toHaveProperty('validUntil');
    expect(capturedUpdateArgs?.data).toHaveProperty(
      'name',
      'Precio actualizado',
    );
  });
});

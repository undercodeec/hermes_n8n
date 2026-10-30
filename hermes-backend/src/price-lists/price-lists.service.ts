import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpdatePriceListDto } from './dto/update-price-list.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class PriceListsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePriceListDto) {
    return this.prisma.priceList.create({
      data: {
        ...dto,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      },
      include: { product: true },
    });
  }

  async findAll(productId?: string) {
    const where = productId ? { productId } : {};
    return this.prisma.priceList.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { product: true },
    });
  }

  async findOne(id: string) {
    const priceList = await this.prisma.priceList.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!priceList)
      throw new NotFoundException('Lista de precios no encontrada');
    return priceList;
  }

  async audit(id: string) {
    await this.findOne(id);
    return this.prisma.auditLog.findMany({
      where: { entity: 'price_lists', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        action: true,
        changes: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async update(id: string, dto: UpdatePriceListDto, userId: string) {
    const { validFrom, validUntil, ...fields } = dto;
    const data: Prisma.PriceListUncheckedUpdateInput = {
      ...fields,
      ...(validFrom ? { validFrom: new Date(validFrom) } : {}),
      ...(validUntil === undefined
        ? {}
        : { validUntil: validUntil === null ? null : new Date(validUntil) }),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const previous = await tx.priceList.findUnique({ where: { id } });
            if (!previous)
              throw new NotFoundException('Lista de precios no encontrada');
            const saved = await tx.priceList.update({ where: { id }, data });
            const changedKeys = Object.keys(dto);
            const snapshot = (record: Record<string, unknown>) =>
              Object.fromEntries(
                changedKeys.map((key) => [key, record[key] ?? null]),
              );
            await tx.auditLog.create({
              data: {
                userId,
                action: 'PRICE_LIST_UPDATED',
                entity: 'price_lists',
                entityId: id,
                changes: JSON.parse(
                  JSON.stringify({
                    before: snapshot(previous),
                    after: snapshot(saved),
                    result: 'SUCCESS',
                  }),
                ) as Prisma.InputJsonValue,
              },
            });
            return saved;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if ((error as { code?: string })?.code !== 'P2034' || attempt === 2)
          throw error;
      }
    }
    throw new Error('No se pudo completar la actualización de tarifa');
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.priceList.delete({ where: { id } });
  }
}

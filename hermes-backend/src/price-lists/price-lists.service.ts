import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpdatePriceListDto } from './dto/update-price-list.dto';

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
    if (!priceList) throw new NotFoundException('Lista de precios no encontrada');
    return priceList;
  }

  async update(id: string, dto: UpdatePriceListDto) {
    await this.findOne(id);
    const data: any = { ...dto };
    if (dto.validFrom) data.validFrom = new Date(dto.validFrom);
    if (dto.validUntil) data.validUntil = new Date(dto.validUntil);
    return this.prisma.priceList.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.priceList.delete({ where: { id } });
  }
}

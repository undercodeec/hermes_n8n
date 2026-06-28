import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCampaignSourceDto } from './dto/create-campaign-source.dto';
import { CreateAdsMetadataDto } from './dto/create-ads-metadata.dto';

@Injectable()
export class CampaignsService {
  constructor(private readonly prisma: PrismaService) {}

  // Campaign Sources
  async createSource(dto: CreateCampaignSourceDto) {
    return this.prisma.campaignSource.create({ data: dto });
  }

  async findAllSources(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.campaignSource.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { leads: true } } },
      }),
      this.prisma.campaignSource.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOneSource(id: string) {
    const source = await this.prisma.campaignSource.findUnique({
      where: { id },
      include: { leads: true, adsMetadata: true },
    });
    if (!source) throw new NotFoundException('Fuente de campaña no encontrada');
    return source;
  }

  // Ads Metadata
  async createAdsMetadata(dto: CreateAdsMetadataDto) {
    return this.prisma.adsMetadata.create({
      data: dto,
      include: { campaignSource: true },
    });
  }

  async findAllAdsMetadata(campaignSourceId?: string) {
    const where = campaignSourceId ? { campaignSourceId } : {};
    return this.prisma.adsMetadata.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { campaignSource: true },
    });
  }
}

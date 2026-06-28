import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadStage } from '@prisma/client';

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLeadDto) {
    return this.prisma.lead.create({
      data: dto,
      include: { contact: true, campaignSource: true },
    });
  }

  async findAll(page = 1, limit = 20, stage?: LeadStage) {
    const skip = (page - 1) * limit;
    const where = stage ? { stage } : {};

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { contact: true, campaignSource: true },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        contact: true,
        campaignSource: true,
        tasks: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!lead) throw new NotFoundException('Lead no encontrado');
    return lead;
  }

  async update(id: string, dto: UpdateLeadDto) {
    const lead = await this.findOne(id);

    const data: any = { ...dto };

    // Registrar timestamps de cambio de etapa
    if (dto.stage === LeadStage.WON && lead.stage !== LeadStage.WON) {
      data.wonAt = new Date();
    }
    if (dto.stage === LeadStage.LOST && lead.stage !== LeadStage.LOST) {
      data.lostAt = new Date();
    }

    return this.prisma.lead.update({
      where: { id },
      data,
      include: { contact: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.lead.delete({ where: { id } });
  }

  // Distribución de leads por etapa (para analytics)
  async getFunnelDistribution() {
    const stages = await this.prisma.lead.groupBy({
      by: ['stage'],
      _count: { id: true },
      orderBy: { stage: 'asc' },
    });

    return stages.map((s) => ({ stage: s.stage, count: s._count.id }));
  }
}

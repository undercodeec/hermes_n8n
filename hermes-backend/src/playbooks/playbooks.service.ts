import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlaybookDto } from './dto/create-playbook.dto';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';
import { PlaybookType } from '@prisma/client';

@Injectable()
export class PlaybooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePlaybookDto) {
    return this.prisma.salesPlaybook.create({ data: dto });
  }

  async findAll(type?: PlaybookType, activeOnly = true) {
    const where: any = {};
    if (type) where.type = type;
    if (activeOnly) where.isActive = true;

    return this.prisma.salesPlaybook.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: string) {
    const playbook = await this.prisma.salesPlaybook.findUnique({ where: { id } });
    if (!playbook) throw new NotFoundException('Playbook no encontrado');
    return playbook;
  }

  async update(id: string, dto: UpdatePlaybookDto) {
    await this.findOne(id);
    return this.prisma.salesPlaybook.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.salesPlaybook.delete({ where: { id } });
  }
}

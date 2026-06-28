import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHandoffDto } from './dto/create-handoff.dto';
import { ConversationStatus, HandoffStatus } from '@prisma/client';

@Injectable()
export class HandoffService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateHandoffDto) {
    // Pausar automatización de la conversación
    await this.prisma.conversation.update({
      where: { id: dto.conversationId },
      data: { status: ConversationStatus.HANDED_OFF },
    });

    return this.prisma.humanHandoff.create({
      data: {
        ...dto,
        status: dto.assignedAgentId ? HandoffStatus.ASSIGNED : HandoffStatus.PENDING,
      },
      include: { conversation: { include: { contact: true } }, assignedAgent: true },
    });
  }

  async findAll(status?: HandoffStatus) {
    const where = status ? { status } : {};
    return this.prisma.humanHandoff.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { conversation: { include: { contact: true } }, assignedAgent: true },
    });
  }

  async findOne(id: string) {
    const handoff = await this.prisma.humanHandoff.findUnique({
      where: { id },
      include: {
        conversation: { include: { contact: true, messages: { orderBy: { createdAt: 'desc' }, take: 20 } } },
        assignedAgent: true,
      },
    });
    if (!handoff) throw new NotFoundException('Handoff no encontrado');
    return handoff;
  }

  async assign(id: string, agentId: string) {
    return this.prisma.humanHandoff.update({
      where: { id },
      data: { assignedAgentId: agentId, status: HandoffStatus.ASSIGNED },
      include: { assignedAgent: true },
    });
  }

  async resolve(id: string, resolution: string) {
    const handoff = await this.findOne(id);

    // Reactivar la conversación
    await this.prisma.conversation.update({
      where: { id: handoff.conversationId },
      data: { status: ConversationStatus.ACTIVE },
    });

    return this.prisma.humanHandoff.update({
      where: { id },
      data: {
        status: HandoffStatus.RESOLVED,
        resolution,
        resolvedAt: new Date(),
      },
    });
  }
}

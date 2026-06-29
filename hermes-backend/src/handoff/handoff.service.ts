import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHandoffDto } from './dto/create-handoff.dto';
import { ConversationStatus, HandoffStatus } from '@prisma/client';
import { ConversationHandoffRequestedEvent } from '../common/events/conversation.events';

@Injectable()
export class HandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  async create(dto: CreateHandoffDto) {
    // Pausar automatización de la conversación
    await this.prisma.conversation.update({
      where: { id: dto.conversationId },
      data: { status: ConversationStatus.HANDED_OFF },
    });

    const handoff = await this.prisma.humanHandoff.create({
      data: {
        ...dto,
        status: dto.assignedAgentId ? HandoffStatus.ASSIGNED : HandoffStatus.PENDING,
      },
      include: { conversation: { include: { contact: true } }, assignedAgent: true },
    });

    // Punto de emisión ÚNICO del evento de handoff (cubre automático y manual).
    // El traceId viaja en el payload del job porque el worker de BullMQ no
    // comparte el contexto async del request (ver §12 del plan).
    const traceId = this.cls.isActive()
      ? this.cls.get<string>('traceId')
      : undefined;

    this.events.emit(
      'conversation.handoff_requested',
      new ConversationHandoffRequestedEvent(
        handoff.id,
        handoff.conversationId,
        handoff.conversation?.contact?.id ?? null,
        handoff.reason,
        handoff.reasonDetail ?? undefined,
        handoff.assignedAgentId ?? undefined,
        traceId,
      ),
    );

    return handoff;
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

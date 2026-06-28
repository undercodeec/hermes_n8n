import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';
import { ConversationStatus, MessageDirection, MessageType } from '@prisma/client';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
  ) {}

  async create(dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        contactId: dto.contactId,
        channel: dto.channel || 'whatsapp',
      },
      include: { contact: true },
    });
  }

  async findAll(page = 1, limit = 20, status?: ConversationStatus) {
    const skip = (page - 1) * limit;
    const where = status ? { status } : {};

    const [data, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          contact: true,
          state: true,
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        state: true,
        messages: { orderBy: { createdAt: 'asc' }, take: 50 },
        handoffs: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    return conversation;
  }

  /**
   * Respuesta manual de un agente humano a una conversación
   */
  async reply(id: string, dto: ReplyConversationDto) {
    const conversation = await this.findOne(id);

    // Enviar por WhatsApp
    const sentMessage = await this.metaService.sendTextMessage(
      conversation.contact.waId,
      dto.content,
    );

    // Guardar en BD
    const message = await this.prisma.message.create({
      data: {
        conversationId: id,
        contactId: conversation.contactId,
        direction: MessageDirection.OUTBOUND,
        type: MessageType.TEXT,
        content: dto.content,
        wamid: sentMessage?.messages?.[0]?.id,
      },
    });

    return message;
  }

  async updateStatus(id: string, status: ConversationStatus) {
    const data: any = { status };
    if (status === ConversationStatus.CLOSED) {
      data.closedAt = new Date();
    }

    return this.prisma.conversation.update({
      where: { id },
      data,
    });
  }

  async close(id: string) {
    return this.updateStatus(id, ConversationStatus.CLOSED);
  }
}

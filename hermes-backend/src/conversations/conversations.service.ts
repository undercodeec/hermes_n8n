import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConversationStatus,
  HandoffStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  Prisma,
} from '@prisma/client';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import {
  QueryConversationsDto,
  QueryMessagesDto,
} from './dto/query-conversations.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';

const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  HandoffStatus.PENDING,
  HandoffStatus.ASSIGNED,
  HandoffStatus.IN_PROGRESS,
];

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
  ) {}

  private replyWindow(lastInboundAt: Date | null) {
    const closesAt = lastInboundAt
      ? new Date(lastInboundAt.getTime() + WHATSAPP_REPLY_WINDOW_MS)
      : null;
    const isOpen = closesAt !== null && closesAt.getTime() > Date.now();
    return {
      isOpen,
      lastInboundAt,
      closesAt,
      templateRequired: !isOpen,
    };
  }

  async create(dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        contactId: dto.contactId,
        channel: dto.channel || 'whatsapp',
      },
      include: { contact: true },
    });
  }

  async findAll(query: QueryConversationsDto) {
    const skip = (query.page - 1) * query.limit;
    const where: Prisma.ConversationWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.updatedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.query) {
      where.contact = {
        is: {
          OR: [
            {
              name: {
                contains: query.query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            { phone: { contains: query.query } },
            { waId: { contains: query.query } },
          ],
        },
      };
    }
    if (query.intent) {
      where.state = {
        is: {
          detectedIntent: {
            equals: query.intent,
            mode: Prisma.QueryMode.insensitive,
          },
        },
      };
    }
    if (query.priorityOnly) {
      where.handoffs = {
        some: { status: { in: OPEN_HANDOFF_STATUSES } },
      };
    }

    const [conversations, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          contact: true,
          state: true,
          lead: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          handoffs: {
            where: { status: { in: OPEN_HANDOFF_STATUSES } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { assignedAgent: true },
          },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    const conversationIds = conversations.map(
      (conversation) => conversation.id,
    );
    const lastInbound =
      conversationIds.length === 0
        ? []
        : await this.prisma.message.groupBy({
            by: ['conversationId'],
            where: {
              conversationId: { in: conversationIds },
              sender: MessageSender.CONTACT,
            },
            _max: { createdAt: true },
          });
    const lastInboundByConversation = new Map(
      lastInbound.map((item) => [item.conversationId, item._max.createdAt]),
    );

    const data = conversations
      .map((conversation) => ({
        ...conversation,
        isPriority: conversation.handoffs.length > 0,
        replyWindow: this.replyWindow(
          lastInboundByConversation.get(conversation.id) ?? null,
        ),
      }))
      .sort(
        (left, right) =>
          Number(right.isPriority) - Number(left.isPriority) ||
          right.updatedAt.getTime() - left.updatedAt.getTime(),
      );

    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findOne(id: string) {
    const [conversation, lastInbound] = await Promise.all([
      this.prisma.conversation.findUnique({
        where: { id },
        include: {
          contact: true,
          state: true,
          lead: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 50 },
          handoffs: {
            orderBy: { createdAt: 'desc' },
            include: { assignedAgent: true },
          },
        },
      }),
      this.prisma.message.findFirst({
        where: { conversationId: id, sender: MessageSender.CONTACT },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    if (!conversation) {
      throw new NotFoundException('Conversación no encontrada');
    }

    return {
      ...conversation,
      messages: conversation.messages.reverse(),
      replyWindow: this.replyWindow(lastInbound?.createdAt ?? null),
    };
  }

  async findMessages(id: string, query: QueryMessagesDto) {
    const exists = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Conversación no encontrada');

    const skip = (query.page - 1) * query.limit;
    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: id },
        skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          sentByUser: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.message.count({ where: { conversationId: id } }),
    ]);

    return {
      data: messages.reverse(),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async reply(id: string, dto: ReplyConversationDto, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: { contact: true },
    });
    if (!conversation) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId: id, sender: MessageSender.CONTACT },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const window = this.replyWindow(lastInbound?.createdAt ?? null);

    if (!window.isOpen) {
      throw new BadRequestException({
        code: 'WHATSAPP_TEMPLATE_REQUIRED',
        message:
          'La ventana de atención de 24 horas está cerrada. Debes usar una plantilla aprobada.',
        templateRequired: true,
        lastInboundAt: window.lastInboundAt,
        windowClosesAt: window.closesAt,
      });
    }

    const sentMessage = await this.metaService.sendTextMessage(
      conversation.contact.waId,
      dto.content,
    );
    const wamid = sentMessage?.messages?.[0]?.id;
    if (!wamid) {
      throw new BadGatewayException(
        'Meta no confirmó el envío. El mensaje no se registró como enviado.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: id,
          contactId: conversation.contactId,
          direction: MessageDirection.OUTBOUND,
          sender: MessageSender.HUMAN,
          sentByUserId: userId,
          type: MessageType.TEXT,
          content: dto.content,
          wamid,
          metadata: { source: 'crm' },
        },
        include: {
          sentByUser: { select: { id: true, name: true, email: true } },
        },
      });

      await tx.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'HUMAN_MESSAGE_SENT',
          entity: 'conversations',
          entityId: id,
          changes: { messageId: message.id, wamid },
        },
      });
      return message;
    });
  }

  async updateStatus(id: string, status: ConversationStatus, userId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException('Conversación no encontrada');
      }

      const conversation = await tx.conversation.update({
        where: { id },
        data: {
          status,
          closedAt:
            status === ConversationStatus.CLOSED
              ? new Date()
              : status === ConversationStatus.ACTIVE
                ? null
                : existing.closedAt,
        },
      });

      if (userId) {
        await tx.auditLog.create({
          data: {
            userId,
            action: 'CONVERSATION_STATUS_CHANGED',
            entity: 'conversations',
            entityId: id,
            changes: {
              before: { status: existing.status },
              after: { status },
            },
          },
        });
      }
      return conversation;
    });
  }

  async close(id: string, userId: string) {
    return this.updateStatus(id, ConversationStatus.CLOSED, userId);
  }
}

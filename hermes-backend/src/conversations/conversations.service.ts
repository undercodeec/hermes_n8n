import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
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
  TaskStatus,
  TaskType,
} from '@prisma/client';
import {
  HermesDiagnosticCategory,
  sanitizeDiagnosticSummary,
} from '../hermes/hermes-diagnostics';
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
const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.PENDING,
  TaskStatus.IN_PROGRESS,
];
const HERMES_DIAGNOSTIC_CATEGORIES = new Set<HermesDiagnosticCategory>([
  'POLICY_VIOLATION',
  'PROVIDER_ERROR',
  'INVALID_PROVIDER_RESPONSE',
  'OUTPUT_BLOCKED',
  'CONTEXT_ERROR',
]);

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

  private objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private hermesIncident(metadata: unknown) {
    const incident = this.objectValue(
      this.objectValue(metadata)?.lastHermesIncident,
    );
    if (
      !incident ||
      typeof incident.category !== 'string' ||
      !HERMES_DIAGNOSTIC_CATEGORIES.has(
        incident.category as HermesDiagnosticCategory,
      ) ||
      typeof incident.code !== 'string' ||
      typeof incident.summary !== 'string'
    ) {
      return null;
    }

    return {
      category: incident.category as HermesDiagnosticCategory,
      code: sanitizeDiagnosticSummary(incident.code),
      summary: sanitizeDiagnosticSummary(incident.summary),
      attempts:
        typeof incident.attempts === 'number' ? incident.attempts : 0,
      recovered:
        typeof incident.recovered === 'boolean' ? incident.recovered : false,
      requiresHumanReview:
        typeof incident.requiresHumanReview === 'boolean'
          ? incident.requiresHumanReview
          : false,
      sourceMessageId:
        typeof incident.sourceMessageId === 'string'
          ? sanitizeDiagnosticSummary(incident.sourceMessageId)
          : '',
      ...(typeof incident.taskId === 'string'
        ? { taskId: sanitizeDiagnosticSummary(incident.taskId) }
        : {}),
      occurredAt:
        typeof incident.occurredAt === 'string'
          ? sanitizeDiagnosticSummary(incident.occurredAt)
          : '',
    };
  }

  private hermesReviewTask(task: unknown) {
    const value = this.objectValue(task);
    if (
      !value ||
      typeof value.id !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.status !== 'string'
    ) {
      return null;
    }

    return {
      id: value.id,
      title: value.title,
      status: value.status,
      ...(value.createdAt instanceof Date ? { createdAt: value.createdAt } : {}),
      ...(value.updatedAt instanceof Date ? { updatedAt: value.updatedAt } : {}),
    };
  }

  private hermesReviewTaskQuery() {
    return {
      where: {
        type: TaskType.GENERAL,
        status: { in: OPEN_TASK_STATUSES },
        metadata: { path: ['actionStatus'], equals: 'PENDING_REVIEW' },
      },
      orderBy: { createdAt: Prisma.SortOrder.desc },
      take: 1,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
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
          tasks: this.hermesReviewTaskQuery(),
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
      .map((conversation) => {
        const { metadata, tasks, ...safeConversation } = conversation;
        return {
          ...safeConversation,
          hermesIncident: this.hermesIncident(metadata),
          hermesReviewTask: this.hermesReviewTask(tasks[0]),
          isPriority: conversation.handoffs.length > 0,
          replyWindow: this.replyWindow(
            lastInboundByConversation.get(conversation.id) ?? null,
          ),
        };
      })
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
          tasks: this.hermesReviewTaskQuery(),
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

    const { metadata, tasks, ...safeConversation } = conversation;
    return {
      ...safeConversation,
      messages: conversation.messages.reverse(),
      hermesIncident: this.hermesIncident(metadata),
      hermesReviewTask: this.hermesReviewTask(tasks[0]),
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

    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ConflictException({
        code: 'CONVERSATION_CLOSED',
        message:
          'La conversación está cerrada. Reábrela antes de enviar una respuesta.',
      });
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

  async reopen(id: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;

      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException('Conversación no encontrada');
      }

      const openHandoff = await tx.humanHandoff.findFirst({
        where: {
          conversationId: id,
          status: { in: OPEN_HANDOFF_STATUSES },
        },
        select: { id: true },
      });
      if (openHandoff) {
        throw new ConflictException({
          code: 'OPEN_HANDOFF',
          message:
            'Resuelve el handoff abierto antes de devolver la conversación a Hermes.',
          handoffId: openHandoff.id,
        });
      }

      const conversation = await tx.conversation.update({
        where: { id },
        data: { status: ConversationStatus.ACTIVE, closedAt: null },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CONVERSATION_REOPENED',
          entity: 'conversations',
          entityId: id,
          changes: {
            source: 'CRM',
            before: {
              status: existing.status,
              closedAt: existing.closedAt,
            },
            after: {
              status: ConversationStatus.ACTIVE,
              closedAt: null,
            },
          },
        },
      });
      return conversation;
    });
  }
}

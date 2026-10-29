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
import { safeStoredIncident } from '../hermes/hermes-diagnostics';
import { MetaService } from '../meta/meta.service';
import { whatsappReplyWindow } from '../meta/whatsapp-service-window';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import {
  QueryConversationsDto,
  QueryMessagesDto,
} from './dto/query-conversations.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';
import {
  originConversationWhere,
  projectCrmContact,
  projectCrmHandoff,
  projectCrmLead,
  projectCrmMessage,
  projectCrmState,
  readAttributions,
} from '../attribution-crm/attribution-crm';

const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  HandoffStatus.PENDING,
  HandoffStatus.ASSIGNED,
  HandoffStatus.IN_PROGRESS,
];
const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.PENDING,
  TaskStatus.IN_PROGRESS,
];
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
  ) {}

  private replyWindow(lastInboundAt: Date | null) {
    const window = whatsappReplyWindow(lastInboundAt);
    return {
      ...window,
      templateRequired: !window.isOpen,
    };
  }

  private objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private hermesIncident(metadata: unknown) {
    return safeStoredIncident(this.objectValue(metadata)?.lastHermesIncident);
  }

  private safeMessage<T extends object>(message: T) {
    return projectCrmMessage(message);
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
      ...(value.createdAt instanceof Date
        ? { createdAt: value.createdAt }
        : {}),
      ...(value.updatedAt instanceof Date
        ? { updatedAt: value.updatedAt }
        : {}),
    };
  }

  private hermesReviewTaskQuery() {
    return {
      where: {
        OR: [
          {
            type: TaskType.GENERAL,
            metadata: { path: ['actionStatus'], equals: 'PENDING_REVIEW' },
          },
          { type: TaskType.PAYMENT_VERIFICATION },
        ],
        status: { in: OPEN_TASK_STATUSES },
      },
      orderBy: { createdAt: Prisma.SortOrder.desc },
      take: 10,
      select: {
        id: true,
        type: true,
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
      where.AND = [
        {
          OR: [
            { handoffs: { some: { status: { in: OPEN_HANDOFF_STATUSES } } } },
            {
              tasks: {
                some: {
                  type: TaskType.PAYMENT_VERIFICATION,
                  status: { in: OPEN_TASK_STATUSES },
                },
              },
            },
          ],
        },
      ];
    }
    if (query.origin) {
      where.AND = [
        ...(Array.isArray(where.AND)
          ? where.AND
          : where.AND
            ? [where.AND]
            : []),
        originConversationWhere(query.origin),
      ];
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
    const attributions = await readAttributions(this.prisma, conversations);

    const data = conversations
      .map((conversation) => {
        const { metadata, tasks, ...safeConversation } = conversation;
        return {
          ...safeConversation,
          contact: projectCrmContact(conversation.contact),
          state: projectCrmState(conversation.state),
          lead: conversation.lead
            ? projectCrmLead(
                conversation.lead,
                attributions.get(conversation.id),
              )
            : null,
          attribution: attributions.get(conversation.id),
          handoffs: (conversation.handoffs || []).map(projectCrmHandoff),
          messages: conversation.messages.map((message) =>
            this.safeMessage(message),
          ),
          hermesIncident: this.hermesIncident(metadata),
          hermesReviewTask: this.hermesReviewTask(
            tasks.find((task) => task.type === TaskType.GENERAL),
          ),
          paymentReviewTask:
            tasks.find((task) => task.type === TaskType.PAYMENT_VERIFICATION) ??
            null,
          isPriority:
            conversation.handoffs.length > 0 ||
            tasks.some((task) => task.type === TaskType.PAYMENT_VERIFICATION),
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

    const attributions = await readAttributions(this.prisma, [conversation]);
    const { metadata, tasks, ...safeConversation } = conversation;
    return {
      ...safeConversation,
      contact: projectCrmContact(conversation.contact),
      state: projectCrmState(conversation.state),
      lead: conversation.lead
        ? projectCrmLead(conversation.lead, attributions.get(conversation.id))
        : null,
      attribution: attributions.get(conversation.id),
      handoffs: (conversation.handoffs || []).map(projectCrmHandoff),
      messages: conversation.messages
        .reverse()
        .map((message) => this.safeMessage(message)),
      hermesIncident: this.hermesIncident(metadata),
      hermesReviewTask: this.hermesReviewTask(
        tasks.find((task) => task.type === TaskType.GENERAL),
      ),
      paymentReviewTask:
        tasks.find((task) => task.type === TaskType.PAYMENT_VERIFICATION) ??
        null,
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
      data: messages.reverse().map((message) => this.safeMessage(message)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async inboxMedia(conversationId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        type: {
          in: [MessageType.IMAGE, MessageType.DOCUMENT, MessageType.AUDIO],
        },
      },
      select: {
        rawPayload: true,
        metadata: true,
        type: true,
        sender: true,
        direction: true,
      },
    });
    const inbound =
      message?.sender === MessageSender.CONTACT &&
      message.direction === MessageDirection.INBOUND;
    const assistantVoice =
      message?.type === MessageType.AUDIO &&
      message.sender === MessageSender.HERMES &&
      message.direction === MessageDirection.OUTBOUND;
    if (!message || (!inbound && !assistantVoice))
      throw new NotFoundException('Adjunto no encontrado en esta conversación');
    const mediaId = assistantVoice
      ? this.objectValue(message.metadata)?.voiceMediaId
      : this.objectValue(
          this.objectValue(message.rawPayload)?.[message.type.toLowerCase()],
        )?.id;
    if (typeof mediaId !== 'string' || !mediaId)
      throw new NotFoundException('Media ID no disponible');
    return message.type === MessageType.AUDIO
      ? this.metaService.downloadInboundAudio(mediaId, 16 * 1024 * 1024)
      : this.metaService.fetchInboxMedia(mediaId);
  }

  async reply(id: string, dto: ReplyConversationDto, userId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize takeover/resolution with the final authorization before Meta.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        const conversation = await tx.conversation.findUnique({
          where: { id },
          include: { contact: true },
        });
        if (!conversation)
          throw new NotFoundException('Conversación no encontrada');
        if (conversation.status === ConversationStatus.CLOSED) {
          throw new ConflictException({
            code: 'CONVERSATION_CLOSED',
            message:
              'La conversación está cerrada. Reábrela antes de enviar una respuesta.',
          });
        }
        const handoff = await tx.humanHandoff.findFirst({
          where: {
            conversationId: id,
            status: HandoffStatus.IN_PROGRESS,
            assignedAgentId: userId,
          },
        });
        if (
          conversation.status !== ConversationStatus.HANDED_OFF ||
          !handoff ||
          handoff.assignedAgentId !== userId ||
          handoff.status !== HandoffStatus.IN_PROGRESS
        ) {
          throw new ConflictException({
            code: 'HUMAN_HANDOFF_REQUIRED',
            message:
              'Toma la atención de esta conversación antes de responder.',
          });
        }
        const lastInbound = await tx.message.findFirst({
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
      },
      { timeout: 40000 },
    );
  }

  async updateStatus(id: string, status: ConversationStatus, userId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException('Conversación no encontrada');
      }
      if (status === ConversationStatus.CLOSED) {
        const openHandoff = await tx.humanHandoff.findFirst({
          where: { conversationId: id, status: { in: OPEN_HANDOFF_STATUSES } },
          select: { id: true },
        });
        if (openHandoff) {
          throw new ConflictException({
            code: 'OPEN_HANDOFF',
            message:
              'Resuelve el handoff abierto antes de cerrar la conversación.',
          });
        }
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

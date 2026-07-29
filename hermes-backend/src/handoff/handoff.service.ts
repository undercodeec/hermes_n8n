import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationStatus, HandoffStatus, Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { ConversationHandoffRequestedEvent } from '../common/events/conversation.events';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHandoffDto } from './dto/create-handoff.dto';
import {
  HandoffResolutionAction,
  ResolveHandoffDto,
} from './dto/handoff-actions.dto';

const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  HandoffStatus.PENDING,
  HandoffStatus.ASSIGNED,
  HandoffStatus.IN_PROGRESS,
];

@Injectable()
export class HandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
    private readonly config: ConfigService,
  ) {}

  private traceId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>('traceId') : undefined;
  }

  private crmUrl(conversationId: string): string | undefined {
    const baseUrl = this.config
      .get<string>('CRM_BASE_URL')
      ?.replace(/\/+$/, '');
    return baseUrl
      ? `${baseUrl}/inbox?conversationId=${encodeURIComponent(conversationId)}`
      : undefined;
  }

  async create(dto: CreateHandoffDto, actorUserId?: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.conversationId}))`;

      const conversation = await tx.conversation.findUnique({
        where: { id: dto.conversationId },
        include: { contact: true },
      });
      if (!conversation) {
        throw new NotFoundException('Conversación no encontrada');
      }

      const existing = await tx.humanHandoff.findFirst({
        where: {
          conversationId: dto.conversationId,
          status: { in: OPEN_HANDOFF_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          conversation: { include: { contact: true } },
          assignedAgent: true,
        },
      });

      await tx.conversation.update({
        where: { id: dto.conversationId },
        data: { status: ConversationStatus.HANDED_OFF, closedAt: null },
      });

      if (existing) {
        return { handoff: existing, created: false };
      }

      const handoff = await tx.humanHandoff.create({
        data: {
          ...dto,
          status: dto.assignedAgentId
            ? HandoffStatus.ASSIGNED
            : HandoffStatus.PENDING,
        },
        include: {
          conversation: { include: { contact: true } },
          assignedAgent: true,
        },
      });

      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            userId: actorUserId,
            action: 'HANDOFF_CREATED',
            entity: 'human_handoffs',
            entityId: handoff.id,
            changes: {
              conversationId: dto.conversationId,
              reason: dto.reason,
              reasonDetail: dto.reasonDetail,
            },
          },
        });
      }

      return { handoff, created: true };
    });

    if (result.created) {
      const contact = result.handoff.conversation.contact;
      this.events.emit(
        'conversation.handoff_requested',
        new ConversationHandoffRequestedEvent(
          result.handoff.id,
          result.handoff.conversationId,
          contact.id,
          result.handoff.reason,
          result.handoff.reasonDetail ?? undefined,
          result.handoff.assignedAgentId ?? undefined,
          contact.name ?? undefined,
          contact.waId,
          this.crmUrl(result.handoff.conversationId),
          this.traceId(),
        ),
      );
    }

    return result.handoff;
  }

  async findAll(status?: HandoffStatus) {
    const where = status ? { status } : {};
    return this.prisma.humanHandoff.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        conversation: {
          include: { contact: true, state: true, lead: true },
        },
        assignedAgent: true,
      },
    });
  }

  async findOne(id: string) {
    const [handoff, auditLogs] = await Promise.all([
      this.prisma.humanHandoff.findUnique({
        where: { id },
        include: {
          conversation: {
            include: {
              contact: true,
              state: true,
              lead: true,
              messages: { orderBy: { createdAt: 'desc' }, take: 20 },
            },
          },
          assignedAgent: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: { entity: 'human_handoffs', entityId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    if (!handoff) throw new NotFoundException('Handoff no encontrado');
    return { ...handoff, auditLogs };
  }

  async assign(id: string, agentId: string, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const handoff = await this.getOpenHandoff(tx, id);
      const updated = await tx.humanHandoff.update({
        where: { id },
        data: {
          assignedAgentId: agentId,
          status: HandoffStatus.IN_PROGRESS,
        },
        include: { assignedAgent: true },
      });
      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'HANDOFF_TAKEN',
          entity: 'human_handoffs',
          entityId: id,
          changes: {
            before: {
              status: handoff.status,
              assignedAgentId: handoff.assignedAgentId,
            },
            after: {
              status: HandoffStatus.IN_PROGRESS,
              assignedAgentId: agentId,
            },
          },
        },
      });
      return updated;
    });
  }

  async resolve(id: string, dto: ResolveHandoffDto, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const handoff = await this.getOpenHandoff(tx, id);

      if (dto.action === HandoffResolutionAction.KEEP_HUMAN) {
        const kept = await tx.humanHandoff.update({
          where: { id },
          data: {
            assignedAgentId: handoff.assignedAgentId ?? actorUserId,
            status: HandoffStatus.IN_PROGRESS,
            resolution: dto.resolution,
          },
        });
        await tx.conversation.update({
          where: { id: handoff.conversationId },
          data: { status: ConversationStatus.HANDED_OFF, closedAt: null },
        });
        await this.auditResolution(
          tx,
          id,
          actorUserId,
          handoff.status,
          HandoffStatus.IN_PROGRESS,
          dto,
        );
        return kept;
      }

      const conversationStatus =
        dto.action === HandoffResolutionAction.CLOSE_CONVERSATION
          ? ConversationStatus.CLOSED
          : ConversationStatus.ACTIVE;
      const resolvedAt = new Date();

      await tx.conversation.update({
        where: { id: handoff.conversationId },
        data: {
          status: conversationStatus,
          closedAt:
            conversationStatus === ConversationStatus.CLOSED
              ? resolvedAt
              : null,
        },
      });
      const resolved = await tx.humanHandoff.update({
        where: { id },
        data: {
          assignedAgentId: handoff.assignedAgentId ?? actorUserId,
          status: HandoffStatus.RESOLVED,
          resolution: dto.resolution,
          resolvedAt,
          metadata: {
            resolutionAction: dto.action,
          },
        },
      });
      await this.auditResolution(
        tx,
        id,
        actorUserId,
        handoff.status,
        HandoffStatus.RESOLVED,
        dto,
      );
      return resolved;
    });
  }

  private async getOpenHandoff(tx: Prisma.TransactionClient, id: string) {
    const handoff = await tx.humanHandoff.findUnique({ where: { id } });
    if (!handoff) throw new NotFoundException('Handoff no encontrado');
    if (!OPEN_HANDOFF_STATUSES.includes(handoff.status)) {
      throw new ConflictException('El handoff ya no está abierto');
    }
    return handoff;
  }

  private async auditResolution(
    tx: Prisma.TransactionClient,
    id: string,
    userId: string,
    beforeStatus: HandoffStatus,
    afterStatus: HandoffStatus,
    dto: ResolveHandoffDto,
  ) {
    await tx.auditLog.create({
      data: {
        userId,
        action:
          dto.action === HandoffResolutionAction.KEEP_HUMAN
            ? 'HANDOFF_KEPT_HUMAN'
            : 'HANDOFF_RESOLVED',
        entity: 'human_handoffs',
        entityId: id,
        changes: {
          before: { status: beforeStatus },
          after: {
            status: afterStatus,
            resolution: dto.resolution,
            action: dto.action,
          },
        },
      },
    });
  }
}

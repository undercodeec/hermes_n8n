import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  HandoffStatus,
  Lead,
  LeadStage,
  MessageSender,
  Prisma,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import {
  LeadCreatedEvent,
  LeadQualifiedEvent,
} from '../common/events/lead.events';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { QueryLeadsDto } from './dto/query-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  HandoffStatus.PENDING,
  HandoffStatus.ASSIGNED,
  HandoffStatus.IN_PROGRESS,
];

const AUTOMATICALLY_PROMOTABLE_STAGES: LeadStage[] = [
  LeadStage.NEW,
  LeadStage.CONTACTED,
];
const TERMINAL_LEAD_STAGES: LeadStage[] = [LeadStage.WON, LeadStage.LOST];

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
    private readonly config: ConfigService,
  ) {}

  private traceId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>('traceId') : undefined;
  }

  private crmUrl(leadId: string): string | undefined {
    const baseUrl = this.config
      .get<string>('CRM_BASE_URL')
      ?.replace(/\/+$/, '');
    return baseUrl ? `${baseUrl}/leads/${leadId}` : undefined;
  }

  private emitQualified(
    lead: Lead,
    conversationId: string | null,
    contact: { name: string | null; waId: string },
    detectedIntent?: string,
  ): void {
    this.events.emit(
      'lead.qualified',
      new LeadQualifiedEvent(
        lead.id,
        lead.contactId,
        conversationId,
        lead.closeProbability ?? 0,
        detectedIntent,
        lead.productOfInterest ?? undefined,
        contact.name ?? undefined,
        contact.waId,
        this.crmUrl(lead.id),
        this.traceId(),
      ),
    );
  }

  async create(dto: CreateLeadDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.contactId}))`;

      const existingOpenLead = await tx.lead.findFirst({
        where: {
          contactId: dto.contactId,
          stage: { notIn: [LeadStage.WON, LeadStage.LOST] },
        },
        select: { id: true },
      });

      if (existingOpenLead) {
        throw new ConflictException(
          'El contacto ya tiene un lead abierto. Actualiza el lead existente.',
        );
      }

      return tx.lead.create({
        data: dto,
        include: { contact: true, campaignSource: true },
      });
    });

    this.events.emit(
      'lead.created',
      new LeadCreatedEvent(result.id, result.contactId, this.traceId()),
    );

    return result;
  }

  /**
   * Crea el lead NEW del primer mensaje o reutiliza el lead más reciente.
   * El advisory lock evita duplicados cuando Meta reintenta mensajes en paralelo.
   */
  async findOrCreateForConversation(params: {
    contactId: string;
    conversationId: string;
  }): Promise<Lead> {
    const { lead, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.contactId}))`;

      const existing = await tx.lead.findFirst({
        where: { contactId: params.contactId },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        const linkedLead =
          existing.conversationId !== params.conversationId
            ? await tx.lead.update({
                where: { id: existing.id },
                data: { conversationId: params.conversationId },
              })
            : existing;
        return { lead: linkedLead, created: false };
      }

      const newLead = await tx.lead.create({
        data: {
          contactId: params.contactId,
          conversationId: params.conversationId,
          stage: LeadStage.NEW,
        },
      });
      return { lead: newLead, created: true };
    });

    if (created) {
      this.events.emit(
        'lead.created',
        new LeadCreatedEvent(lead.id, lead.contactId, this.traceId()),
      );
    }

    return lead;
  }

  async findAll(query: QueryLeadsDto) {
    const skip = (query.page - 1) * query.limit;
    const where: Prisma.LeadWhereInput = {};

    if (query.stage) where.stage = query.stage;
    if (query.from || query.to) {
      where.updatedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.query) {
      where.OR = [
        {
          productOfInterest: {
            contains: query.query,
            mode: Prisma.QueryMode.insensitive,
          },
        },
        {
          contact: {
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
          },
        },
        {
          conversation: {
            is: {
              state: {
                is: {
                  detectedIntent: {
                    contains: query.query,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            },
          },
        },
      ];
    }

    if (query.intent) {
      where.conversation = {
        is: {
          state: {
            is: {
              detectedIntent: {
                equals: query.intent,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          },
        },
      };
    }

    if (query.hasHandoff !== undefined) {
      where.conversation = {
        ...(where.conversation as Prisma.ConversationNullableRelationFilter),
        is: {
          ...((where.conversation as Prisma.ConversationNullableRelationFilter)
            ?.is as Prisma.ConversationWhereInput),
          handoffs: query.hasHandoff
            ? { some: { status: { in: OPEN_HANDOFF_STATUSES } } }
            : { none: { status: { in: OPEN_HANDOFF_STATUSES } } },
        },
      };
    }

    if (query.hermesReplied !== undefined) {
      where.conversation = {
        ...(where.conversation as Prisma.ConversationNullableRelationFilter),
        is: {
          ...((where.conversation as Prisma.ConversationNullableRelationFilter)
            ?.is as Prisma.ConversationWhereInput),
          messages: query.hermesReplied
            ? { some: { sender: MessageSender.HERMES } }
            : { none: { sender: MessageSender.HERMES } },
        },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          contact: true,
          campaignSource: true,
          conversation: {
            include: {
              state: true,
              messages: { orderBy: { createdAt: 'desc' }, take: 1 },
              handoffs: {
                where: { status: { in: OPEN_HANDOFF_STATUSES } },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async findOne(id: string) {
    const [lead, auditLogs] = await Promise.all([
      this.prisma.lead.findUnique({
        where: { id },
        include: {
          contact: true,
          campaignSource: true,
          conversation: {
            include: {
              state: true,
              handoffs: {
                orderBy: { createdAt: 'desc' },
                include: { assignedAgent: true },
              },
            },
          },
          tasks: { orderBy: { createdAt: 'desc' } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { entity: 'leads', entityId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    if (!lead) throw new NotFoundException('Lead no encontrado');
    return { ...lead, auditLogs };
  }

  async update(id: string, dto: UpdateLeadDto, userId: string) {
    const { previousStage, updated } = await this.prisma.$transaction(
      async (tx) => {
        const lead = await tx.lead.findUnique({ where: { id } });
        if (!lead) throw new NotFoundException('Lead no encontrado');

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lead.contactId}))`;
        if (
          dto.stage &&
          !TERMINAL_LEAD_STAGES.includes(dto.stage) &&
          TERMINAL_LEAD_STAGES.includes(lead.stage)
        ) {
          const otherOpenLead = await tx.lead.findFirst({
            where: {
              contactId: lead.contactId,
              id: { not: id },
              stage: { notIn: [LeadStage.WON, LeadStage.LOST] },
            },
            select: { id: true },
          });
          if (otherOpenLead) {
            throw new ConflictException(
              'El contacto ya tiene otra oportunidad abierta.',
            );
          }
        }

        const data: Prisma.LeadUpdateInput = { ...dto };
        if (dto.stage === LeadStage.WON && lead.stage !== LeadStage.WON) {
          data.wonAt = new Date();
        }
        if (dto.stage === LeadStage.LOST && lead.stage !== LeadStage.LOST) {
          data.lostAt = new Date();
        }

        const nextLead = await tx.lead.update({
          where: { id },
          data,
          include: { contact: true },
        });

        await tx.auditLog.create({
          data: {
            userId,
            action:
              dto.stage && dto.stage !== lead.stage
                ? 'LEAD_STAGE_CHANGED'
                : 'LEAD_UPDATED',
            entity: 'leads',
            entityId: id,
            changes: {
              before: dto.stage ? { stage: lead.stage } : {},
              after: { ...dto },
            },
          },
        });

        return { previousStage: lead.stage, updated: nextLead };
      },
    );

    if (
      dto.stage === LeadStage.QUALIFIED &&
      previousStage !== LeadStage.QUALIFIED
    ) {
      this.emitQualified(updated, updated.conversationId, updated.contact);
    }

    return updated;
  }

  async qualifyFromConversation(params: {
    contactId: string;
    conversationId: string;
    detectedIntent?: string;
    productOfInterest?: string;
  }): Promise<Lead> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.contactId}))`;

      let existing = await tx.lead.findFirst({
        where: { contactId: params.contactId },
        orderBy: { createdAt: 'desc' },
      });
      let created = false;

      if (!existing) {
        existing = await tx.lead.create({
          data: {
            contactId: params.contactId,
            conversationId: params.conversationId,
            stage: LeadStage.NEW,
          },
        });
        created = true;
      }

      if (!AUTOMATICALLY_PROMOTABLE_STAGES.includes(existing.stage)) {
        const contact = await tx.contact.findUniqueOrThrow({
          where: { id: params.contactId },
          select: { name: true, waId: true },
        });
        return { lead: existing, contact, created, qualified: false };
      }

      const lead = await tx.lead.update({
        where: { id: existing.id },
        data: {
          stage: LeadStage.QUALIFIED,
          conversationId: params.conversationId,
          productOfInterest:
            params.productOfInterest ?? existing.productOfInterest,
        },
      });
      const contact = await tx.contact.findUniqueOrThrow({
        where: { id: params.contactId },
        select: { name: true, waId: true },
      });
      return { lead, contact, created, qualified: true };
    });

    if (result.created) {
      this.events.emit(
        'lead.created',
        new LeadCreatedEvent(
          result.lead.id,
          result.lead.contactId,
          this.traceId(),
        ),
      );
    }
    if (result.qualified) {
      this.emitQualified(
        result.lead,
        params.conversationId,
        result.contact,
        params.detectedIntent,
      );
    }

    return result.lead;
  }

  async remove(id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead no encontrado');
    return this.prisma.lead.delete({ where: { id } });
  }

  async getFunnelDistribution() {
    const stages = await this.prisma.lead.groupBy({
      by: ['stage'],
      _count: { id: true },
      orderBy: { stage: 'asc' },
    });

    return stages.map((stage) => ({
      stage: stage.stage,
      count: stage._count.id,
    }));
  }
}

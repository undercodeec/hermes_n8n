import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  HandoffStatus,
  Lead,
  Meeting,
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
import { CommercialProfile } from '../hermes/dto/hermes-request.dto';

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

const ALLOWED_STAGE_TRANSITIONS: Partial<Record<LeadStage, LeadStage[]>> = {
  [LeadStage.NEW]: [LeadStage.CONTACTED, LeadStage.QUALIFIED, LeadStage.LOST],
  [LeadStage.CONTACTED]: [LeadStage.QUALIFIED, LeadStage.LOST],
  [LeadStage.QUALIFIED]: [
    LeadStage.PROPOSAL,
    LeadStage.NEGOTIATION,
    LeadStage.LOST,
  ],
  [LeadStage.PROPOSAL]: [LeadStage.NEGOTIATION, LeadStage.WON, LeadStage.LOST],
  [LeadStage.NEGOTIATION]: [LeadStage.PROPOSAL, LeadStage.WON, LeadStage.LOST],
};

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

  async recordConfirmedMeeting(tx: Prisma.TransactionClient, meeting: Meeting) {
    if (meeting.status !== 'CONFIRMED' || !meeting.leadId) return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${meeting.contactId}))`;
    const lead = await tx.lead.findUnique({ where: { id: meeting.leadId } });
    if (
      !lead ||
      lead.contactId !== meeting.contactId ||
      !AUTOMATICALLY_PROMOTABLE_STAGES.includes(lead.stage)
    )
      return null;
    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: { stage: LeadStage.QUALIFIED },
    });
    await tx.auditLog.create({
      data: {
        action: 'MEETING_LEAD_QUALIFIED',
        entity: 'leads',
        entityId: lead.id,
        changes: {
          before: { stage: lead.stage },
          after: { stage: LeadStage.QUALIFIED },
          meetingId: meeting.id,
        },
      },
    });
    const contact = await tx.contact.findUniqueOrThrow({
      where: { id: meeting.contactId },
      select: { name: true, waId: true },
    });
    return { lead: updated, contact, conversationId: meeting.conversationId };
  }

  publishMeetingQualification(
    result: Awaited<ReturnType<LeadsService['recordConfirmedMeeting']>>,
  ): void {
    if (result)
      this.emitQualified(
        result.lead,
        result.conversationId,
        result.contact,
        'reunion_confirmada',
      );
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
          dto.stage !== lead.stage &&
          !ALLOWED_STAGE_TRANSITIONS[lead.stage]?.includes(dto.stage)
        ) {
          throw new BadRequestException(
            `Transición no permitida: ${lead.stage} → ${dto.stage}`,
          );
        }
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
    commercialProfile?: CommercialProfile;
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

      // Una intención de compra aislada no basta: la promoción automática exige
      // una necesidad concreta, el servicio y al menos un dato para evaluación.
      if (!this.hasQualificationContext(params.commercialProfile)) {
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

  /**
   * Guarda hechos extraídos de la conversación sin convertir una sugerencia de
   * IA en un hito comercial. Solo NEW -> CONTACTED se deriva de una necesidad.
   */
  async recordCommercialProfileFromConversation(params: {
    contactId: string;
    conversationId: string;
    profile?: CommercialProfile;
    sourceMessageId?: string;
  }): Promise<Lead | undefined> {
    const inputProfile = params.profile;
    if (!inputProfile) return undefined;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.contactId}))`;
      const lead = await tx.lead.findFirst({
        where: { contactId: params.contactId },
        orderBy: { createdAt: 'desc' },
      });
      if (!lead) return undefined;

      const commercialProfile = this.mergeCommercialProfile(
        lead.metadata,
        inputProfile,
      );
      const metadata = this.mergeLeadMetadata(
        lead.metadata,
        commercialProfile,
        inputProfile,
        params.sourceMessageId,
      );
      const hasNeed = Boolean(
        commercialProfile.need && commercialProfile.service,
      );
      const stage =
        lead.stage === LeadStage.NEW && hasNeed
          ? LeadStage.CONTACTED
          : lead.stage;

      if (inputProfile.company) {
        await tx.contact.update({
          where: { id: params.contactId },
          data: { company: inputProfile.company },
        });
      }

      return tx.lead.update({
        where: { id: lead.id },
        data: {
          conversationId: params.conversationId,
          stage,
          productOfInterest: inputProfile.service ?? lead.productOfInterest,
          serviceRequested: inputProfile.service ?? lead.serviceRequested,
          nextAction: inputProfile.nextStep ?? lead.nextAction,
          metadata: metadata as Prisma.InputJsonValue,
        },
      });
    });
  }

  private hasQualificationContext(profile?: CommercialProfile): boolean {
    if (!profile?.service || !profile.need) return false;
    return Boolean(
      profile.company ||
      profile.sector ||
      profile.location ||
      profile.users ||
      profile.productCount ||
      profile.paymentNeeds ||
      profile.shippingNeeds ||
      profile.inventoryNeeds ||
      profile.integrations ||
      profile.budget ||
      profile.timeline,
    );
  }

  private mergeCommercialProfile(
    metadata: Prisma.JsonValue | null,
    profile: CommercialProfile,
  ): CommercialProfile {
    const existing =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).commercialProfile
        : undefined;
    const previous =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as CommercialProfile)
        : {};
    const definedEntries = Object.entries(profile).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    );
    return { ...previous, ...Object.fromEntries(definedEntries) };
  }

  private mergeLeadMetadata(
    metadata: Prisma.JsonValue | null,
    commercialProfile: CommercialProfile,
    changes: CommercialProfile,
    sourceMessageId?: string,
  ): Record<string, unknown> {
    const previous =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    const historyValue: unknown = previous.commercialProfileHistory;
    const previousHistory: unknown[] = Array.isArray(historyValue)
      ? (historyValue as unknown[])
      : [];
    const definedChanges = Object.fromEntries(
      Object.entries(changes).filter(
        ([, value]) => value !== undefined && value !== null && value !== '',
      ),
    );
    const historyEntry = Object.keys(definedChanges).length
      ? {
          recordedAt: new Date().toISOString(),
          sourceMessageId,
          changes: definedChanges,
        }
      : undefined;
    return {
      ...previous,
      commercialProfile,
      commercialProfileHistory: historyEntry
        ? [...previousHistory, historyEntry].slice(-20)
        : previousHistory,
    };
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

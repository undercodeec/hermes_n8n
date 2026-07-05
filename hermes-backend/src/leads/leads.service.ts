import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { Lead, LeadStage } from '@prisma/client';
import {
  LeadCreatedEvent,
  LeadQualifiedEvent,
} from '../common/events/lead.events';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  /** traceId del request actual, si estamos dentro de contexto CLS. */
  private traceId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string>('traceId') : undefined;
  }

  /** Punto único de emisión de `lead.qualified` (calificación auto y manual). */
  private emitQualified(
    lead: Lead,
    conversationId: string | null,
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
        this.traceId(),
      ),
    );
  }

  async create(dto: CreateLeadDto) {
    const lead = await this.prisma.lead.create({
      data: dto,
      include: { contact: true, campaignSource: true },
    });

    this.events.emit(
      'lead.created',
      new LeadCreatedEvent(lead.id, lead.contactId, this.traceId()),
    );

    return lead;
  }

  async findAll(page = 1, limit = 20, stage?: LeadStage) {
    const skip = (page - 1) * limit;
    const where = stage ? { stage } : {};

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { contact: true, campaignSource: true },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        contact: true,
        campaignSource: true,
        tasks: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!lead) throw new NotFoundException('Lead no encontrado');
    return lead;
  }

  async update(id: string, dto: UpdateLeadDto) {
    const lead = await this.findOne(id);

    const data: any = { ...dto };

    // Registrar timestamps de cambio de etapa
    if (dto.stage === LeadStage.WON && lead.stage !== LeadStage.WON) {
      data.wonAt = new Date();
    }
    if (dto.stage === LeadStage.LOST && lead.stage !== LeadStage.LOST) {
      data.lostAt = new Date();
    }

    const updated = await this.prisma.lead.update({
      where: { id },
      data,
      include: { contact: true },
    });

    // Emitir lead.qualified sólo en la transición hacia QUALIFIED (no reemite si
    // ya lo estaba). Cubre la calificación manual desde la API.
    if (
      dto.stage === LeadStage.QUALIFIED &&
      lead.stage !== LeadStage.QUALIFIED
    ) {
      this.emitQualified(updated, null);
    }

    return updated;
  }

  /**
   * Calificación automática de un lead desde el flujo del webhook (Etapa 3).
   *
   * Punto único usado por `WebhookService`: busca el lead más reciente del
   * contacto; si no existe lo crea; lo lleva a QUALIFIED y emite `lead.qualified`.
   * Idempotente: si el lead ya está en QUALIFIED o en una etapa posterior
   * (PROPOSAL/NEGOTIATION/WON) no reemite ni retrocede el stage.
   */
  async qualifyFromConversation(params: {
    contactId: string;
    conversationId: string;
    detectedIntent?: string;
    productOfInterest?: string;
  }): Promise<Lead> {
    const { contactId, conversationId, detectedIntent, productOfInterest } =
      params;

    const existing = await this.prisma.lead.findFirst({
      where: { contactId },
      orderBy: { createdAt: 'desc' },
    });

    const alreadyQualifiedStages: LeadStage[] = [
      LeadStage.QUALIFIED,
      LeadStage.PROPOSAL,
      LeadStage.NEGOTIATION,
      LeadStage.WON,
    ];

    // Ya calificado o más avanzado → no-op (idempotencia).
    if (existing && alreadyQualifiedStages.includes(existing.stage)) {
      return existing;
    }

    const lead = existing
      ? await this.prisma.lead.update({
          where: { id: existing.id },
          data: {
            stage: LeadStage.QUALIFIED,
            productOfInterest: productOfInterest ?? existing.productOfInterest,
          },
        })
      : await this.prisma.lead.create({
          data: {
            contactId,
            stage: LeadStage.QUALIFIED,
            productOfInterest,
          },
        });

    this.emitQualified(lead, conversationId, detectedIntent);
    return lead;
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.lead.delete({ where: { id } });
  }

  // Distribución de leads por etapa (para analytics)
  async getFunnelDistribution() {
    const stages = await this.prisma.lead.groupBy({
      by: ['stage'],
      _count: { id: true },
      orderBy: { stage: 'asc' },
    });

    return stages.map((s) => ({ stage: s.stage, count: s._count.id }));
  }
}

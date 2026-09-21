import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Prisma, TaskStatus, TaskType } from '@prisma/client';
import {
  HermesDiagnosticCategory,
  sanitizeDiagnosticSummary,
} from '../hermes/hermes-diagnostics';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTaskDto) {
    return this.prisma.task.create({
      data: {
        ...dto,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      },
      include: { lead: true, conversation: true, assignedUser: true },
    });
  }

  /**
   * Registra una solicitud real de llamada sin presentarla como una reserva.
   * El bloqueo por conversación y los IDs de mensaje en metadata hacen que los
   * reintentos del worker no dupliquen tareas.
   */
  async requestCallback(params: {
    conversationId: string;
    leadId?: string;
    contactId: string;
    sourceMessageId: string;
    requestedAt?: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.conversationId}))`;
      const existing = await tx.task.findFirst({
        where: {
          conversationId: params.conversationId,
          type: TaskType.CALLBACK,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const previousMetadata = this.objectMetadata(existing?.metadata);
      const sourceMessageIds = Array.isArray(previousMetadata.sourceMessageIds)
        ? previousMetadata.sourceMessageIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      if (existing && sourceMessageIds.includes(params.sourceMessageId)) {
        return existing;
      }
      const metadata = {
        ...previousMetadata,
        actionStatus: 'PENDING_CONFIRMATION',
        requestedChannel: 'WHATSAPP_CALL',
        phoneSource: 'WHATSAPP_CONTACT',
        contactId: params.contactId,
        sourceMessageIds: [...sourceMessageIds, params.sourceMessageId].slice(
          -20,
        ),
      } as Prisma.InputJsonValue;

      if (existing) {
        return tx.task.update({
          where: { id: existing.id },
          data: {
            leadId: params.leadId ?? existing.leadId,
            dueAt: params.requestedAt ?? existing.dueAt,
            description: params.requestedAt
              ? `Llamada solicitada por WhatsApp para ${params.requestedAt.toISOString()}; pendiente de confirmación.`
              : existing.description,
            metadata,
          },
        });
      }

      return tx.task.create({
        data: {
          conversationId: params.conversationId,
          leadId: params.leadId,
          type: TaskType.CALLBACK,
          status: TaskStatus.PENDING,
          title: 'Confirmar solicitud de llamada por WhatsApp',
          description: params.requestedAt
            ? `Llamada solicitada por WhatsApp para ${params.requestedAt.toISOString()}; pendiente de confirmación.`
            : 'El cliente solicitó una llamada por WhatsApp; falta acordar el horario.',
          dueAt: params.requestedAt,
          metadata,
        },
      });
    });
  }

  /** Registra una cotización humana cuando el catálogo no resolvió precio/plazo. */
  async requestQuote(params: {
    conversationId: string;
    leadId?: string;
    contactId: string;
    sourceMessageId: string;
    scopeSummary?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.conversationId}))`;
      const existing = await tx.task.findFirst({
        where: {
          conversationId: params.conversationId,
          type: TaskType.QUOTE,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const previousMetadata = this.objectMetadata(existing?.metadata);
      const sourceMessageIds = Array.isArray(previousMetadata.sourceMessageIds)
        ? previousMetadata.sourceMessageIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      if (existing && sourceMessageIds.includes(params.sourceMessageId)) {
        return existing;
      }
      const metadata = {
        ...previousMetadata,
        actionStatus: 'PENDING_REVIEW',
        contactId: params.contactId,
        sourceMessageIds: [...sourceMessageIds, params.sourceMessageId].slice(
          -20,
        ),
      } as Prisma.InputJsonValue;
      const description = params.scopeSummary
        ? `Preparar valoración comercial. Alcance: ${params.scopeSummary.slice(0, 1000)}`
        : 'Preparar valoración comercial con el contexto de la conversación.';

      if (existing) {
        return tx.task.update({
          where: { id: existing.id },
          data: {
            leadId: params.leadId ?? existing.leadId,
            description,
            metadata,
          },
        });
      }
      return tx.task.create({
        data: {
          conversationId: params.conversationId,
          leadId: params.leadId,
          type: TaskType.QUOTE,
          status: TaskStatus.PENDING,
          title: 'Preparar cotización solicitada por WhatsApp',
          description,
          metadata,
        },
      });
    });
  }

  async requestHermesReview(params: {
    conversationId: string;
    leadId?: string;
    contactId: string;
    sourceMessageId: string;
    category: HermesDiagnosticCategory;
    code: string;
    summary: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.conversationId}))`;
      const existing = await tx.task.findFirst({
        where: {
          conversationId: params.conversationId,
          type: TaskType.GENERAL,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
          metadata: { path: ['actionStatus'], equals: 'PENDING_REVIEW' },
        },
        orderBy: { createdAt: 'desc' },
      });
      const previousMetadata = this.objectMetadata(existing?.metadata);
      const sourceMessageIds = Array.isArray(previousMetadata.sourceMessageIds)
        ? previousMetadata.sourceMessageIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      if (existing && sourceMessageIds.includes(params.sourceMessageId)) {
        return existing;
      }

      const summary = sanitizeDiagnosticSummary(params.summary);
      const metadata = {
        category: params.category,
        code: sanitizeDiagnosticSummary(params.code).slice(0, 100),
        summary,
        contactId: params.contactId,
        actionStatus: 'PENDING_REVIEW',
        sourceMessageIds: [...sourceMessageIds, params.sourceMessageId].slice(
          -20,
        ),
      } as Prisma.InputJsonValue;
      const description = summary
        ? `Revisar incidencia de Hermes: ${summary}`
        : 'Revisar incidencia de Hermes asociada a la conversación.';

      if (existing) {
        return tx.task.update({
          where: { id: existing.id },
          data: {
            leadId: params.leadId ?? existing.leadId,
            description,
            metadata,
          },
        });
      }
      return tx.task.create({
        data: {
          conversationId: params.conversationId,
          leadId: params.leadId,
          type: TaskType.GENERAL,
          status: TaskStatus.PENDING,
          title: 'Revisar incidencia de Hermes',
          description,
          metadata,
        },
      });
    });
  }

  private objectMetadata(value: Prisma.JsonValue | null | undefined) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  async findAll(
    page = 1,
    limit = 20,
    status?: TaskStatus,
    assignedUserId?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.TaskWhereInput = {};
    if (status) where.status = status;
    if (assignedUserId) where.assignedUserId = assignedUserId;

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
        include: { lead: true, assignedUser: true },
      }),
      this.prisma.task.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        lead: { include: { contact: true } },
        conversation: true,
        assignedUser: true,
      },
    });
    if (!task) throw new NotFoundException('Tarea no encontrada');
    return task;
  }

  async update(id: string, dto: UpdateTaskDto) {
    await this.findOne(id);
    const data: Prisma.TaskUncheckedUpdateInput = { ...dto };
    if (dto.dueAt) data.dueAt = new Date(dto.dueAt);
    if (dto.status === TaskStatus.COMPLETED) data.completedAt = new Date();

    return this.prisma.task.update({
      where: { id },
      data,
      include: { lead: true, assignedUser: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.task.delete({ where: { id } });
  }
}

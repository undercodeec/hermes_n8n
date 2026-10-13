import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  ConversationReviewTrigger,
  FeedbackRating,
  MessageDirection,
  MessageSender,
  Prisma,
  LearningRiskLevel,
  LearningItemStatus,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  LEARNING_REVIEW_QUEUE,
  REVIEWER_VERSION,
  ReviewJobData,
} from './learning.constants';
import { ReviewModelService } from './review-model.service';
import { validateCandidateSafety } from './review-candidate-safety';
import { ReviewCanaryPolicy } from './review-canary.policy';
import { ReviewCanaryTriggerDto } from './dto/review-canary-trigger.dto';
import { sanitizeReviewInput, privacyFailure } from './review-privacy';
import { parseReviewOutput } from './review-output.validator';
import {
  LearningDecisionAction,
  LearningDecisionDto,
} from './dto/learning-decision.dto';

type FeedbackRef = {
  id: string;
  conversationId: string;
  messageId: string;
  rating: FeedbackRating;
};

type ScheduledReview = {
  feedbackId: string;
  reviewId: string;
  status: ConversationReviewStatus;
  scheduled: boolean;
  reused: boolean;
};

const CANARY_EXECUTION_ENTITY = 'learning_review_canary_execution';

@Injectable()
export class ConversationReviewService implements OnModuleInit {
  private readonly logger = new Logger(ConversationReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly model: ReviewModelService,
    @InjectQueue(LEARNING_REVIEW_QUEUE)
    private readonly queue: Queue<ReviewJobData>,
    private readonly canary: ReviewCanaryPolicy,
  ) {}

  private enabled(): boolean {
    return (
      this.config.get<string>('LEARNING_REVIEW_ENABLED', 'false') === 'true'
    );
  }

  private dailyLimit(): number {
    const value = Number(
      this.config.get<string>('LEARNING_REVIEW_DAILY_LIMIT', '10'),
    );
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : 10;
  }

  private async pausedByErrors(): Promise<boolean> {
    const failures = await this.prisma.conversationReview.count({
      where: {
        status: ConversationReviewStatus.FAILED,
        updatedAt: { gte: new Date(Date.now() - 3600_000) },
      },
    });
    return failures >= 3;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled() || this.canary.allowedIds().length === 0) return;
    const pending = await this.prisma.conversationReview.findMany({
      where: {
        status: ConversationReviewStatus.PENDING,
        trigger: ConversationReviewTrigger.BAD_FEEDBACK,
        feedbackId: { in: this.canary.allowedIds() },
      },
      select: { id: true },
      take: this.dailyLimit(),
      orderBy: { createdAt: 'asc' },
    });
    for (const review of pending) {
      try {
        await this.enqueue(review.id);
      } catch {
        this.logger.warn('No se pudo reencolar una revisión pendiente');
      }
    }
  }

  async scheduleBadFeedback(
    feedback: FeedbackRef,
  ): Promise<ScheduledReview | null> {
    if (
      !this.enabled() ||
      feedback.rating !== FeedbackRating.BAD ||
      !this.canary.isFeedbackAllowed(feedback.id) ||
      (await this.pausedByErrors())
    )
      return null;
    const source = await this.prisma.automatedDelivery.findFirst({
      where: {
        outboundMessageId: feedback.messageId,
        status: 'CONFIRMED',
      },
      select: { sourceMessageId: true },
    });
    if (!source) return null;
    const reviewKey = `${REVIEWER_VERSION}:${ConversationReviewTrigger.BAD_FEEDBACK}:${feedback.id}`;
    const incompatible = await this.prisma.conversationReview.findFirst({
      where: { feedbackId: feedback.id, reviewKey: { not: reviewKey } },
      select: { id: true },
    });
    if (incompatible) return null;
    const prior = await this.prisma.conversationReview.findUnique({
      where: { reviewKey },
      select: { id: true, status: true },
    });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (!prior) {
      const scheduled = await this.prisma.conversationReview.count({
        where: { createdAt: { gte: today } },
      });
      if (scheduled >= this.dailyLimit()) return null;
    }

    let review: { id: string; status: ConversationReviewStatus };
    let raceRecovered = false;
    try {
      review = await this.prisma.conversationReview.upsert({
        where: { reviewKey },
        create: {
          reviewKey,
          conversationId: feedback.conversationId,
          sourceMessageId: source.sourceMessageId,
          feedbackId: feedback.id,
          reviewerVersion: REVIEWER_VERSION,
          trigger: ConversationReviewTrigger.BAD_FEEDBACK,
        },
        update: {},
        select: { id: true, status: true },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      )
        throw error;
      // Prisma's read-then-create upsert can lose a concurrent insert.
      review = await this.prisma.conversationReview.findUniqueOrThrow({
        where: { reviewKey },
        select: { id: true, status: true },
      });
      raceRecovered = true;
    }
    if (review.status === ConversationReviewStatus.PENDING)
      await this.enqueue(review.id);
    this.logger.log(
      `review canary scheduled feedback=${feedback.id} review=${review.id}`,
    );
    return {
      feedbackId: feedback.id,
      reviewId: review.id,
      status: review.status,
      scheduled: review.status === ConversationReviewStatus.PENDING,
      reused: Boolean(prior) || raceRecovered,
    };
  }

  scheduleIncident(input: {
    conversationId: string;
    sourceMessageId: string;
    code: string;
  }): Promise<void> {
    // The canary admits only reviews tied to an explicitly allowed feedbackId.
    void input;
    return Promise.resolve();
  }

  async triggerCanary(
    dto: ReviewCanaryTriggerDto,
    userId: string,
  ): Promise<ScheduledReview> {
    if (!this.enabled())
      throw new ServiceUnavailableException('El reviewer está apagado');
    const feedbackId = dto.feedbackId.toLowerCase();
    const requestKey = dto.requestKey.toLowerCase();
    this.canary.assertFeedbackAllowed(feedbackId);
    const feedback = await this.prisma.conversationFeedback.findUnique({
      where: { id: feedbackId },
      select: { id: true, conversationId: true, messageId: true, rating: true },
    });
    if (!feedback) throw new NotFoundException('Feedback inexistente');
    if (feedback.rating !== FeedbackRating.BAD)
      throw new BadRequestException('El feedback debe ser BAD');
    const message = await this.prisma.message.findFirst({
      where: {
        id: feedback.messageId,
        conversationId: feedback.conversationId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        wamid: { not: null },
      },
      select: { id: true },
    });
    if (!message) throw new BadRequestException('Mensaje Hermes no elegible');
    const delivery = await this.prisma.automatedDelivery.findFirst({
      where: { outboundMessageId: feedback.messageId, status: 'CONFIRMED' },
      select: { sourceMessageId: true },
    });
    if (!delivery) throw new BadRequestException('Entrega no confirmada');
    const baseReviewKey = `${REVIEWER_VERSION}:${ConversationReviewTrigger.BAD_FEEDBACK}:${feedbackId}`;
    const recanaryOfReviewId = dto.recanaryOfReviewId?.toLowerCase();

    // Lock the feedback before the request key so concurrent requests for the
    // same feedback cannot create separate executions. Both bindings and the
    // review are committed together, before a job can be queued.
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS one FROM pg_advisory_xact_lock(hashtext('learning-review-feedback'), hashtext(${feedbackId}))`;
      await tx.$queryRaw`SELECT 1 AS one FROM pg_advisory_xact_lock(hashtext('learning-review-canary'), hashtext(${requestKey}))`;
      const previous = await tx.auditLog.findFirst({
        where: {
          entity: 'learning_review_canary_request',
          entityId: requestKey,
        },
        select: { changes: true },
      });
      if (previous) {
        const changes = previous.changes;
        const binding =
          changes && typeof changes === 'object' && !Array.isArray(changes)
            ? changes
            : null;
        const boundFeedbackId = binding?.feedbackId;
        if (boundFeedbackId !== feedbackId)
          throw new ConflictException(
            'La clave de solicitud ya pertenece a otro feedback',
          );
        if ((binding?.recanaryOfReviewId ?? undefined) !== recanaryOfReviewId)
          throw new ConflictException(
            'La clave de solicitud ya pertenece a otra autorización',
          );
        const reviewId =
          typeof binding?.reviewId === 'string' ? binding.reviewId : null;
        const review = await tx.conversationReview.findUnique({
          where: reviewId ? { id: reviewId } : { reviewKey: baseReviewKey },
          select: { id: true, status: true, feedbackId: true },
        });
        if (!review || review.feedbackId !== feedbackId)
          throw new ConflictException('La revisión vinculada no existe');
        return {
          feedbackId,
          reviewId: review.id,
          status: review.status,
          scheduled: review.status === ConversationReviewStatus.PENDING,
          reused: true,
        };
      }

      const baseReview = await tx.conversationReview.findUnique({
        where: { reviewKey: baseReviewKey },
        select: {
          id: true,
          status: true,
          feedbackId: true,
          conversationId: true,
          sourceMessageId: true,
        },
      });
      let reviewKey = baseReviewKey;
      if (recanaryOfReviewId) {
        if (
          !baseReview ||
          baseReview.id !== recanaryOfReviewId ||
          baseReview.feedbackId !== feedbackId ||
          baseReview.conversationId !== feedback.conversationId ||
          baseReview.status !== ConversationReviewStatus.FAILED
        )
          throw new ConflictException(
            'El review indicado no es el FAILED histórico',
          );
        const marker = await tx.auditLog.findFirst({
          where: { entity: CANARY_EXECUTION_ENTITY, entityId: baseReview.id },
          select: { id: true },
        });
        const legacyRequest = marker
          ? null
          : await tx.auditLog.findFirst({
              where: {
                entity: 'learning_review_canary_request',
                changes: { path: ['feedbackId'], equals: feedbackId },
              },
              select: { id: true },
            });
        if (!marker && !legacyRequest)
          throw new ConflictException(
            'El review FAILED no proviene de un canary manual',
          );
        const existingReviews = await tx.conversationReview.count({
          where: { feedbackId },
        });
        if (existingReviews !== 1)
          throw new ConflictException(
            'Ya existe otra evaluación de este feedback',
          );
        reviewKey = `${baseReviewKey}:RECANARY:${requestKey}`;
      } else {
        if (
          baseReview ||
          (await tx.conversationReview.count({ where: { feedbackId } })) !== 0
        )
          throw new ConflictException(
            'Ya existe una revisión; una nueva evaluación requiere autorización explícita',
          );
      }

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const scheduled = await tx.conversationReview.count({
        where: { createdAt: { gte: today } },
      });
      const failures = await tx.conversationReview.count({
        where: {
          status: ConversationReviewStatus.FAILED,
          updatedAt: { gte: new Date(Date.now() - 3600_000) },
        },
      });
      if (scheduled >= this.dailyLimit() || failures >= 3)
        throw new ServiceUnavailableException('La revisión no se pudo agendar');
      let review: { id: string; status: ConversationReviewStatus };
      try {
        review = await tx.conversationReview.create({
          data: {
            reviewKey,
            conversationId: feedback.conversationId,
            sourceMessageId: recanaryOfReviewId
              ? baseReview!.sourceMessageId
              : delivery.sourceMessageId,
            feedbackId,
            reviewerVersion: REVIEWER_VERSION,
            trigger: ConversationReviewTrigger.BAD_FEEDBACK,
          },
          select: { id: true, status: true },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        )
          throw error;
        throw new ConflictException('La revisión cambió durante la solicitud');
      }
      await tx.auditLog.create({
        data: {
          userId,
          action: 'LEARNING_REVIEW_CANARY_EXECUTION',
          entity: CANARY_EXECUTION_ENTITY,
          entityId: review.id,
          changes: {
            feedbackId,
            recanaryOfReviewId: recanaryOfReviewId ?? null,
          },
        },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'LEARNING_REVIEW_CANARY_REQUEST',
          entity: 'learning_review_canary_request',
          entityId: requestKey,
          changes: {
            feedbackId,
            reviewId: review.id,
            ...(recanaryOfReviewId ? { recanaryOfReviewId } : {}),
          },
        },
      });
      return {
        feedbackId,
        reviewId: review.id,
        status: review.status,
        scheduled: review.status === ConversationReviewStatus.PENDING,
        reused: false,
      };
    });
    if (result.scheduled) await this.enqueue(result.reviewId);
    return result;
  }

  private async enqueue(reviewId: string): Promise<void> {
    const canary = await this.prisma.auditLog.findFirst({
      where: { entity: CANARY_EXECUTION_ENTITY, entityId: reviewId },
      select: { id: true },
    });
    await this.queue.add(
      'review',
      { reviewId },
      { jobId: `review-${reviewId}`, ...(canary ? { attempts: 1 } : {}) },
    );
  }

  async process(reviewId: string): Promise<void> {
    if (!this.enabled()) return;
    const review = await this.prisma.conversationReview.findUniqueOrThrow({
      where: { id: reviewId },
      include: { feedback: true },
    });
    if (
      review.trigger !== ConversationReviewTrigger.BAD_FEEDBACK ||
      !this.canary.isFeedbackAllowed(review.feedbackId)
    )
      return;
    const manualCanary = Boolean(
      await this.prisma.auditLog.findFirst({
        where: { entity: CANARY_EXECUTION_ENTITY, entityId: reviewId },
        select: { id: true },
      }),
    );
    const stale = new Date(Date.now() - 10 * 60_000);
    const claim = await this.prisma.conversationReview.updateMany({
      where: {
        id: reviewId,
        feedbackId: review.feedbackId,
        trigger: ConversationReviewTrigger.BAD_FEEDBACK,
        attempts: { lt: manualCanary ? 1 : 3 },
        OR: manualCanary
          ? [{ status: ConversationReviewStatus.PENDING }]
          : [
              { status: ConversationReviewStatus.PENDING },
              { status: ConversationReviewStatus.FAILED },
              {
                status: ConversationReviewStatus.PROCESSING,
                processingAt: { lt: stale },
              },
            ],
      },
      data: {
        status: ConversationReviewStatus.PROCESSING,
        processingAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claim.count !== 1) return;

    try {
      if (
        review.trigger === ConversationReviewTrigger.BAD_FEEDBACK &&
        (!review.feedback || review.feedback.rating !== FeedbackRating.BAD)
      ) {
        await this.prisma.conversationReview.update({
          where: { id: reviewId },
          data: { status: ConversationReviewStatus.NO_LEARNING },
        });
        return;
      }
      const source = await this.prisma.message.findUnique({
        where: { id: review.sourceMessageId },
        select: { createdAt: true },
      });
      if (!source) {
        await this.prisma.conversationReview.update({
          where: { id: reviewId },
          data: {
            status: ConversationReviewStatus.NO_LEARNING,
            summary: 'Mensaje de origen no disponible',
          },
        });
        return;
      }
      const messages = await this.prisma.message.findMany({
        where: {
          conversationId: review.conversationId,
          createdAt: {
            gte: new Date(source.createdAt.getTime() - 24 * 3600_000),
            lte: review.feedback?.createdAt || review.createdAt,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, sender: true, content: true },
      });
      const ordered = messages.reverse();
      const evidenceIds = new Map<string, string>();
      const input = ordered.map((message, index) => {
        const alias = `m${index + 1}`;
        evidenceIds.set(alias, message.id);
        return {
          id: alias,
          sender: message.sender,
          content: sanitizeReviewInput(message.content || ''),
        };
      });
      if (!ordered.some((message) => message.id === review.sourceMessageId)) {
        await this.prisma.conversationReview.update({
          where: { id: reviewId },
          data: {
            status: ConversationReviewStatus.NO_LEARNING,
            summary: 'Sin ventana de evidencia suficiente',
          },
        });
        return;
      }
      const output = parseReviewOutput(
        await this.model.review(
          input,
          sanitizeReviewInput(
            review.feedback?.reasonCode || review.issueCode || 'INCIDENT',
          ),
          review.feedback?.suggestedReply
            ? sanitizeReviewInput(review.feedback.suggestedReply)
            : null,
        ),
        new Set(input.map((message) => message.id)),
      );
      if (!output.candidate) {
        await this.prisma.conversationReview.update({
          where: { id: reviewId },
          data: {
            status: ConversationReviewStatus.NO_LEARNING,
            issueCode: output.issueCode,
            summary: output.summary,
            counterexample: output.counterexample,
            confidence: output.confidence,
            providerModel: this.model.modelName(),
          },
        });
        return;
      }
      const candidate = output.candidate;
      const resolvedEvidenceIds = candidate.evidenceMessageIds.map((id) =>
        evidenceIds.get(id),
      );
      if (resolvedEvidenceIds.some((id) => !id))
        throw new Error('REVIEW_CANDIDATE_INVALID');
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            candidate.kind.toLowerCase(),
            candidate.trigger.toLowerCase(),
            candidate.guidance.toLowerCase(),
            candidate.serviceCode?.toLowerCase() || '',
            candidate.market?.toLowerCase() || '',
          ]),
        )
        .digest('hex');
      await this.prisma.$transaction(async (tx) => {
        const item = await tx.learningItem.upsert({
          where: { fingerprint_version: { fingerprint, version: 1 } },
          create: {
            fingerprint,
            version: 1,
            kind: candidate.kind,
            trigger: candidate.trigger,
            guidance: candidate.guidance,
            serviceCode: candidate.serviceCode,
            market: candidate.market,
            riskLevel: LearningRiskLevel.NEEDS_REVIEW,
            sourceReviewId: reviewId,
          },
          update: {},
          select: { id: true },
        });
        await tx.learningEvidence.upsert({
          where: {
            learningItemId_conversationId: {
              learningItemId: item.id,
              conversationId: review.conversationId,
            },
          },
          create: {
            learningItemId: item.id,
            conversationId: review.conversationId,
            messageId: resolvedEvidenceIds[0],
            feedbackId: review.feedbackId,
            reviewId,
          },
          update: {},
        });
        await tx.conversationReview.update({
          where: { id: reviewId },
          data: {
            status: ConversationReviewStatus.PROPOSED,
            issueCode: output.issueCode,
            summary: output.summary,
            counterexample: output.counterexample,
            confidence: output.confidence,
            providerModel: this.model.modelName(),
          },
        });
      });
    } catch (error) {
      await this.prisma.conversationReview.update({
        where: { id: reviewId },
        data: {
          status: ConversationReviewStatus.FAILED,
          ...(error instanceof Error &&
          /^(?:PRIVACY|COMMERCIAL)_VALIDATION_FAILED:/.test(error.message)
            ? { summary: error.message }
            : {}),
        },
      });
      this.logger.warn(
        `Revisión fallida: ${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      throw error;
    }
  }

  async listCandidates() {
    return this.prisma.learningItem.findMany({
      where: {
        status: {
          in: [
            LearningItemStatus.PROPOSED,
            LearningItemStatus.ACTIVE,
            LearningItemStatus.RETIRED,
            LearningItemStatus.REJECTED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        version: true,
        kind: true,
        trigger: true,
        guidance: true,
        serviceCode: true,
        market: true,
        riskLevel: true,
        status: true,
        validUntil: true,
        approvedAt: true,
        createdAt: true,
        sourceReview: {
          select: {
            issueCode: true,
            summary: true,
            counterexample: true,
            confidence: true,
          },
        },
        _count: { select: { evidence: true } },
        evidence: {
          take: 1,
          select: { conversationId: true, messageId: true },
        },
      },
    });
  }

  async decide(id: string, dto: LearningDecisionDto, userId: string) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 10 || reason.length > 500)
      throw new BadRequestException('Motivo de 10 a 500 caracteres requerido');
    if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d\s().-]{7,}\d)/i.test(reason))
      throw new BadRequestException(
        'El motivo no debe contener datos de contacto',
      );
    const approval = dto.action === LearningDecisionAction.APPROVE;
    const previous =
      dto.action === LearningDecisionAction.RETIRE
        ? LearningItemStatus.ACTIVE
        : LearningItemStatus.PROPOSED;
    const next =
      dto.action === LearningDecisionAction.APPROVE
        ? LearningItemStatus.ACTIVE
        : dto.action === LearningDecisionAction.REJECT
          ? LearningItemStatus.REJECTED
          : LearningItemStatus.RETIRED;
    if (!Object.values(LearningDecisionAction).includes(dto.action))
      throw new BadRequestException('Decisión inválida');
    if (!userId) throw new BadRequestException('Operador requerido');
    const until = approval && dto.validUntil ? new Date(dto.validUntil) : null;
    if (
      approval &&
      (!until ||
        !Number.isFinite(until.getTime()) ||
        until.getTime() <= Date.now() ||
        until.getTime() > Date.now() + 180 * 86400_000)
    )
      throw new BadRequestException(
        'Vencimiento futuro de hasta 180 días requerido',
      );
    if (!approval && dto.validUntil)
      throw new BadRequestException(
        'El vencimiento sólo corresponde a aprobación',
      );
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.learningItem.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          version: true,
          kind: true,
          trigger: true,
          guidance: true,
          serviceCode: true,
          market: true,
          sourceReview: {
            select: { issueCode: true, summary: true, counterexample: true },
          },
          _count: { select: { evidence: true } },
        },
      });
      if (!item) throw new NotFoundException('Candidato inexistente');
      if (item.status !== previous)
        throw new ConflictException('El candidato cambió de estado');
      if (approval && item._count.evidence < 1)
        throw new BadRequestException('No existe evidencia para aprobar');
      if (approval) {
        try {
          validateCandidateSafety(item);
          for (const value of [
            item.sourceReview?.issueCode,
            item.sourceReview?.summary,
            item.sourceReview?.counterexample,
          ]) {
            if (value && privacyFailure(value))
              throw new Error('PRIVACY_VALIDATION_FAILED:REVIEW_METADATA');
          }
        } catch {
          throw new BadRequestException(
            'El candidato no supera la validación de seguridad',
          );
        }
      }
      const updated = await tx.learningItem.updateMany({
        where: { id, status: previous },
        data: {
          status: next,
          ...(approval
            ? {
                validUntil: until,
                approvedById: userId,
                approvedAt: new Date(),
              }
            : {}),
        },
      });
      if (updated.count !== 1)
        throw new ConflictException('El candidato cambió de estado');
      await tx.auditLog.create({
        data: {
          userId,
          action: `LEARNING_${dto.action}`,
          entity: 'learning_items',
          entityId: id,
          changes: {
            version: item.version,
            before: previous,
            after: next,
            reason,
            validUntil: until?.toISOString() ?? null,
          },
        },
      });
      return tx.learningItem.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          status: true,
          version: true,
          validUntil: true,
          approvedAt: true,
        },
      });
    });
  }

  async recordShadowMatches(input: {
    conversationId: string;
    inboundMessageId: string;
    customerMessage: string;
    serviceCode?: string;
    market?: string;
    engine: string;
  }): Promise<void> {
    if (this.config.get<string>('LEARNING_SHADOW_ENABLED', 'false') !== 'true')
      return;
    const started = Date.now();
    const now = new Date();
    const items = await this.prisma.learningItem.findMany({
      where: {
        status: LearningItemStatus.ACTIVE,
        validUntil: { gt: now },
        OR: [
          { serviceCode: null },
          ...(input.serviceCode ? [{ serviceCode: input.serviceCode }] : []),
        ],
        AND: [
          {
            OR: [
              { market: null },
              ...(input.market ? [{ market: input.market }] : []),
            ],
          },
        ],
      },
      select: { id: true, version: true, trigger: true },
      take: 100,
    });
    const tokens = new Set(
      input.customerMessage.toLocaleLowerCase('es').match(/[\p{L}]{4,}/gu) ||
        [],
    );
    const matches = items
      .map((item) => ({
        id: item.id,
        version: item.version,
        score: (
          item.trigger.toLocaleLowerCase('es').match(/[\p{L}]{4,}/gu) || []
        ).filter((word) => tokens.has(word)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3);
    this.logger.log(
      JSON.stringify({
        event: 'learning_shadow_retrieval',
        conversationId: input.conversationId,
        inboundMessageId: input.inboundMessageId,
        engine: input.engine,
        matches,
        elapsedMs: Date.now() - started,
      }),
    );
  }
}

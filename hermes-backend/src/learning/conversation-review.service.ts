import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  ConversationReviewTrigger,
  FeedbackRating,
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

function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[correo]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[teléfono]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[número]')
    .slice(0, 500);
}

@Injectable()
export class ConversationReviewService implements OnModuleInit {
  private readonly logger = new Logger(ConversationReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly model: ReviewModelService,
    @InjectQueue(LEARNING_REVIEW_QUEUE)
    private readonly queue: Queue<ReviewJobData>,
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
    if (!this.enabled()) return;
    const pending = await this.prisma.conversationReview.findMany({
      where: { status: ConversationReviewStatus.PENDING },
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

  async scheduleBadFeedback(feedback: FeedbackRef): Promise<void> {
    if (
      !this.enabled() ||
      feedback.rating !== FeedbackRating.BAD ||
      (await this.pausedByErrors())
    )
      return;
    const source = await this.prisma.automatedDelivery.findFirst({
      where: {
        outboundMessageId: feedback.messageId,
        status: 'CONFIRMED',
      },
      select: { sourceMessageId: true },
    });
    if (!source) return;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const scheduled = await this.prisma.conversationReview.count({
      where: { createdAt: { gte: today } },
    });
    if (scheduled >= this.dailyLimit()) return;

    const reviewKey = `${REVIEWER_VERSION}:${ConversationReviewTrigger.BAD_FEEDBACK}:${feedback.id}`;
    const review = await this.prisma.conversationReview.upsert({
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
    if (review.status === ConversationReviewStatus.PENDING)
      await this.enqueue(review.id);
  }

  async scheduleIncident(input: {
    conversationId: string;
    sourceMessageId: string;
    code: string;
  }): Promise<void> {
    if (!this.enabled() || (await this.pausedByErrors())) return;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const scheduled = await this.prisma.conversationReview.count({
      where: { createdAt: { gte: today } },
    });
    if (scheduled >= this.dailyLimit()) return;
    const reviewKey = `${REVIEWER_VERSION}:${ConversationReviewTrigger.INCIDENT}:${input.sourceMessageId}:${input.code}`;
    const review = await this.prisma.conversationReview.upsert({
      where: { reviewKey },
      create: {
        reviewKey,
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        reviewerVersion: REVIEWER_VERSION,
        trigger: ConversationReviewTrigger.INCIDENT,
        issueCode: input.code.slice(0, 60),
      },
      update: {},
      select: { id: true, status: true },
    });
    if (review.status === ConversationReviewStatus.PENDING)
      await this.enqueue(review.id);
  }

  private async enqueue(reviewId: string): Promise<void> {
    await this.queue.add(
      'review',
      { reviewId },
      { jobId: `review-${reviewId}` },
    );
  }

  async process(reviewId: string): Promise<void> {
    if (!this.enabled()) return;
    const stale = new Date(Date.now() - 10 * 60_000);
    const claim = await this.prisma.conversationReview.updateMany({
      where: {
        id: reviewId,
        attempts: { lt: 3 },
        OR: [
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
      const review = await this.prisma.conversationReview.findUniqueOrThrow({
        where: { id: reviewId },
        include: { feedback: true },
      });
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
      const input = messages.reverse().map((message) => ({
        id: message.id,
        sender: message.sender,
        content: redact(message.content || ''),
      }));
      if (!input.some((message) => message.id === review.sourceMessageId)) {
        await this.prisma.conversationReview.update({
          where: { id: reviewId },
          data: {
            status: ConversationReviewStatus.NO_LEARNING,
            summary: 'Sin ventana de evidencia suficiente',
          },
        });
        return;
      }
      const output = await this.model.review(
        input,
        review.feedback?.reasonCode || review.issueCode || 'INCIDENT',
        review.feedback?.suggestedReply
          ? redact(review.feedback.suggestedReply)
          : null,
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
            messageId: candidate.evidenceMessageIds[0],
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
        data: { status: ConversationReviewStatus.FAILED },
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
          _count: { select: { evidence: true } },
        },
      });
      if (!item) throw new NotFoundException('Candidato inexistente');
      if (item.status !== previous)
        throw new ConflictException('El candidato cambió de estado');
      if (approval && item._count.evidence < 1)
        throw new BadRequestException('No existe evidencia para aprobar');
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

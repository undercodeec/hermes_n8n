import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  ConversationReviewTrigger,
  FeedbackRating,
  LearningRiskLevel,
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
      where: { status: 'PROPOSED' },
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
}

import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  FeedbackRating,
  MessageSender,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationReviewService } from './conversation-review.service';
import { ReviewJobData } from './learning.constants';
import { ReviewModelService } from './review-model.service';
import { parseReviewOutput } from './review-output.validator';

describe('Fase 2: revisión aislada', () => {
  const prisma = {
    automatedDelivery: { findFirst: jest.fn() },
    conversationReview: {
      count: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    message: { findUnique: jest.fn(), findMany: jest.fn() },
    learningItem: { upsert: jest.fn(), findMany: jest.fn() },
    learningEvidence: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const queue = { add: jest.fn() };
  const model = { review: jest.fn(), modelName: jest.fn(() => 'review-model') };
  const config = {
    get: jest.fn((name: string, fallback?: string) =>
      name === 'LEARNING_REVIEW_ENABLED' ? 'true' : fallback,
    ),
  };
  const service = new ConversationReviewService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    model as unknown as ReviewModelService,
    queue as unknown as Queue<ReviewJobData>,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockImplementation((name: string, fallback?: string) =>
      name === 'LEARNING_REVIEW_ENABLED' ? 'true' : fallback,
    );
    model.modelName.mockReturnValue('review-model');
    prisma.conversationReview.count.mockResolvedValue(0);
    prisma.automatedDelivery.findFirst.mockResolvedValue({
      sourceMessageId: 'inbound-1',
    });
    prisma.conversationReview.upsert.mockResolvedValue({
      id: 'review-1',
      status: ConversationReviewStatus.PENDING,
    });
    queue.add.mockResolvedValue({});
  });

  it('no agenda una revisión si la flag está apagada', async () => {
    config.get.mockReturnValue('false');
    await service.scheduleBadFeedback({
      id: 'feedback-1',
      conversationId: 'conversation-1',
      messageId: 'reply-1',
      rating: FeedbackRating.BAD,
    });
    expect(prisma.automatedDelivery.findFirst).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('usa un mensaje realmente confirmado y una clave estable por feedback', async () => {
    await service.scheduleBadFeedback({
      id: 'feedback-1',
      conversationId: 'conversation-1',
      messageId: 'reply-1',
      rating: FeedbackRating.BAD,
    });
    expect(prisma.automatedDelivery.findFirst).toHaveBeenCalledWith({
      where: { outboundMessageId: 'reply-1', status: 'CONFIRMED' },
      select: { sourceMessageId: true },
    });
    expect(prisma.conversationReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reviewKey: 'feedback-review-v1:BAD_FEEDBACK:feedback-1' },
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'review',
      { reviewId: 'review-1' },
      { jobId: 'review-review-1' },
    );
  });

  it('falla cerrado si no hay entrega confirmada o se agotó la cuota', async () => {
    prisma.automatedDelivery.findFirst.mockResolvedValueOnce(null);
    const feedback = {
      id: 'feedback-1',
      conversationId: 'conversation-1',
      messageId: 'reply-1',
      rating: FeedbackRating.BAD,
    };
    await service.scheduleBadFeedback(feedback);
    expect(queue.add).not.toHaveBeenCalled();
    prisma.conversationReview.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(10);
    await service.scheduleBadFeedback(feedback);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('guarda NO_LEARNING sin crear candidato cuando la evidencia no alcanza', async () => {
    prisma.conversationReview.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversationReview.findUniqueOrThrow.mockResolvedValue({
      id: 'review-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'inbound-1',
      trigger: 'BAD_FEEDBACK',
      issueCode: null,
      createdAt: new Date(),
      feedback: {
        rating: FeedbackRating.BAD,
        reasonCode: 'REPETITION',
        suggestedReply: null,
        createdAt: new Date(),
      },
    });
    prisma.message.findUnique.mockResolvedValue({ createdAt: new Date() });
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'inbound-1',
        sender: MessageSender.CONTACT,
        content: 'Mi correo es test@example.com',
      },
    ]);
    model.review.mockResolvedValue({
      issueCode: 'REPETITION',
      summary: 'Respuesta repetitiva',
      counterexample: null,
      confidence: 0.6,
      candidate: null,
    });
    await service.process('review-1');
    expect(model.review).toHaveBeenCalledWith(
      [
        {
          id: 'inbound-1',
          sender: MessageSender.CONTACT,
          content: 'Mi correo es [correo]',
        },
      ],
      'REPETITION',
      null,
    );
    const updates = prisma.conversationReview.update.mock
      .calls as unknown as Array<
      [{ data: { status: ConversationReviewStatus } }]
    >;
    expect(updates[0][0].data.status).toBe(
      ConversationReviewStatus.NO_LEARNING,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechaza candidatos sin evidencia exacta y con datos personales', () => {
    const base = {
      issueCode: 'REPETITION',
      summary: 'Repetición observada',
      counterexample: null,
      confidence: 0.7,
      candidate: {
        kind: 'STYLE',
        trigger: 'Si repite una pregunta',
        guidance: 'Resumir y avanzar',
        evidenceMessageIds: ['inbound-1'],
      },
    };
    expect(() => parseReviewOutput(base, new Set(['inbound-1']))).not.toThrow();
    expect(() =>
      parseReviewOutput(
        {
          ...base,
          candidate: { ...base.candidate, evidenceMessageIds: ['other'] },
        },
        new Set(['inbound-1']),
      ),
    ).toThrow();
    expect(() =>
      parseReviewOutput(
        {
          ...base,
          candidate: {
            ...base.candidate,
            guidance: 'Contactar a test@example.com',
          },
        },
        new Set(['inbound-1']),
      ),
    ).toThrow();
  });
});

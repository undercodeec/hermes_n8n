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
import { ReviewCanaryPolicy } from './review-canary.policy';
import { parseReviewOutput } from './review-output.validator';

describe('Fase 2: revisión aislada', () => {
  const prisma = {
    auditLog: { findFirst: jest.fn() },
    automatedDelivery: { findFirst: jest.fn() },
    conversationReview: {
      count: jest.fn(),
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
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
    {
      isFeedbackAllowed: () => true,
      allowedIds: () => ['feedback-1'],
    } as unknown as ReviewCanaryPolicy,
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
    prisma.conversationReview.findUnique.mockResolvedValue(null);
    prisma.conversationReview.findFirst.mockResolvedValue(null);
    prisma.auditLog.findFirst.mockResolvedValue(null);
  });

  function prepareProcess(guidance: string) {
    prisma.conversationReview.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversationReview.findUniqueOrThrow.mockResolvedValue({
      id: 'review-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'inbound-1',
      trigger: 'BAD_FEEDBACK',
      feedbackId: 'feedback-1',
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
        content: 'Soy Juan Pérez y necesito ayuda',
      },
    ]);
    model.review.mockResolvedValue({
      issueCode: 'REPETITION',
      summary: 'La respuesta repitió una pregunta',
      counterexample: null,
      confidence: 0.8,
      candidate: {
        kind: 'STYLE',
        trigger: 'Cuando el cliente corrige un dato',
        guidance,
        evidenceMessageIds: ['m1'],
      },
    });
  }

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
          id: 'm1',
          sender: MessageSender.CONTACT,
          content: 'Mi correo es [EMAIL_PATTERN]',
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

  it.each([
    [
      'privacidad',
      'Recordar que Juan Pérez necesita 15 usuarios.',
      'PRIVACY_VALIDATION_FAILED',
    ],
    [
      'comercio',
      'Ofrecer 20% de descuento si paga por transferencia.',
      'COMMERCIAL_VALIDATION_FAILED',
    ],
  ])(
    'falla antes de persistir un candidato por %s, incluso al reintentar',
    async (_label, guidance, code) => {
      prepareProcess(guidance);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(service.process('review-1')).rejects.toThrow(code);
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.learningItem.upsert).not.toHaveBeenCalled();
      const updates = prisma.conversationReview.update.mock
        .calls as unknown as Array<
        [{ data: { status: ConversationReviewStatus; summary?: string } }]
      >;
      expect(updates.at(-1)?.[0].data.status).toBe(
        ConversationReviewStatus.FAILED,
      );
      expect(updates.at(-1)?.[0].data.summary).toContain(code);
      const reviewCalls = model.review.mock.calls as unknown as Array<
        [
          Array<{
            id: string;
            content: string;
          }>,
        ]
      >;
      const sent = reviewCalls[0][0];
      expect(sent[0].id).toBe('m1');
      expect(sent[0].content).not.toContain('Juan Pérez');
    },
  );

  it('persiste una pauta segura con evidencia original y fingerprint estable', async () => {
    prepareProcess(
      'Cuando el cliente corrija un dato, usar el valor más reciente.',
    );
    const tx = {
      learningItem: { upsert: jest.fn().mockResolvedValue({ id: 'item-1' }) },
      learningEvidence: { upsert: jest.fn().mockResolvedValue({}) },
      conversationReview: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    await service.process('review-1');
    await service.process('review-1');
    expect(tx.learningItem.upsert).toHaveBeenCalledTimes(2);
    const itemCalls = tx.learningItem.upsert.mock.calls as unknown as Array<
      [{ where: unknown; create: { guidance: string } }]
    >;
    const first = itemCalls[0][0];
    const second = itemCalls[1][0];
    expect(first.where).toEqual(second.where);
    expect(first.create.guidance).toBe(
      'Cuando el cliente corrija un dato, usar el valor más reciente.',
    );
    const evidenceCalls = tx.learningEvidence.upsert.mock
      .calls as unknown as Array<[{ create: { messageId: string } }]>;
    expect(evidenceCalls[0][0].create.messageId).toBe('inbound-1');
    const reviewUpdates = tx.conversationReview.update.mock
      .calls as unknown as Array<
      [{ data: { status: ConversationReviewStatus } }]
    >;
    expect(reviewUpdates[0][0].data.status).toBe(
      ConversationReviewStatus.PROPOSED,
    );
  });

  it('resuelve el alias de evidencia cuando hay varios mensajes', async () => {
    prepareProcess('Usar la corrección más reciente del cliente.');
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'reply-1',
        sender: MessageSender.HERMES,
        content: '¿Cuántos usuarios?',
      },
      {
        id: 'inbound-1',
        sender: MessageSender.CONTACT,
        content: 'Son 15 usuarios.',
      },
    ]);
    model.review.mockResolvedValue({
      issueCode: 'REPETITION',
      summary: 'Pregunta repetida',
      counterexample: null,
      confidence: 0.8,
      candidate: {
        kind: 'STYLE',
        trigger: 'Cuando el cliente corrige un dato',
        guidance: 'Usar la corrección más reciente del cliente.',
        evidenceMessageIds: ['m2'],
      },
    });
    const tx = {
      learningItem: { upsert: jest.fn().mockResolvedValue({ id: 'item-1' }) },
      learningEvidence: { upsert: jest.fn().mockResolvedValue({}) },
      conversationReview: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    await service.process('review-1');
    const evidenceCalls = tx.learningEvidence.upsert.mock
      .calls as unknown as Array<[{ create: { messageId: string } }]>;
    expect(evidenceCalls[0][0].create.messageId).toBe('reply-1');
  });
});

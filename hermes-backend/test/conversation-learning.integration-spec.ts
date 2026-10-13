import { ConfigService } from '@nestjs/config';
import {
  AutomatedDeliveryKind,
  AutomatedDeliveryStatus,
  ConversationReviewStatus,
  FeedbackRating,
  FeedbackReasonCode,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { ConversationReviewService } from '../src/learning/conversation-review.service';
import {
  LEARNING_REVIEW_QUEUE,
  REVIEWER_VERSION,
  ReviewJobData,
} from '../src/learning/learning.constants';
import { ReviewModelService } from '../src/learning/review-model.service';
import { ReviewCanaryPolicy } from '../src/learning/review-canary.policy';
import { PrismaService } from '../src/prisma/prisma.service';
import { LearningReviewProviderFixture } from './fixtures/learning-review-provider';

type Seed = {
  conversationId: string;
  feedbackId: string;
  sourceMessageId: string;
  userId: string;
};

type InvalidProviderResponse = Record<string, unknown> | string;

const invalidProviderResponses: Array<[string, InvalidProviderResponse]> = [
  ['invalid JSON', 'not json at all'],
  [
    'PII candidate',
    {
      issueCode: 'REPETITION',
      summary: 'Resumen seguro',
      counterexample: null,
      confidence: 0.7,
      candidate: {
        kind: 'FOLLOW_UP',
        trigger: 'cliente interesado',
        guidance: 'Escribir a synthetic@example.test',
        evidenceMessageIds: ['placeholder'],
      },
    },
  ],
  [
    'invalid evidence reference',
    {
      issueCode: 'REPETITION',
      summary: 'Resumen seguro',
      counterexample: null,
      confidence: 0.7,
      candidate: {
        kind: 'FOLLOW_UP',
        trigger: 'cliente interesado',
        guidance: 'Hacer una pregunta concreta',
        evidenceMessageIds: ['not-a-source-message'],
      },
    },
  ],
];

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
const postgresPort = process.env.LEARNING_TEST_POSTGRES_PORT || '55432';

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertIsolatedTargets(): void {
  if (!databaseUrl || !redisUrl)
    throw new Error(
      'DATABASE_INTEGRATION_URL and REDIS_INTEGRATION_URL are required',
    );
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== postgresPort ||
    !database.pathname.includes('hermes_learning_test') ||
    redis.hostname !== '127.0.0.1' ||
    redis.port !== '56379'
  )
    throw new Error(
      'Learning integration refuses non-isolated PostgreSQL/Redis',
    );
}

function firstEvidenceMessageId(request: Record<string, unknown>): string {
  const requestMessages = request.messages;
  if (!isUnknownArray(requestMessages) || requestMessages.length < 2)
    throw new Error('Synthetic provider did not receive review messages');
  const userMessage = requestMessages[1];
  if (
    !userMessage ||
    typeof userMessage !== 'object' ||
    isUnknownArray(userMessage) ||
    typeof (userMessage as Record<string, unknown>).content !== 'string'
  )
    throw new Error('Synthetic provider received an invalid review message');
  const payload: unknown = JSON.parse(
    (userMessage as Record<string, unknown>).content as string,
  );
  if (!payload || typeof payload !== 'object' || isUnknownArray(payload))
    throw new Error('Synthetic provider received an invalid review payload');
  const messages = (payload as Record<string, unknown>).messages;
  if (!isUnknownArray(messages) || messages.length === 0)
    throw new Error('Synthetic provider received no evidence messages');
  const first = messages[0];
  if (
    !first ||
    typeof first !== 'object' ||
    isUnknownArray(first) ||
    typeof (first as Record<string, unknown>).id !== 'string'
  )
    throw new Error('Synthetic provider received evidence without an ID');
  return (first as Record<string, unknown>).id as string;
}

describe('Conversation learning loop (isolated integration)', () => {
  let prisma: PrismaClient;
  let redis: IORedis;
  let queue: Queue<ReviewJobData>;
  let provider: LearningReviewProviderFixture;
  const allowlisted = new Set<string>();

  const config = (dailyLimit = 10) =>
    new ConfigService({
      LEARNING_REVIEW_ENABLED: 'true',
      LEARNING_REVIEW_DAILY_LIMIT: String(dailyLimit),
      HERMES_API_KEY: 'synthetic-provider-key',
      HERMES_MODEL: 'synthetic-reviewer',
      HERMES_API_URL: provider.baseUrl,
    });

  const service = (dailyLimit = 10) => {
    const settings = config(dailyLimit);
    return new ConversationReviewService(
      prisma as PrismaService,
      settings,
      new ReviewModelService(settings),
      queue,
      {
        allowedIds: () => [...allowlisted],
        isFeedbackAllowed: (id: string | null) => !!id && allowlisted.has(id),
        assertFeedbackAllowed: (id: string) => {
          if (!allowlisted.has(id)) throw new Error('Feedback not allowlisted');
        },
      } as unknown as ReviewCanaryPolicy,
    );
  };

  async function clearFixture(): Promise<void> {
    allowlisted.clear();
    await queue.obliterate({ force: true });
    await prisma.auditLog.deleteMany();
    await prisma.learningEvidence.deleteMany();
    await prisma.learningItem.deleteMany();
    await prisma.conversationReview.deleteMany();
    await prisma.conversationFeedback.deleteMany();
    await prisma.automatedDelivery.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.user.deleteMany();
    provider.requests.splice(0);
  }

  async function seed(label: string): Promise<Seed> {
    const suffix = `${label}-${randomUUID()}`;
    const user = await prisma.user.create({
      data: {
        email: `${suffix}@example.test`,
        password: 'synthetic-password-only',
        name: 'Synthetic operator',
        role: UserRole.SALES_AGENT,
      },
    });
    const contact = await prisma.contact.create({
      data: { waId: `learning-${suffix}` },
    });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const source = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content:
          'Necesito continuar el proyecto; mi correo es synthetic@example.test',
        wamid: `wamid.in.${suffix}`,
      },
    });
    const outbound = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        type: MessageType.TEXT,
        content: 'Respuesta sintética de Hermes',
        wamid: `wamid.out.${suffix}`,
      },
    });
    await prisma.automatedDelivery.create({
      data: {
        operationKey: `${source.id}:HERMES_REPLY:0`,
        deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
        partIndex: 0,
        conversationId: conversation.id,
        contactId: contact.id,
        sourceMessageId: source.id,
        outboundMessageId: outbound.id,
        sender: MessageSender.HERMES,
        content: outbound.content || '',
        status: AutomatedDeliveryStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
    });
    const feedback = await prisma.conversationFeedback.create({
      data: {
        conversationId: conversation.id,
        messageId: outbound.id,
        userId: user.id,
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
        requestKey: `feedback-${suffix}`,
      },
    });
    allowlisted.add(feedback.id);
    return {
      conversationId: conversation.id,
      feedbackId: feedback.id,
      sourceMessageId: source.id,
      userId: user.id,
    };
  }

  async function scheduleAndProcess(
    reviewService: ConversationReviewService,
    seedData: Seed,
    allowProcessorFailure = false,
  ) {
    await reviewService.scheduleBadFeedback({
      id: seedData.feedbackId,
      conversationId: seedData.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: seedData.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    const review = await prisma.conversationReview.findFirstOrThrow({
      where: { feedbackId: seedData.feedbackId },
    });
    try {
      await reviewService.process(review.id);
    } catch (error) {
      if (!allowProcessorFailure) throw error;
    }
    return prisma.conversationReview.findUniqueOrThrow({
      where: { id: review.id },
    });
  }

  async function historicFailedCanary(seedData: Seed, requestKey: string) {
    const review = await prisma.conversationReview.create({
      data: {
        reviewKey: `${REVIEWER_VERSION}:BAD_FEEDBACK:${seedData.feedbackId}`,
        conversationId: seedData.conversationId,
        sourceMessageId: seedData.sourceMessageId,
        feedbackId: seedData.feedbackId,
        reviewerVersion: REVIEWER_VERSION,
        trigger: 'BAD_FEEDBACK',
        status: ConversationReviewStatus.FAILED,
        attempts: 3,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: seedData.userId,
        action: 'LEARNING_REVIEW_CANARY_REQUEST',
        entity: 'learning_review_canary_request',
        entityId: requestKey,
        changes: { feedbackId: seedData.feedbackId },
      },
    });
    const job = await queue.add(
      'review',
      { reviewId: review.id },
      {
        jobId: `review-${review.id}`,
        attempts: 1,
        removeOnFail: false,
      },
    );
    const worker = new Worker(
      LEARNING_REVIEW_QUEUE,
      () => {
        throw new Error('synthetic historical failure');
      },
      { connection: { host: '127.0.0.1', port: 56379 }, autorun: false },
    );
    const failed = new Promise<void>((resolve, reject) => {
      worker.on('failed', (processed) => {
        if (processed?.id === job.id) resolve();
      });
      worker.on('error', reject);
    });
    const running = worker.run();
    try {
      await failed;
    } finally {
      await worker.close();
      await running;
    }
    expect(await job.getState()).toBe('failed');
    return review;
  }

  beforeAll(async () => {
    assertIsolatedTargets();
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    redis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    queue = new Queue(LEARNING_REVIEW_QUEUE, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    provider = new LearningReviewProviderFixture();
    await Promise.all([
      prisma.$connect(),
      provider.start(),
      queue.waitUntilReady(),
    ]);
  });

  beforeEach(async () => clearFixture());

  afterAll(async () => {
    await queue?.close();
    await redis?.quit();
    await provider?.stop();
    await prisma?.$disconnect();
  });

  it('stores NO_LEARNING, redacts synthetic PII, and never contacts a real provider', async () => {
    provider.setResponse({
      issueCode: 'REPETITION',
      summary: 'La evidencia no alcanza para una pauta general',
      counterexample: 'Sólo existe una conversación sintética',
      confidence: 0.4,
      candidate: null,
    });
    const result = await scheduleAndProcess(
      service(),
      await seed('no-learning'),
    );
    expect(result.status).toBe(ConversationReviewStatus.NO_LEARNING);
    expect(await prisma.learningItem.count()).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0])).toContain('[EMAIL_PATTERN]');
    expect(JSON.stringify(provider.requests[0])).not.toContain(
      'synthetic@example.test',
    );
    expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('schedules the same bad feedback idempotently in the isolated Redis queue', async () => {
    const fixture = await seed('idempotent-schedule');
    const messageId = (
      await prisma.conversationFeedback.findUniqueOrThrow({
        where: { id: fixture.feedbackId },
      })
    ).messageId;
    const reviewService = service();
    const feedback = {
      id: fixture.feedbackId,
      conversationId: fixture.conversationId,
      messageId,
      rating: FeedbackRating.BAD,
    };
    await reviewService.scheduleBadFeedback(feedback);
    await reviewService.scheduleBadFeedback(feedback);
    expect(
      await prisma.conversationReview.count({
        where: { feedbackId: fixture.feedbackId },
      }),
    ).toBe(1);
    expect(await queue.count()).toBe(1);
  });

  it('isolates manual canary scheduling with durable request keys and concurrent requests', async () => {
    const allowed = await seed('canary-allowed');
    const excluded = await seed('canary-excluded');
    allowlisted.delete(excluded.feedbackId);
    const reviewService = service();
    const requestKey = randomUUID();
    const [first, repeated] = await Promise.all([
      reviewService.triggerCanary(
        { feedbackId: allowed.feedbackId, requestKey },
        allowed.userId,
      ),
      reviewService.triggerCanary(
        { feedbackId: allowed.feedbackId, requestKey },
        allowed.userId,
      ),
    ]);
    expect(first.reviewId).toBe(repeated.reviewId);
    expect(await prisma.conversationReview.count()).toBe(1);
    expect(await queue.count()).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entity: 'learning_review_canary_request' },
      }),
    ).toBe(1);
    allowlisted.add(excluded.feedbackId);
    await expect(
      reviewService.triggerCanary(
        { feedbackId: excluded.feedbackId, requestKey },
        excluded.userId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    allowlisted.delete(excluded.feedbackId);
    await reviewService.scheduleBadFeedback({
      id: excluded.feedbackId,
      conversationId: excluded.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: excluded.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    expect(await prisma.conversationReview.count()).toBe(1);
    expect(await queue.count()).toBe(1);

    const excludedReview = await prisma.conversationReview.create({
      data: {
        reviewKey: `synthetic-excluded-${excluded.feedbackId}`,
        conversationId: excluded.conversationId,
        sourceMessageId: excluded.sourceMessageId,
        feedbackId: excluded.feedbackId,
        reviewerVersion: 'synthetic',
        trigger: 'BAD_FEEDBACK',
      },
    });
    const allowedJob = await queue.getJob(`review-${first.reviewId}`);
    expect(allowedJob?.opts.attempts).toBe(1);
    await allowedJob?.remove();
    await reviewService.onModuleInit();
    expect(await queue.getJob(`review-${first.reviewId}`)).toBeDefined();
    expect(await queue.getJob(`review-${excludedReview.id}`)).toBeUndefined();
    await reviewService.process(excludedReview.id);
    expect(
      (
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: excludedReview.id },
        })
      ).status,
    ).toBe(ConversationReviewStatus.PENDING);
    expect(provider.requests).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', '{"issueCode":'],
    [
      'invalid schema',
      JSON.stringify({
        issueCode: 'TEST',
        summary: 42,
        counterexample: null,
        confidence: 0.5,
        candidate: null,
      }),
    ],
  ])(
    'gives a manual canary one provider call for %s and reuses FAILED',
    async (_label, response) => {
      provider.setResponse(response);
      const selected = await seed('manual-invalid');
      const reviewService = service();
      const requestKey = randomUUID();
      const first = await reviewService.triggerCanary(
        { feedbackId: selected.feedbackId, requestKey },
        selected.userId,
      );
      const job = await queue.getJob(`review-${first.reviewId}`);
      expect(job?.opts.attempts).toBe(1);
      await expect(reviewService.process(first.reviewId)).rejects.toThrow();
      await reviewService.process(first.reviewId);
      const repeated = await reviewService.triggerCanary(
        { feedbackId: selected.feedbackId, requestKey },
        selected.userId,
      );
      expect(repeated.reviewId).toBe(first.reviewId);
      expect(repeated.status).toBe(ConversationReviewStatus.FAILED);
      expect(provider.requests).toHaveLength(1);
      expect(await prisma.conversationReview.count()).toBe(1);
      expect(await queue.count()).toBe(1);
      expect(await prisma.learningItem.count()).toBe(0);
      expect(
        (
          await prisma.conversationReview.findUniqueOrThrow({
            where: { id: first.reviewId },
          })
        ).attempts,
      ).toBe(1);
    },
  );

  it.each([
    ['NO_LEARNING', false],
    ['PROPOSED', true],
  ])(
    'keeps a valid manual canary at one call and %s',
    async (_label, candidate) => {
      provider.setResponse((request) => ({
        issueCode: 'REPETITION',
        summary: 'Resumen sintético seguro',
        counterexample: null,
        confidence: 0.7,
        candidate: candidate
          ? {
              kind: 'STYLE',
              trigger: 'Dato corregido',
              guidance: 'Confirmar la información más reciente',
              serviceCode: null,
              market: null,
              evidenceMessageIds: [firstEvidenceMessageId(request)],
            }
          : null,
      }));
      const selected = await seed('manual-valid');
      const reviewService = service();
      const scheduled = await reviewService.triggerCanary(
        { feedbackId: selected.feedbackId, requestKey: randomUUID() },
        selected.userId,
      );
      await reviewService.process(scheduled.reviewId);
      const review = await prisma.conversationReview.findUniqueOrThrow({
        where: { id: scheduled.reviewId },
      });
      expect(review.status).toBe(
        candidate
          ? ConversationReviewStatus.PROPOSED
          : ConversationReviewStatus.NO_LEARNING,
      );
      expect(review.attempts).toBe(1);
      expect(provider.requests).toHaveLength(1);
      expect(await prisma.learningItem.count()).toBe(candidate ? 1 : 0);
      if (candidate)
        expect((await prisma.learningItem.findFirstOrThrow()).status).toBe(
          'PROPOSED',
        );
    },
  );

  it('converges concurrent manual triggers and worker claims on one provider call', async () => {
    provider.setResponse({
      issueCode: 'TEST',
      summary: 'Sin pauta generalizable',
      counterexample: null,
      confidence: 0.5,
      candidate: null,
    });
    const selected = await seed('manual-concurrent');
    const reviewService = service();
    const request = {
      feedbackId: selected.feedbackId,
      requestKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      reviewService.triggerCanary(request, selected.userId),
      reviewService.triggerCanary(request, selected.userId),
    ]);
    expect(first.reviewId).toBe(second.reviewId);
    await Promise.all([
      reviewService.process(first.reviewId),
      reviewService.process(first.reviewId),
    ]);
    expect(await prisma.conversationReview.count()).toBe(1);
    expect(await queue.count()).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(
      (
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: first.reviewId },
        })
      ).attempts,
    ).toBe(1);
  });

  it.each([
    ['NO_LEARNING', false],
    ['PROPOSED', true],
  ])(
    'preserves a historical FAILED canary and creates one explicit re-canary ending %s',
    async (_label, candidate) => {
      const selected = await seed('historical-recanary');
      const oldKey = randomUUID();
      const historical = await historicFailedCanary(selected, oldKey);
      const historicalBefore =
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: historical.id },
        });
      const reviewService = service();
      const sameOld = await reviewService.triggerCanary(
        { feedbackId: selected.feedbackId, requestKey: oldKey },
        selected.userId,
      );
      expect(sameOld.reviewId).toBe(historical.id);
      expect(sameOld.status).toBe(ConversationReviewStatus.FAILED);
      expect(provider.requests).toHaveLength(0);
      const newKey = randomUUID();
      await expect(
        reviewService.triggerCanary(
          { feedbackId: selected.feedbackId, requestKey: newKey },
          selected.userId,
        ),
      ).rejects.toMatchObject({ status: 409 });
      const authorization = {
        feedbackId: selected.feedbackId,
        requestKey: newKey,
        recanaryOfReviewId: historical.id,
      };
      const [first, concurrent] = await Promise.all([
        reviewService.triggerCanary(authorization, selected.userId),
        reviewService.triggerCanary(authorization, selected.userId),
      ]);
      expect(first.reviewId).toBe(concurrent.reviewId);
      expect(first.reviewId).not.toBe(historical.id);
      expect(
        await prisma.conversationReview.count({
          where: { feedbackId: selected.feedbackId },
        }),
      ).toBe(2);
      const newReview = await prisma.conversationReview.findUniqueOrThrow({
        where: { id: first.reviewId },
      });
      expect(newReview.reviewerVersion).toBe(historical.reviewerVersion);
      expect(newReview.reviewKey).not.toBe(historical.reviewKey);
      expect(
        (await queue.getJob(`review-${first.reviewId}`))?.opts.attempts,
      ).toBe(1);
      await (await queue.getJob(`review-${first.reviewId}`))?.remove();
      await reviewService.onModuleInit();
      expect(
        (await queue.getJob(`review-${first.reviewId}`))?.opts.attempts,
      ).toBe(1);
      expect(
        await (await queue.getJob(`review-${historical.id}`))?.getState(),
      ).toBe('failed');
      provider.setResponse((request) => ({
        issueCode: 'REPETITION',
        summary: 'Resumen sintético seguro',
        counterexample: null,
        confidence: 0.7,
        candidate: candidate
          ? {
              kind: 'STYLE',
              trigger: 'Dato corregido',
              guidance: 'Confirmar la información más reciente',
              serviceCode: null,
              market: null,
              evidenceMessageIds: [firstEvidenceMessageId(request)],
            }
          : null,
      }));
      await Promise.all([
        reviewService.process(first.reviewId),
        reviewService.process(first.reviewId),
      ]);
      const finished = await prisma.conversationReview.findUniqueOrThrow({
        where: { id: first.reviewId },
      });
      expect(finished.status).toBe(
        candidate
          ? ConversationReviewStatus.PROPOSED
          : ConversationReviewStatus.NO_LEARNING,
      );
      expect(finished.attempts).toBe(1);
      expect(provider.requests).toHaveLength(1);
      expect(await prisma.learningItem.count()).toBe(candidate ? 1 : 0);
      if (candidate)
        expect((await prisma.learningItem.findFirstOrThrow()).status).toBe(
          'PROPOSED',
        );
      const repeated = await reviewService.triggerCanary(
        authorization,
        selected.userId,
      );
      expect(repeated.reviewId).toBe(first.reviewId);
      expect(provider.requests).toHaveLength(1);
      await expect(
        reviewService.triggerCanary(
          {
            feedbackId: selected.feedbackId,
            requestKey: randomUUID(),
            recanaryOfReviewId: historical.id,
          },
          selected.userId,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.conversationReview.count()).toBe(2);
      expect(
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: historical.id },
        }),
      ).toEqual(historicalBefore);
      await (await queue.getJob(`review-${first.reviewId}`))?.remove();
      await reviewService.onModuleInit();
      expect(await queue.getJob(`review-${first.reviewId}`)).toBeUndefined();
      expect(
        await (await queue.getJob(`review-${historical.id}`))?.getState(),
      ).toBe('failed');
    },
  );

  it('does not recover a FAILED explicit re-canary or call its provider again', async () => {
    const selected = await seed('failed-recanary');
    const historical = await historicFailedCanary(selected, randomUUID());
    const reviewService = service();
    const authorization = {
      feedbackId: selected.feedbackId,
      requestKey: randomUUID(),
      recanaryOfReviewId: historical.id,
    };
    const created = await reviewService.triggerCanary(
      authorization,
      selected.userId,
    );
    provider.setResponse('{');
    await expect(reviewService.process(created.reviewId)).rejects.toThrow(
      'REVIEW_PROVIDER_JSON',
    );
    const failed = await prisma.conversationReview.findUniqueOrThrow({
      where: { id: created.reviewId },
    });
    expect(failed.status).toBe(ConversationReviewStatus.FAILED);
    expect(failed.attempts).toBe(1);
    await (await queue.getJob(`review-${created.reviewId}`))?.remove();
    await reviewService.onModuleInit();
    expect(await queue.getJob(`review-${created.reviewId}`)).toBeUndefined();
    const repeated = await reviewService.triggerCanary(
      authorization,
      selected.userId,
    );
    expect(repeated.reviewId).toBe(created.reviewId);
    expect(provider.requests).toHaveLength(1);
    expect(await prisma.conversationReview.count()).toBe(2);
    expect(
      await (await queue.getJob(`review-${historical.id}`))?.getState(),
    ).toBe('failed');
  });

  it('rejects a non-allowlisted or GOOD historical feedback before re-canary scheduling', async () => {
    const selected = await seed('recanary-scope');
    const historical = await historicFailedCanary(selected, randomUUID());
    const authorization = {
      feedbackId: selected.feedbackId,
      requestKey: randomUUID(),
      recanaryOfReviewId: historical.id,
    };
    allowlisted.delete(selected.feedbackId);
    await expect(
      service().triggerCanary(authorization, selected.userId),
    ).rejects.toThrow();
    allowlisted.add(selected.feedbackId);
    await prisma.conversationFeedback.update({
      where: { id: selected.feedbackId },
      data: { rating: FeedbackRating.GOOD },
    });
    await expect(
      service().triggerCanary(authorization, selected.userId),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.conversationReview.count()).toBe(1);
    expect(await queue.getJob(`review-${historical.id}`)).toBeDefined();
    expect(provider.requests).toHaveLength(0);
  });

  it('creates one deduplicated PROPOSED candidate with evidence from separate conversations', async () => {
    provider.setResponse((request) => {
      return {
        issueCode: 'REPETITION',
        summary: 'La respuesta repite información ya disponible',
        counterexample: 'No aplica si el cliente cambia de necesidad',
        confidence: 0.8,
        candidate: {
          kind: 'FOLLOW_UP',
          trigger: 'cliente confirma que desea continuar',
          guidance: 'Reconocer el avance y hacer una sola pregunta concreta',
          evidenceMessageIds: [firstEvidenceMessageId(request)],
        },
      };
    });
    const reviewService = service();
    const first = await scheduleAndProcess(
      reviewService,
      await seed('candidate-a'),
    );
    const second = await scheduleAndProcess(
      reviewService,
      await seed('candidate-b'),
    );
    expect(first.status).toBe(ConversationReviewStatus.PROPOSED);
    expect(second.status).toBe(ConversationReviewStatus.PROPOSED);
    expect(await prisma.learningItem.count()).toBe(1);
    expect(await prisma.learningEvidence.count()).toBe(2);
  });

  it.each(invalidProviderResponses)(
    'fails closed for %s',
    async (_label, response) => {
      provider.setResponse(response);
      const result = await scheduleAndProcess(
        service(),
        await seed('invalid-output'),
        true,
      );
      expect(result.status).toBe(ConversationReviewStatus.FAILED);
      expect(result.attempts).toBe(1);
      expect(await prisma.learningItem.count()).toBe(0);
    },
  );

  it('retries a failed review and re-enqueues a pending review after a simulated restart', async () => {
    provider.setResponse('not valid json');
    const firstSeed = await seed('retry');
    const firstService = service();
    const failed = await scheduleAndProcess(firstService, firstSeed, true);
    expect(failed.status).toBe(ConversationReviewStatus.FAILED);
    expect((await queue.getJob(`review-${failed.id}`))?.opts.attempts).toBe(3);

    provider.setResponse({
      issueCode: 'REPETITION',
      summary: 'Se recuperó con un resultado sin candidato',
      counterexample: null,
      confidence: 0.4,
      candidate: null,
    });
    const restartedService = service();
    await restartedService.process(failed.id);
    expect(
      (
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: failed.id },
        })
      ).status,
    ).toBe(ConversationReviewStatus.NO_LEARNING);
    expect(
      (
        await prisma.conversationReview.findUniqueOrThrow({
          where: { id: failed.id },
        })
      ).attempts,
    ).toBe(2);

    const pendingSeed = await seed('restart');
    await restartedService.scheduleBadFeedback({
      id: pendingSeed.feedbackId,
      conversationId: pendingSeed.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: pendingSeed.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    const pending = await prisma.conversationReview.findFirstOrThrow({
      where: { feedbackId: pendingSeed.feedbackId },
    });
    const scheduled = await queue.getJob(`review-${pending.id}`);
    await scheduled?.remove();
    await service().onModuleInit();
    expect(await queue.getJob(`review-${pending.id}`)).toBeDefined();
  });

  it('enforces the daily quota and pauses scheduling after three failed reviews', async () => {
    const limited = service(1);
    const first = await seed('quota-a');
    const second = await seed('quota-b');
    await limited.scheduleBadFeedback({
      id: first.feedbackId,
      conversationId: first.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: first.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    await limited.scheduleBadFeedback({
      id: second.feedbackId,
      conversationId: second.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: second.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    expect(await prisma.conversationReview.count()).toBe(1);

    await clearFixture();
    const pausedSeed = await seed('paused');
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        prisma.conversationReview.create({
          data: {
            reviewKey: `failed-${index}-${randomUUID()}`,
            conversationId: pausedSeed.conversationId,
            sourceMessageId: pausedSeed.sourceMessageId,
            reviewerVersion: 'synthetic',
            trigger: 'BAD_FEEDBACK',
            status: ConversationReviewStatus.FAILED,
          },
        }),
      ),
    );
    await service().scheduleBadFeedback({
      id: pausedSeed.feedbackId,
      conversationId: pausedSeed.conversationId,
      messageId: (
        await prisma.conversationFeedback.findUniqueOrThrow({
          where: { id: pausedSeed.feedbackId },
        })
      ).messageId,
      rating: FeedbackRating.BAD,
    });
    expect(await prisma.conversationReview.count()).toBe(3);
    expect(await queue.count()).toBe(0);
  });
});

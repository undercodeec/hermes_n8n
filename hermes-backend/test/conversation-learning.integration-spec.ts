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
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { ConversationReviewService } from '../src/learning/conversation-review.service';
import {
  LEARNING_REVIEW_QUEUE,
  ReviewJobData,
} from '../src/learning/learning.constants';
import { ReviewModelService } from '../src/learning/review-model.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LearningReviewProviderFixture } from './fixtures/learning-review-provider';

type Seed = {
  conversationId: string;
  feedbackId: string;
  sourceMessageId: string;
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
    database.port !== '55432' ||
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
    );
  };

  async function clearFixture(): Promise<void> {
    await queue.obliterate({ force: true });
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
    return {
      conversationId: conversation.id,
      feedbackId: feedback.id,
      sourceMessageId: source.id,
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

  beforeAll(async () => {
    assertIsolatedTargets();
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    redis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    queue = new Queue(LEARNING_REVIEW_QUEUE, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
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
    expect(JSON.stringify(provider.requests[0])).toContain('[correo]');
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

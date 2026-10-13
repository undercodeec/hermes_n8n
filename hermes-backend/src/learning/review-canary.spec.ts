/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  ConversationReviewTrigger,
  FeedbackRating,
  FeedbackReasonCode,
  UserRole,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { FeedbackService } from '../feedback/feedback.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationReviewService } from './conversation-review.service';
import { LearningController } from './learning.controller';
import { ReviewJobData } from './learning.constants';
import {
  ReviewCanaryPolicy,
  parseReviewCanaryFeedbackIds,
} from './review-canary.policy';
import { ReviewModelService } from './review-model.service';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const KEY = '20000000-0000-4000-8000-000000000001';
const NEXT_KEY = '20000000-0000-4000-8000-000000000002';
const THIRD_KEY = '20000000-0000-4000-8000-000000000003';
const REVIEW_KEY = (id: string) => `feedback-review-v1:BAD_FEEDBACK:${id}`;

function fixture(allowlist: string, enabled = true) {
  const feedbacks = new Map<
    string,
    {
      id: string;
      conversationId: string;
      messageId: string;
      rating: FeedbackRating;
    }
  >();
  for (const id of [A, B])
    feedbacks.set(id, {
      id,
      conversationId: 'conversation-1',
      messageId: `message-${id}`,
      rating: FeedbackRating.BAD,
    });
  const reviews = new Map<
    string,
    {
      id: string;
      reviewKey: string;
      feedbackId: string | null;
      conversationId?: string;
      sourceMessageId?: string;
      trigger: ConversationReviewTrigger;
      status: ConversationReviewStatus;
      attempts: number;
    }
  >();
  const jobs = new Map<string, unknown>();
  const requests = new Map<
    string,
    { feedbackId: string; reviewId?: string; recanaryOfReviewId?: string }
  >();
  const executions = new Set<string>();
  const config = {
    get: jest.fn((name: string, fallback?: string) =>
      name === 'LEARNING_REVIEW_ENABLED'
        ? String(enabled)
        : name === 'LEARNING_REVIEW_CANARY_FEEDBACK_IDS'
          ? allowlist
          : fallback,
    ),
  };
  const policy = new ReviewCanaryPolicy(config as unknown as ConfigService);
  const queue = {
    add: jest.fn(
      async (_name: string, data: unknown, options: { jobId: string }) => {
        jobs.set(options.jobId, data);
      },
    ),
  };
  const model = { review: jest.fn(), modelName: jest.fn() };
  const tx = {
    $queryRaw: jest.fn(async () => [{ one: 1 }]),
    auditLog: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            entity: string;
            entityId?: string;
            changes?: { path: string[]; equals: string };
          };
        }) => {
          if (where.entity === 'learning_review_canary_execution')
            return executions.has(where.entityId ?? '')
              ? { id: 'marker' }
              : null;
          if (where.changes)
            return [...requests.values()].some(
              (request) => request.feedbackId === where.changes?.equals,
            )
              ? { id: 'legacy-request' }
              : null;
          const request = requests.get(where.entityId ?? '');
          return request ? { changes: request } : null;
        },
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            entity: string;
            entityId: string;
            changes: {
              feedbackId: string;
              reviewId?: string;
              recanaryOfReviewId?: string;
            };
          };
        }) => {
          if (data.entity === 'learning_review_canary_execution')
            executions.add(data.entityId);
          else requests.set(data.entityId, data.changes);
        },
      ),
    },
    conversationReview: {
      findUnique: jest.fn(
        async ({ where }: { where: { reviewKey?: string; id?: string } }) =>
          where.reviewKey
            ? (reviews.get(where.reviewKey) ?? null)
            : ([...reviews.values()].find((review) => review.id === where.id) ??
              null),
      ),
      count: jest.fn(
        async ({
          where,
        }: {
          where: { feedbackId?: string; status?: ConversationReviewStatus };
        }) =>
          [...reviews.values()].filter((review) =>
            where.feedbackId
              ? review.feedbackId === where.feedbackId
              : where.status
                ? review.status === where.status
                : true,
          ).length,
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            reviewKey: string;
            feedbackId: string;
            trigger: ConversationReviewTrigger;
            conversationId: string;
            sourceMessageId: string;
          };
        }) => {
          const review = {
            id: `review-${reviews.size + 1}`,
            reviewKey: data.reviewKey,
            feedbackId: data.feedbackId,
            conversationId: data.conversationId,
            sourceMessageId: data.sourceMessageId,
            trigger: data.trigger,
            status: ConversationReviewStatus.PENDING,
            attempts: 0,
          };
          reviews.set(data.reviewKey, review);
          return review;
        },
      ),
    },
  };
  let transaction = Promise.resolve();
  const prisma = {
    auditLog: {
      findFirst: jest.fn(
        async ({ where }: { where: { entity: string; entityId: string } }) =>
          where.entity === 'learning_review_canary_execution' &&
          executions.has(where.entityId)
            ? { id: 'marker' }
            : null,
      ),
    },
    conversationFeedback: {
      findUnique: jest.fn(
        async ({ where }: { where: { id?: string; requestKey?: string } }) =>
          where.id ? (feedbacks.get(where.id) ?? null) : null,
      ),
      create: jest.fn(
        async ({ data }: { data: { rating: FeedbackRating } }) => {
          const value = { ...feedbacks.get(B)!, rating: data.rating };
          feedbacks.set(B, value);
          return value;
        },
      ),
    },
    message: { findFirst: jest.fn(async () => ({ id: 'message' })) },
    automatedDelivery: {
      findFirst: jest.fn(async () => ({ sourceMessageId: 'source-1' })),
    },
    conversationReview: {
      count: jest.fn(
        async ({ where }: { where: { status?: ConversationReviewStatus } }) =>
          where.status ? 0 : reviews.size,
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { reviewKey: string } }) =>
          reviews.get(where.reviewKey) ?? null,
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { feedbackId: string; reviewKey: { not: string } };
        }) =>
          [...reviews.values()].find(
            (review) =>
              review.feedbackId === where.feedbackId &&
              review.reviewKey !== where.reviewKey.not,
          ) ?? null,
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            status: ConversationReviewStatus;
            feedbackId: { in: string[] };
            trigger: ConversationReviewTrigger;
          };
        }) =>
          [...reviews.values()]
            .filter(
              (review) =>
                review.status === where.status &&
                review.trigger === where.trigger &&
                !!review.feedbackId &&
                where.feedbackId.in.includes(review.feedbackId),
            )
            .map(({ id }) => ({ id })),
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { reviewKey: string };
          create: { feedbackId: string; trigger: ConversationReviewTrigger };
        }) => {
          let review = reviews.get(where.reviewKey);
          if (!review) {
            review = {
              id: `review-${reviews.size + 1}`,
              reviewKey: where.reviewKey,
              feedbackId: create.feedbackId,
              trigger: create.trigger,
              status: ConversationReviewStatus.PENDING,
              attempts: 0,
            };
            reviews.set(where.reviewKey, review);
          }
          return review;
        },
      ),
      findUniqueOrThrow: jest.fn(
        async ({ where }: { where: { id: string } }) => {
          const review = [...reviews.values()].find(
            (item) => item.id === where.id,
          );
          if (!review) throw new Error('missing review');
          return {
            ...review,
            feedback: review.feedbackId
              ? feedbacks.get(review.feedbackId)
              : null,
          };
        },
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const running = transaction.then(() => callback(tx));
        transaction = running.then(
          () => undefined,
          () => undefined,
        );
        return running;
      },
    ),
  };
  const service = new ConversationReviewService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    model as unknown as ReviewModelService,
    queue as unknown as Queue<ReviewJobData>,
    policy,
  );
  return {
    service,
    policy,
    config,
    prisma,
    queue,
    model,
    reviews,
    feedbacks,
    jobs,
    requests,
    executions,
    tx,
  };
}

describe('reviewer canary fail closed', () => {
  it('parses only explicit UUIDs, trims whitespace and rejects malformed config', () => {
    expect([...parseReviewCanaryFeedbackIds('  ')]).toEqual([]);
    expect([...parseReviewCanaryFeedbackIds(` ${A} , ${B} `)]).toEqual([A, B]);
    expect(() => parseReviewCanaryFeedbackIds(`${A},broken`)).toThrow();
    expect(() => parseReviewCanaryFeedbackIds(`${A},`)).toThrow();
  });

  it('keeps flag OFF and empty allowlist at zero reviews and jobs', async () => {
    const off = fixture(A, false);
    await expect(
      off.service.triggerCanary({ feedbackId: A, requestKey: KEY }, 'admin-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(off.reviews.size).toBe(0);
    expect(off.jobs.size).toBe(0);
    const empty = fixture('');
    await expect(
      empty.service.triggerCanary(
        { feedbackId: A, requestKey: KEY },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const feedbackService = new FeedbackService(
      empty.prisma as unknown as PrismaService,
      empty.service,
    );
    await feedbackService.create(
      {
        conversationId: 'conversation-1',
        messageId: `message-${B}`,
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
        requestKey: KEY,
      },
      'operator-1',
    );
    expect(empty.prisma.conversationFeedback.create).toHaveBeenCalledTimes(1);
    expect(empty.reviews.size).toBe(0);
    expect(empty.jobs.size).toBe(0);
  });

  it('persists a new non-allowlisted BAD without scheduling; GOOD is never reviewed', async () => {
    const f = fixture(A);
    const feedbackService = new FeedbackService(
      f.prisma as unknown as PrismaService,
      f.service,
    );
    await feedbackService.create(
      {
        conversationId: 'conversation-1',
        messageId: `message-${B}`,
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
        requestKey: KEY,
      },
      'operator-1',
    );
    expect(f.prisma.conversationFeedback.create).toHaveBeenCalledTimes(1);
    expect(f.reviews.size).toBe(0);
    expect(f.jobs.size).toBe(0);
    await f.service.scheduleBadFeedback({
      ...f.feedbacks.get(A)!,
      rating: FeedbackRating.GOOD,
    });
    expect(f.reviews.size).toBe(0);
    await expect(
      f.service.triggerCanary({ feedbackId: B, requestKey: KEY }, 'admin-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a new BAD already allowlisted, without retrieval, shadow or summary', async () => {
    const f = fixture(A);
    await f.service.scheduleBadFeedback(f.feedbacks.get(A)!);
    expect(f.reviews.size).toBe(1);
    expect(f.jobs.size).toBe(1);
    for (const flag of [
      'LEARNING_RETRIEVAL_ENABLED',
      'LEARNING_SHADOW_ENABLED',
      'LEARNING_SUMMARY_ENABLED',
    ])
      expect(f.config.get(flag, 'false')).toBe('false');
  });

  it('rejects GOOD, ineligible Hermes messages, and unconfirmed delivery before scheduling', async () => {
    const good = fixture(A);
    good.feedbacks.set(A, {
      ...good.feedbacks.get(A)!,
      rating: FeedbackRating.GOOD,
    });
    await expect(
      good.service.triggerCanary({ feedbackId: A, requestKey: KEY }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ineligible = fixture(A);
    ineligible.prisma.message.findFirst.mockResolvedValue(null);
    await expect(
      ineligible.service.triggerCanary(
        { feedbackId: A, requestKey: KEY },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    const unconfirmed = fixture(A);
    unconfirmed.prisma.automatedDelivery.findFirst.mockResolvedValue(null);
    await expect(
      unconfirmed.service.triggerCanary(
        { feedbackId: A, requestKey: KEY },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const f of [good, ineligible, unconfirmed]) {
      expect(f.reviews.size).toBe(0);
      expect(f.jobs.size).toBe(0);
      expect(f.requests.size).toBe(0);
    }
  });

  it('does not create a second review when an older incompatible review exists', async () => {
    const f = fixture(A);
    f.reviews.set(`older:${A}`, {
      id: 'older-review',
      reviewKey: `older:${A}`,
      feedbackId: A,
      trigger: ConversationReviewTrigger.BAD_FEEDBACK,
      status: ConversationReviewStatus.PENDING,
      attempts: 0,
    });
    await expect(
      f.service.triggerCanary({ feedbackId: A, requestKey: KEY }, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    await f.service.scheduleBadFeedback(f.feedbacks.get(A)!);
    expect(f.reviews.size).toBe(1);
    expect(f.jobs.size).toBe(0);
  });

  it('schedules one authorized historical BAD, reuses the request and rejects key conflicts', async () => {
    const f = fixture(`${A},${B}`);
    const first = await f.service.triggerCanary(
      { feedbackId: A, requestKey: KEY },
      'admin-1',
    );
    const again = await f.service.triggerCanary(
      { feedbackId: A, requestKey: KEY },
      'admin-1',
    );
    expect(first.reviewId).toBe(again.reviewId);
    expect(first.feedbackId).toBe(A);
    expect(first.status).toBe(ConversationReviewStatus.PENDING);
    expect(f.reviews.size).toBe(1);
    expect(f.jobs.size).toBe(1);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(2);
    await expect(
      f.service.triggerCanary({ feedbackId: B, requestKey: KEY }, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.reviews.size).toBe(1);
    expect(f.jobs.size).toBe(1);
  });

  it('converges concurrent trigger calls on one review and one logical job', async () => {
    const f = fixture(A);
    const [one, two] = await Promise.all([
      f.service.triggerCanary({ feedbackId: A, requestKey: KEY }, 'admin-1'),
      f.service.triggerCanary({ feedbackId: A, requestKey: KEY }, 'admin-1'),
    ]);
    expect(one.reviewId).toBe(two.reviewId);
    expect(f.reviews.size).toBe(1);
    expect(f.jobs.size).toBe(1);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('reuses a terminal legacy canary with the same durable request key without enqueuing', async () => {
    const f = fixture(A);
    f.requests.set(KEY, { feedbackId: A });
    f.reviews.set(REVIEW_KEY(A), {
      id: 'legacy-failed',
      reviewKey: REVIEW_KEY(A),
      feedbackId: A,
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      trigger: ConversationReviewTrigger.BAD_FEEDBACK,
      status: ConversationReviewStatus.FAILED,
      attempts: 3,
    });
    const result = await f.service.triggerCanary(
      { feedbackId: A, requestKey: KEY },
      'admin-1',
    );
    expect(result).toMatchObject({
      reviewId: 'legacy-failed',
      status: ConversationReviewStatus.FAILED,
      reused: true,
      scheduled: false,
    });
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('requires the FAILED review ID for a new authorization and never creates a third review', async () => {
    const f = fixture(A);
    f.requests.set(KEY, { feedbackId: A });
    f.reviews.set(REVIEW_KEY(A), {
      id: 'legacy-failed',
      reviewKey: REVIEW_KEY(A),
      feedbackId: A,
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      trigger: ConversationReviewTrigger.BAD_FEEDBACK,
      status: ConversationReviewStatus.FAILED,
      attempts: 3,
    });
    await expect(
      f.service.triggerCanary(
        { feedbackId: A, requestKey: NEXT_KEY },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.reviews.size).toBe(1);
    const dto = {
      feedbackId: A,
      requestKey: NEXT_KEY,
      recanaryOfReviewId: 'legacy-failed',
    };
    const first = await f.service.triggerCanary(dto, 'admin-1');
    const repeated = await f.service.triggerCanary(dto, 'admin-1');
    expect(first.reviewId).toBe(repeated.reviewId);
    expect(first.reviewId).not.toBe('legacy-failed');
    expect(f.reviews.get(REVIEW_KEY(A))?.status).toBe(
      ConversationReviewStatus.FAILED,
    );
    expect(f.reviews.size).toBe(2);
    expect(f.jobs.size).toBe(1);
    expect(f.executions.has(first.reviewId)).toBe(true);
    await expect(
      f.service.triggerCanary(
        {
          feedbackId: A,
          requestKey: THIRD_KEY,
          recanaryOfReviewId: 'legacy-failed',
        },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.reviews.size).toBe(2);
    expect(f.jobs.size).toBe(1);
  });

  it('converges concurrent requests for the same explicit re-canary', async () => {
    const f = fixture(A);
    f.requests.set(KEY, { feedbackId: A });
    f.reviews.set(REVIEW_KEY(A), {
      id: 'legacy-failed',
      reviewKey: REVIEW_KEY(A),
      feedbackId: A,
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      trigger: ConversationReviewTrigger.BAD_FEEDBACK,
      status: ConversationReviewStatus.FAILED,
      attempts: 3,
    });
    const dto = {
      feedbackId: A,
      requestKey: NEXT_KEY,
      recanaryOfReviewId: 'legacy-failed',
    };
    const [first, second] = await Promise.all([
      f.service.triggerCanary(dto, 'admin-1'),
      f.service.triggerCanary(dto, 'admin-1'),
    ]);
    expect(first.reviewId).toBe(second.reviewId);
    expect(f.reviews.size).toBe(2);
    expect(f.jobs.size).toBe(1);
  });

  it('recovers only allowed pending feedback and retains other pending records', async () => {
    const f = fixture(A);
    for (const id of [A, B])
      f.reviews.set(REVIEW_KEY(id), {
        id: `review-${id}`,
        reviewKey: REVIEW_KEY(id),
        feedbackId: id,
        trigger: ConversationReviewTrigger.BAD_FEEDBACK,
        status: ConversationReviewStatus.PENDING,
        attempts: 0,
      });
    await f.service.onModuleInit();
    expect(f.queue.add).toHaveBeenCalledTimes(1);
    expect(f.jobs.has(`review-review-${A}`)).toBe(true);
    expect(f.reviews.get(REVIEW_KEY(B))?.status).toBe(
      ConversationReviewStatus.PENDING,
    );
  });

  it('drops an out-of-scope worker job without model call, claim, or retry', async () => {
    const f = fixture(A);
    f.reviews.set(REVIEW_KEY(B), {
      id: 'review-b',
      reviewKey: REVIEW_KEY(B),
      feedbackId: B,
      trigger: ConversationReviewTrigger.BAD_FEEDBACK,
      status: ConversationReviewStatus.PENDING,
      attempts: 0,
    });
    await f.service.process('review-b');
    expect(f.prisma.conversationReview.updateMany).not.toHaveBeenCalled();
    expect(f.model.review).not.toHaveBeenCalled();
    expect(f.reviews.get(REVIEW_KEY(B))?.status).toBe(
      ConversationReviewStatus.PENDING,
    );
  });

  it('does not schedule an AutoReply incident during a feedback-only canary', async () => {
    const f = fixture(A);
    await f.service.scheduleIncident({
      conversationId: 'conversation-1',
      sourceMessageId: 'source-1',
      code: 'REPETITION',
    });
    expect(f.reviews.size).toBe(0);
    expect(f.jobs.size).toBe(0);
  });

  it('protects the manual route with JWT and ADMIN role', () => {
    expect(Reflect.getMetadata(ROLES_KEY, LearningController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, LearningController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(
      Reflect.getMetadata('path', LearningController.prototype.triggerCanary),
    ).toBe('reviews/canary');
  });
});

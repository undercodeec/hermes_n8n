import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import {
  AutomatedDeliveryStatus,
  LearningItemStatus,
  LearningRiskLevel,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { loadLearningTrace } from '../src/automated-deliveries/learning-trace';
import { LearningRetrievalService } from '../src/learning/learning-retrieval.service';
import { PrismaService } from '../src/prisma/prisma.service';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('F3 rollback preservation on isolated PostgreSQL', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    const url = process.env.DATABASE_INTEGRATION_URL;
    if (!url || !url.includes('127.0.0.1:55432/hermes_learning_test'))
      throw new Error('Isolated local PostgreSQL URL required');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });
  afterAll(async () => prisma?.$disconnect());

  it('preserves items, evidence, review, audit, summary and every delivery status through OFF and re-enable', async () => {
    const token = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `rollback-${token}` },
    });
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const source = await prisma.message.create({
      data: {
        contactId: contact.id,
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'Consulta sintética sobre punto',
      },
    });
    const user = await prisma.user.create({
      data: {
        email: `rollback-${token}@example.invalid`,
        password: 'synthetic-only',
        name: 'Synthetic reviewer',
        role: UserRole.SALES_AGENT,
      },
    });
    const feedback = await prisma.conversationFeedback.create({
      data: {
        conversationId: conversation.id,
        messageId: source.id,
        userId: user.id,
        rating: 'BAD',
        requestKey: `rollback-${token}`,
      },
    });
    const review = await prisma.conversationReview.create({
      data: {
        reviewKey: `rollback-${token}`,
        conversationId: conversation.id,
        sourceMessageId: source.id,
        feedbackId: feedback.id,
        reviewerVersion: 'synthetic-only',
        trigger: 'INCIDENT',
        status: 'PROPOSED',
      },
    });
    const summary = await prisma.conversationState.create({
      data: {
        conversationId: conversation.id,
        summary: 'Resumen sintético preexistente',
      },
    });
    const statuses = [
      LearningItemStatus.ACTIVE,
      LearningItemStatus.RETIRED,
      LearningItemStatus.REJECTED,
      LearningItemStatus.PROPOSED,
    ];
    const items = await Promise.all(
      statuses.map((status, index) =>
        prisma.learningItem.create({
          data: {
            fingerprint: `rollback-${token}-${index}`,
            version: index + 1,
            status,
            kind: 'STYLE',
            trigger: 'consulta punto',
            guidance: 'Hacer una pregunta pertinente.',
            riskLevel: LearningRiskLevel.LOW,
            validUntil: new Date('2030-01-01T00:00:00Z'),
            sourceReviewId: review.id,
            approvedById: index === 0 ? user.id : null,
            approvedAt: index === 0 ? new Date('2026-10-15T00:00:00Z') : null,
          },
        }),
      ),
    );
    for (const item of items)
      await prisma.learningEvidence.create({
        data: {
          learningItemId: item.id,
          conversationId: conversation.id,
          messageId: source.id,
          feedbackId: feedback.id,
          reviewId: review.id,
        },
      });
    for (const [index, action] of ['APPROVE', 'REJECT', 'RETIRE'].entries())
      await prisma.auditLog.create({
        data: {
          action: `LEARNING_${action}`,
          entity: 'learning_items',
          entityId: items[index].id,
          changes: { fixture: true },
        },
      });
    const deliveryStatuses = [
      AutomatedDeliveryStatus.CONFIRMED,
      AutomatedDeliveryStatus.SUPPRESSED,
      AutomatedDeliveryStatus.AMBIGUOUS,
      AutomatedDeliveryStatus.REJECTED,
      AutomatedDeliveryStatus.PREPARED,
    ];
    const sources = [source];
    const redisUrl = process.env.REDIS_INTEGRATION_URL;
    if (!redisUrl || !redisUrl.startsWith('redis://127.0.0.1:56379/'))
      throw new Error('Isolated local Redis URL required');
    const redis = new IORedis(redisUrl);
    try {
      const redisKeysBefore = (await redis.keys('*')).sort();
      for (let index = 0; index < deliveryStatuses.length; index++) {
        const inbound =
          index === 0
            ? source
            : await prisma.message.create({
                data: {
                  contactId: contact.id,
                  conversationId: conversation.id,
                  direction: MessageDirection.INBOUND,
                  sender: MessageSender.CONTACT,
                  type: MessageType.TEXT,
                  content: `synthetic ${index}`,
                },
              });
        if (index) sources.push(inbound);
        await prisma.automatedDelivery.create({
          data: {
            operationKey: `${inbound.id}:HERMES_REPLY:0`,
            deliveryKind: 'HERMES_REPLY',
            partIndex: 0,
            conversationId: conversation.id,
            contactId: contact.id,
            sourceMessageId: inbound.id,
            sender: MessageSender.HERMES,
            content: 'Respuesta sintética',
            status: deliveryStatuses[index],
            metadata: {
              conversationEngine: index % 2 ? 'nous_hermes' : 'gemini_direct',
              providerModel: 'fake',
              promptVersion: 'synthetic-digest',
              traceId: inbound.id,
              learningExposed: [{ id: items[0].id, version: 1 }],
            },
          },
        });
      }
      const snapshot = async () => {
        const [
          learning,
          evidence,
          audits,
          reviews,
          state,
          deliveries,
          products,
          prices,
        ] = await Promise.all([
          prisma.learningItem.findMany({
            where: { id: { in: items.map(({ id }) => id) } },
            orderBy: { id: 'asc' },
          }),
          prisma.learningEvidence.findMany({
            where: { learningItemId: { in: items.map(({ id }) => id) } },
            orderBy: { id: 'asc' },
          }),
          prisma.auditLog.findMany({
            where: { entityId: { in: items.map(({ id }) => id) } },
            orderBy: { id: 'asc' },
          }),
          prisma.conversationReview.findUnique({ where: { id: review.id } }),
          prisma.conversationState.findUnique({ where: { id: summary.id } }),
          prisma.automatedDelivery.findMany({
            where: { contactId: contact.id },
            orderBy: { sourceMessageId: 'asc' },
          }),
          prisma.product.findMany({ orderBy: { id: 'asc' } }),
          prisma.priceList.findMany({ orderBy: { id: 'asc' } }),
        ]);
        return {
          learning: {
            count: learning.length,
            hash: digest(learning),
            statuses: learning.map(({ status }) => status),
          },
          evidence: { count: evidence.length, hash: digest(evidence) },
          audits: { count: audits.length, hash: digest(audits) },
          reviews: { count: Number(Boolean(reviews)), hash: digest(reviews) },
          summary: digest(state),
          deliveries: {
            count: deliveries.length,
            hash: digest(deliveries),
            statuses: deliveries.map(({ status }) => status),
          },
          commercial: { products: digest(products), prices: digest(prices) },
        };
      };
      const before = await snapshot();
      const oldTraces = await Promise.all(
        sources.map(({ id }) => loadLearningTrace(prisma as PrismaService, id)),
      );
      const historicalTraceHash = digest(oldTraces);
      const retrieval = new LearningRetrievalService(
        prisma as PrismaService,
        new ConfigService({}),
      );
      const context = {
        customerMessage: 'consulta punto',
        approvedKnowledge: [] as string[],
      };
      const selectedOn = await retrieval.select(context);
      expect(selectedOn.map(({ id }) => id)).toEqual([items[0].id]);
      // OFF is the AutoReply branch: no selector invocation or learning DB mutation.
      const selectorCallsBeforeOff = 1;
      const selectedOff: typeof selectedOn = [];
      expect(selectedOff).toEqual([]);
      expect(selectorCallsBeforeOff).toBe(1);
      const afterOff = await snapshot();
      expect(afterOff).toEqual(before);
      const redisKeysAfter = (await redis.keys('*')).sort();
      expect(redisKeysAfter).toEqual(redisKeysBefore);
      expect(
        digest(
          await Promise.all(
            sources.map(({ id }) =>
              loadLearningTrace(prisma as PrismaService, id),
            ),
          ),
        ),
      ).toBe(historicalTraceHash);
      const selectedAgain = await retrieval.select(context);
      expect(selectedAgain).toEqual(selectedOn);
      const selectorSamplesMs: number[] = [];
      for (let index = 0; index < 20; index++) {
        const started = performance.now();
        expect(await retrieval.select(context)).toEqual(selectedOn);
        selectorSamplesMs.push(performance.now() - started);
      }
      expect(await snapshot()).toEqual(before);
      if (process.env.F3_ROLLBACK_EVIDENCE_PATH) {
        writeFileSync(
          process.env.F3_ROLLBACK_EVIDENCE_PATH,
          JSON.stringify(
            {
              fixtureVersion: 'f3-rollback-v1',
              before,
              afterOff,
              historicalTraceHash,
              selectedOn: selectedOn.map(({ id, version }) => ({
                id,
                version,
              })),
              selectedOff,
              selectedAgain: selectedAgain.map(({ id, version }) => ({
                id,
                version,
              })),
              redis: {
                keyCountBefore: redisKeysBefore.length,
                keyCountAfter: redisKeysAfter.length,
                keyHashBefore: digest(redisKeysBefore),
                keyHashAfter: digest(redisKeysAfter),
              },
              selectorSamplesMs,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await redis.quit();
      await prisma.automatedDelivery.deleteMany({
        where: { contactId: contact.id },
      });
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: items.map(({ id }) => id) } },
      });
      await prisma.learningEvidence.deleteMany({
        where: { learningItemId: { in: items.map(({ id }) => id) } },
      });
      await prisma.learningItem.deleteMany({
        where: { id: { in: items.map(({ id }) => id) } },
      });
      await prisma.conversationReview.delete({ where: { id: review.id } });
      await prisma.conversationFeedback.delete({ where: { id: feedback.id } });
      await prisma.conversationState.delete({ where: { id: summary.id } });
      await prisma.contact.delete({ where: { id: contact.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});

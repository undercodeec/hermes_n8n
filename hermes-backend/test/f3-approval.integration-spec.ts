import { ConfigService } from '@nestjs/config';
import {
  ConversationReviewStatus,
  ConversationReviewTrigger,
  FeedbackRating,
  FeedbackReasonCode,
  LearningItemStatus,
  LearningRiskLevel,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import axios from 'axios';
import { AgentOutputValidator } from '../src/conversation-engine/agent-output.validator';
import { DirectGeminiEngine } from '../src/conversation-engine/direct-gemini.engine';
import { NousHermesTransport } from '../src/conversation-engine/nous-hermes.transport';
import type { ConversationTurnInput } from '../src/conversation-engine/conversation-engine.types';
import { HermesService } from '../src/hermes/hermes.service';
import { ConversationReviewService } from '../src/learning/conversation-review.service';
import { LearningRetrievalService } from '../src/learning/learning-retrieval.service';
import { LearningDecisionAction } from '../src/learning/dto/learning-decision.dto';
import { ReviewModelService } from '../src/learning/review-model.service';
import { ReviewCanaryPolicy } from '../src/learning/review-canary.policy';
import { ReviewJobData } from '../src/learning/learning.constants';
import { PrismaService } from '../src/prisma/prisma.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const safeGuidance =
  'Tras confirmar, avanzar al siguiente paso sin repetir la misma oferta';
const reason = 'Decisión humana sobre pauta sintética segura';
const expiry = () => new Date(Date.now() + 30 * 86400_000).toISOString();
const approve = () => ({
  action: LearningDecisionAction.APPROVE,
  reason,
  validUntil: expiry(),
});
const reject = { action: LearningDecisionAction.REJECT, reason };
const retire = { action: LearningDecisionAction.RETIRE, reason };

describe('F3 approval authority on isolated PostgreSQL', () => {
  let prisma: PrismaClient;
  let decisions: ConversationReviewService;
  let retrieval: LearningRetrievalService;
  const timings: Record<string, number[]> = {
    APPROVE: [],
    REJECT: [],
    RETIRE: [],
    SELECT_ACTIVE: [],
    SELECT_INELIGIBLE: [],
  };

  async function clearFixture() {
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
  }

  async function seed(label: string, guidance = safeGuidance) {
    const token = `${label}-${randomUUID()}`;
    const admin = await prisma.user.create({
      data: {
        email: `${token}@example.invalid`,
        password: 'synthetic-password',
        name: 'Synthetic admin',
        role: UserRole.ADMIN,
      },
    });
    const contact = await prisma.contact.create({
      data: { waId: `approval-${token}` },
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
        content: 'Confirmo el siguiente paso',
        wamid: `wamid.source.${token}`,
      },
    });
    const answer = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        type: MessageType.TEXT,
        content: 'Respuesta sintética',
        wamid: `wamid.answer.${token}`,
      },
    });
    const feedback = await prisma.conversationFeedback.create({
      data: {
        conversationId: conversation.id,
        messageId: answer.id,
        userId: admin.id,
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
        requestKey: `feedback-${token}`,
      },
    });
    const review = await prisma.conversationReview.create({
      data: {
        reviewKey: `approval-${token}`,
        conversationId: conversation.id,
        sourceMessageId: source.id,
        feedbackId: feedback.id,
        reviewerVersion: 'synthetic-approval-v1',
        trigger: ConversationReviewTrigger.BAD_FEEDBACK,
        status: ConversationReviewStatus.PROPOSED,
        issueCode: 'REPETITION',
        summary: 'Pauta general segura',
        confidence: 1,
      },
    });
    const item = await prisma.learningItem.create({
      data: {
        fingerprint: randomUUID(),
        version: 1,
        kind: 'STYLE',
        trigger: 'cliente confirma siguiente paso',
        guidance,
        riskLevel: LearningRiskLevel.NEEDS_REVIEW,
        sourceReviewId: review.id,
      },
    });
    const evidence = await prisma.learningEvidence.create({
      data: {
        learningItemId: item.id,
        conversationId: conversation.id,
        messageId: source.id,
        feedbackId: feedback.id,
        reviewId: review.id,
      },
    });
    return {
      admin,
      contact,
      conversation,
      source,
      feedback,
      review,
      item,
      evidence,
    };
  }

  async function decide(
    id: string,
    dto: ReturnType<typeof approve> | typeof reject | typeof retire,
    actor: string,
  ) {
    const started = performance.now();
    const result = await decisions.decide(id, dto, actor);
    timings[dto.action].push(performance.now() - started);
    return result;
  }

  async function select(id: string) {
    const started = performance.now();
    const result = await retrieval.select({
      customerMessage: 'cliente confirma siguiente paso',
      approvedKnowledge: [],
      traceId: 'synthetic-current-inbound',
    });
    timings[
      result.some((entry) => entry.id === id)
        ? 'SELECT_ACTIVE'
        : 'SELECT_INELIGIBLE'
    ].push(performance.now() - started);
    return result;
  }

  async function captureEngine(
    engine: 'gemini_direct' | 'nous_hermes',
    approvedLearning: ConversationTurnInput['approvedContext']['approvedLearning'],
  ) {
    const turn: ConversationTurnInput = {
      conversationId: 'synthetic-current-conversation',
      inboundMessageId: 'synthetic-current-inbound',
      customerMessage: 'cliente confirma siguiente paso',
      approvedContext: {
        contactName: 'Cliente',
        recentMessages: [],
        approvedKnowledge: [],
        approvedLearning,
        handoffActive: false,
      },
    };
    if (engine === 'gemini_direct') {
      const hermes = new HermesService(
        new ConfigService({
          HERMES_API_KEY: 'synthetic-only',
          HERMES_MODEL: 'gemini-test',
          HERMES_API_URL:
            'https://generativelanguage.googleapis.com/v1beta/openai/',
          HERMES_STRUCTURED_OUTPUT: 'true',
        }),
        {
          knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
          product: { findMany: jest.fn().mockResolvedValue([]) },
          salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
        } as unknown as PrismaService,
      );
      const post = jest.fn().mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  response: 'Con gusto le ayudo.',
                  detectedIntent: 'info_general',
                  nextAction: 'sin_accion',
                }),
              },
            },
          ],
        },
      });
      (
        hermes as unknown as { httpClient: { post: jest.Mock } }
      ).httpClient.post = post;
      const result = await new DirectGeminiEngine(hermes).respond(turn);
      return {
        request: JSON.stringify(
          (post.mock.calls as Array<[string, unknown]>)[0][1],
        ),
        exposed: result.learningExposed,
      };
    }
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Con gusto le ayudo.' }),
            },
          },
        ],
      },
    });
    try {
      const transport = new NousHermesTransport(
        new ConfigService({}),
        new AgentOutputValidator(),
        { read: jest.fn().mockResolvedValue('synthetic-only') },
      );
      const result = await transport.execute(turn);
      return {
        request: JSON.stringify(
          (post.mock.calls as Array<[string, unknown]>)[0][1],
        ),
        exposed: result.learningExposed,
      };
    } finally {
      post.mockRestore();
    }
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Isolated database URL required');
    const target = new URL(databaseUrl);
    if (
      target.hostname !== '127.0.0.1' ||
      target.port !== '55432' ||
      !target.pathname.includes('hermes_learning_test')
    )
      throw new Error('Refusing non-isolated database');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    const config = new ConfigService({});
    retrieval = new LearningRetrievalService(prisma as PrismaService, config);
    decisions = new ConversationReviewService(
      prisma as PrismaService,
      config,
      {} as ReviewModelService,
      {} as Queue<ReviewJobData>,
      {} as ReviewCanaryPolicy,
      retrieval,
    );
  });

  beforeEach(async () => clearFixture());
  afterAll(async () => {
    if (prisma) {
      const summary = Object.fromEntries(
        Object.entries(timings).map(([operation, values]) => {
          const ordered = [...values].sort((a, b) => a - b);
          const midpoint = Math.floor(ordered.length / 2);
          return [
            operation,
            ordered.length
              ? {
                  unit: 'ms',
                  samples: ordered.length,
                  min: ordered[0],
                  max: ordered.at(-1),
                  mean:
                    ordered.reduce((sum, value) => sum + value, 0) /
                    ordered.length,
                  median:
                    ordered.length % 2
                      ? ordered[midpoint]
                      : (ordered[midpoint - 1] + ordered[midpoint]) / 2,
                  p50: ordered[Math.ceil(0.5 * ordered.length) - 1],
                  p95: ordered[Math.ceil(0.95 * ordered.length) - 1],
                }
              : null,
          ];
        }),
      );
      const artifactDir = resolve(process.cwd(), 'artifacts/f3-approval-gate');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        resolve(artifactDir, 'measurements.tmp.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      await clearFixture();
      await prisma.$disconnect();
    }
  });

  it('requires an audited human APPROVE, then RETIRE removes eligibility immediately', async () => {
    const fixture = await seed('lifecycle');
    expect(await select(fixture.item.id)).toEqual([]);
    const before = await prisma.learningItem.findUniqueOrThrow({
      where: { id: fixture.item.id },
      include: { evidence: true },
    });
    const approved = await decide(fixture.item.id, approve(), fixture.admin.id);
    expect(approved.status).toBe(LearningItemStatus.ACTIVE);
    const active = await prisma.learningItem.findUniqueOrThrow({
      where: { id: fixture.item.id },
      include: { evidence: true },
    });
    expect(active.approvedById).toBe(fixture.admin.id);
    expect(active.approvedAt).toBeInstanceOf(Date);
    expect(active.validUntil?.getTime()).toBeGreaterThan(Date.now());
    expect({
      fingerprint: active.fingerprint,
      version: active.version,
      kind: active.kind,
      trigger: active.trigger,
      guidance: active.guidance,
      serviceCode: active.serviceCode,
      market: active.market,
    }).toEqual({
      fingerprint: before.fingerprint,
      version: before.version,
      kind: before.kind,
      trigger: before.trigger,
      guidance: before.guidance,
      serviceCode: before.serviceCode,
      market: before.market,
    });
    expect(active.evidence.map(({ id }) => id)).toEqual([fixture.evidence.id]);
    expect((await select(fixture.item.id)).map(({ id }) => id)).toEqual([
      fixture.item.id,
    ]);
    await decide(fixture.item.id, retire, fixture.admin.id);
    expect(await select(fixture.item.id)).toEqual([]);
    const retiredRows = await prisma.learningItem.findMany({
      where: { id: fixture.item.id },
    });
    expect(retiredRows).toHaveLength(1);
    expect(retiredRows[0].fingerprint).toBe(before.fingerprint);
    expect(retiredRows[0].version).toBe(before.version);
    expect(retiredRows[0].guidance).toBe(before.guidance);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: fixture.item.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map(({ action, userId }) => ({ action, userId }))).toEqual([
      { action: 'LEARNING_APPROVE', userId: fixture.admin.id },
      { action: 'LEARNING_RETIRE', userId: fixture.admin.id },
    ]);
    expect(audits.map(({ changes }) => changes)).toEqual([
      expect.objectContaining({
        before: 'PROPOSED',
        after: 'ACTIVE',
        reason,
        version: 1,
      }),
      expect.objectContaining({
        before: 'ACTIVE',
        after: 'RETIRED',
        reason,
        version: 1,
      }),
    ]);
  });

  it('REJECT keeps a proposed item out of retrieval and records one audit', async () => {
    const { item, admin } = await seed('reject');
    await decide(item.id, reject, admin.id);
    expect(
      (await prisma.learningItem.findUniqueOrThrow({ where: { id: item.id } }))
        .status,
    ).toBe(LearningItemStatus.REJECTED);
    expect(await select(item.id)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { entityId: item.id } })).toBe(
      1,
    );
  });

  it.each([
    [LearningItemStatus.PROPOSED, LearningDecisionAction.RETIRE],
    [LearningItemStatus.ACTIVE, LearningDecisionAction.APPROVE],
    [LearningItemStatus.ACTIVE, LearningDecisionAction.REJECT],
    [LearningItemStatus.REJECTED, LearningDecisionAction.APPROVE],
    [LearningItemStatus.REJECTED, LearningDecisionAction.RETIRE],
    [LearningItemStatus.RETIRED, LearningDecisionAction.APPROVE],
    [LearningItemStatus.RETIRED, LearningDecisionAction.REJECT],
    [LearningItemStatus.RETIRED, LearningDecisionAction.RETIRE],
  ])('rejects invalid transition %s + %s', async (status, action) => {
    const fixture = await seed('invalid');
    await prisma.learningItem.update({
      where: { id: fixture.item.id },
      data: { status },
    });
    const dto =
      action === LearningDecisionAction.APPROVE
        ? approve()
        : { action, reason };
    await expect(
      decisions.decide(fixture.item.id, dto, fixture.admin.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(status);
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(0);
  });

  it.each([
    [LearningDecisionAction.APPROVE, LearningDecisionAction.REJECT],
    [LearningDecisionAction.APPROVE, LearningDecisionAction.APPROVE],
    [LearningDecisionAction.REJECT, LearningDecisionAction.REJECT],
  ])('serializes concurrent %s vs %s', async (first, second) => {
    const fixture = await seed('race');
    const dto = (action: LearningDecisionAction) =>
      action === LearningDecisionAction.APPROVE ? approve() : reject;
    const results = await Promise.allSettled([
      decisions.decide(fixture.item.id, dto(first), fixture.admin.id),
      decisions.decide(fixture.item.id, dto(second), fixture.admin.id),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(1);
    const winner = results.find(({ status }) => status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('No winner');
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(winner.value.status);
  });

  it('rejects stale and replayed decisions without a second audit or version', async () => {
    const fixture = await seed('stale');
    await decide(fixture.item.id, approve(), fixture.admin.id);
    for (const dto of [approve(), reject]) {
      await expect(
        decisions.decide(fixture.item.id, dto, fixture.admin.id),
      ).rejects.toMatchObject({ status: 409 });
    }
    await decide(fixture.item.id, retire, fixture.admin.id);
    await expect(
      decisions.decide(fixture.item.id, retire, fixture.admin.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(2);
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).version,
    ).toBe(1);
  });

  it('allows only one concurrent RETIRE and no later retrieval', async () => {
    const fixture = await seed('retire-race');
    await decide(fixture.item.id, approve(), fixture.admin.id);
    expect((await select(fixture.item.id)).length).toBe(1);
    const results = await Promise.allSettled([
      decisions.decide(fixture.item.id, retire, fixture.admin.id),
      decisions.decide(fixture.item.id, retire, fixture.admin.id),
      retrieval.select({
        customerMessage: 'cliente confirma siguiente paso',
        approvedKnowledge: [],
      }),
    ]);
    expect(
      results.slice(0, 2).filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.slice(0, 2).filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    // An already prepared request may still contain the item; a later query may not.
    expect(await select(fixture.item.id)).toEqual([]);
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(2);
  });

  it('validates and sanitizes decision reason before writing, including Unicode', async () => {
    const fixture = await seed('reason');
    for (const invalid of [
      '',
      '  ',
      'too short',
      'a'.repeat(501),
      'Escribir a synthetic@example.invalid',
      'Llamar al +593000000731',
    ]) {
      await expect(
        decisions.decide(
          fixture.item.id,
          { action: LearningDecisionAction.REJECT, reason: invalid },
          fixture.admin.id,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(0);
    await decide(
      fixture.item.id,
      {
        action: LearningDecisionAction.REJECT,
        reason: '  Motivo sintético válido  ',
      },
      fixture.admin.id,
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: fixture.item.id },
    });
    expect(audit.changes).toEqual(
      expect.objectContaining({ reason: 'Motivo sintético válido' }),
    );
    await expect(
      decisions.decide('missing-synthetic-item', reject, fixture.admin.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('approval requires current effective evidence and loss after approval stops retrieval', async () => {
    const fixture = await seed('evidence');
    await prisma.learningEvidence.delete({
      where: { id: fixture.evidence.id },
    });
    await expect(
      decisions.decide(fixture.item.id, approve(), fixture.admin.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(LearningItemStatus.PROPOSED);
    const restored = await prisma.learningEvidence.create({
      data: {
        learningItemId: fixture.item.id,
        conversationId: fixture.conversation.id,
        messageId: fixture.source.id,
        feedbackId: fixture.feedback.id,
        reviewId: fixture.review.id,
      },
    });
    await decide(fixture.item.id, approve(), fixture.admin.id);
    expect((await select(fixture.item.id)).length).toBe(1);
    await prisma.learningEvidence.delete({ where: { id: restored.id } });
    expect(await select(fixture.item.id)).toEqual([]);
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(LearningItemStatus.ACTIVE);
  });

  it.each([
    [
      'review',
      async (f: Awaited<ReturnType<typeof seed>>) =>
        prisma.conversationReview.update({
          where: { id: f.review.id },
          data: { status: ConversationReviewStatus.FAILED },
        }),
    ],
    [
      'feedback',
      async (f: Awaited<ReturnType<typeof seed>>) =>
        prisma.conversationFeedback.update({
          where: { id: f.feedback.id },
          data: { rating: FeedbackRating.GOOD },
        }),
    ],
    [
      'missing message',
      async (f: Awaited<ReturnType<typeof seed>>) =>
        prisma.message.delete({ where: { id: f.source.id } }),
    ],
  ])('invalid %s evidence blocks approval', async (_case, invalidate) => {
    const fixture = await seed('ineffective');
    await invalidate(fixture);
    await expect(
      decisions.decide(fixture.item.id, approve(), fixture.admin.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(await select(fixture.item.id)).toEqual([]);
  });

  it('validates expiry and keeps approved expired or HIGH items out of retrieval', async () => {
    const fixture = await seed('expiry');
    for (const validUntil of [
      undefined,
      'not-a-date',
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 181 * 86400_000).toISOString(),
    ]) {
      await expect(
        decisions.decide(
          fixture.item.id,
          { action: LearningDecisionAction.APPROVE, reason, validUntil },
          fixture.admin.id,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    const atLimit = new Date(Date.now() + 180 * 86400_000).toISOString();
    await decide(
      fixture.item.id,
      { action: LearningDecisionAction.APPROVE, reason, validUntil: atLimit },
      fixture.admin.id,
    );
    expect((await select(fixture.item.id)).length).toBe(1);
    await prisma.learningItem.update({
      where: { id: fixture.item.id },
      data: { validUntil: new Date(Date.now() - 1000) },
    });
    expect(await select(fixture.item.id)).toEqual([]);
    const high = await seed('high');
    await prisma.learningItem.update({
      where: { id: high.item.id },
      data: { riskLevel: LearningRiskLevel.HIGH },
    });
    await decide(high.item.id, approve(), high.admin.id);
    expect(await select(high.item.id)).toEqual([]);
  });

  it.each([
    'Responder a Ana Borel primero',
    'Ofrecer 20% de descuento por transferencia',
    'Aceptar pago 50/50',
  ])('approval rejects private or commercial candidate', async (guidance) => {
    const fixture = await seed('unsafe', guidance);
    await expect(
      decisions.decide(fixture.item.id, approve(), fixture.admin.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(LearningItemStatus.PROPOSED);
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(0);
  });

  it('rolls back activation if audit persistence fails', async () => {
    const fixture = await seed('audit-fail');
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION f3_approval_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.action = 'LEARNING_APPROVE' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER f3_approval_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION f3_approval_audit_fail()`,
    );
    try {
      await expect(
        decisions.decide(fixture.item.id, approve(), fixture.admin.id),
      ).rejects.toThrow();
      expect(
        (
          await prisma.learningItem.findUniqueOrThrow({
            where: { id: fixture.item.id },
          })
        ).status,
      ).toBe(LearningItemStatus.PROPOSED);
      expect(
        await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS f3_approval_audit_fail ON audit_logs`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS f3_approval_audit_fail()`,
      );
    }
  });

  it('does not activate an item for a nonexistent actor', async () => {
    const fixture = await seed('missing-actor');
    await expect(
      decisions.decide(fixture.item.id, approve(), randomUUID()),
    ).rejects.toThrow();
    expect(
      (
        await prisma.learningItem.findUniqueOrThrow({
          where: { id: fixture.item.id },
        })
      ).status,
    ).toBe(LearningItemStatus.PROPOSED);
    expect(
      await prisma.auditLog.count({ where: { entityId: fixture.item.id } }),
    ).toBe(0);
  });

  it.each(['gemini_direct', 'nous_hermes'] as const)(
    '%s receives only valid ACTIVE guidance across PROPOSED, ACTIVE, expired, RETIRED, REJECTED',
    async (engine) => {
      const active = await seed(`engine-${engine}`);
      const verify = async (itemId: string, shouldExpose: boolean) => {
        const selected = await select(itemId);
        const captured = await captureEngine(engine, selected);
        expect(captured.request.includes(itemId)).toBe(shouldExpose);
        expect(captured.request.includes(safeGuidance)).toBe(shouldExpose);
        expect(captured.exposed ?? []).toEqual(
          shouldExpose ? [{ id: itemId, version: 1 }] : [],
        );
      };
      await verify(active.item.id, false);
      await decide(active.item.id, approve(), active.admin.id);
      await verify(active.item.id, true);
      await prisma.learningItem.update({
        where: { id: active.item.id },
        data: { validUntil: new Date(Date.now() - 1000) },
      });
      await verify(active.item.id, false);
      await decide(active.item.id, retire, active.admin.id);
      await verify(active.item.id, false);
      const rejected = await seed(`engine-rejected-${engine}`);
      await decide(rejected.item.id, reject, rejected.admin.id);
      await verify(rejected.item.id, false);
    },
  );

  it('samples local decision DB operations and eligible/ineligible selector queries', async () => {
    for (let index = 0; index < 12; index++) {
      const approved = await seed(`measure-approved-${index}`);
      await decide(approved.item.id, approve(), approved.admin.id);
      expect((await select(approved.item.id)).length).toBe(1);
      await decide(approved.item.id, retire, approved.admin.id);
      expect(await select(approved.item.id)).toEqual([]);
      const rejected = await seed(`measure-rejected-${index}`);
      await decide(rejected.item.id, reject, rejected.admin.id);
      expect(await select(rejected.item.id)).toEqual([]);
    }
  });
});

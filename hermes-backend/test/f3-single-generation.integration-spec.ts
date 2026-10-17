import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  ConversationStatus,
  InboundTurnStatus,
  MessageDirection,
  MessageSender,
} from '@prisma/client';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { AutoReplyService } from '../src/auto-replies/auto-reply.service';
import type { AutoReplyJobData } from '../src/auto-replies/auto-reply.constants';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import { InboundTurnRecoveryService } from '../src/auto-replies/inbound-turn-recovery.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { ConversationEngineService } from '../src/conversation-engine/conversation-engine.service';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from '../src/conversation-engine/conversation-engine.types';
import { AgentOutputValidator } from '../src/conversation-engine/agent-output.validator';
import { NousHermesTransport } from '../src/conversation-engine/nous-hermes.transport';
import { NousHermesProcessor } from '../src/conversation-engine/nous-hermes.processor';
import { CommercialPolicyService } from '../src/hermes/commercial-policy.service';
import { CommercialAuthorityService } from '../src/hermes/commercial-authority.service';
import { ConversationGuardService } from '../src/conversation-guard/conversation-guard.service';
import { HandoffService } from '../src/handoff/handoff.service';
import { LeadsService } from '../src/leads/leads.service';
import { MetaService } from '../src/meta/meta.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TasksService } from '../src/tasks/tasks.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (!databaseUrl) throw new Error('DATABASE_INTEGRATION_URL is required');
if (!redisUrl || !redisUrl.startsWith('redis://127.0.0.1:56379/'))
  throw new Error('Refusing non-isolated Redis');
if (!databaseUrl.includes('127.0.0.1:55432/hermes_learning_test'))
  throw new Error('Refusing non-isolated database');

describe('F3 single-generation canary with PostgreSQL', () => {
  let prisma: PrismaService;
  const contacts: string[] = [];
  const configFor = (conversationId: string, enabled = true) =>
    ({
      get: (key: string, fallback?: unknown) =>
        ({
          F3_SINGLE_GENERATION_CANARY_ENABLED: String(enabled),
          F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: conversationId,
          HERMES_COMPLETION_ATTEMPTS: '1',
          NOUS_HERMES_MAX_ATTEMPTS: '1',
          HERMES_CONVERSATION_MESSAGE_DELAY_MS: 0,
          AI_MESSAGE_PART_DELAY_MS: 0,
        })[key as 'F3_SINGLE_GENERATION_CANARY_ENABLED'] ?? fallback,
    }) as ConfigService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.automatedDelivery.deleteMany({
      where: { conversation: { contactId: { in: contacts } } },
    });
    await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    await prisma.$disconnect();
  });

  async function fixture() {
    const contact = await prisma.contact.create({
      data: { waId: `f3-${randomUUID()}` },
    });
    contacts.push(contact.id);
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, status: ConversationStatus.ACTIVE },
    });
    const source = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        content: 'Quiero ajustar el alcance del proyecto.',
        wamid: `wamid.${randomUUID()}`,
      },
    });
    const turn = await prisma.inboundTurn.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        firstAt: new Date(Date.now() - 2000),
        lastAt: new Date(Date.now() - 2000),
        dueAt: new Date(Date.now() - 1000),
        lastMessageId: source.id,
      },
    });
    await prisma.message.update({
      where: { id: source.id },
      data: { inboundTurnId: turn.id, inboundTurnPosition: 0 },
    });
    const turns = new InboundTurnService(prisma, configFor(conversation.id));
    return { contact, conversation, source, turn, turns };
  }

  async function reserve(
    f: Awaited<ReturnType<typeof fixture>>,
    engine: 'gemini_direct' | 'nous_hermes' = 'gemini_direct',
  ) {
    const claim = await f.turns.claim(f.turn.id);
    expect(claim).not.toBeNull();
    const acquired = await f.turns.reserveGeneration({
      turnId: f.turn.id,
      processingToken: claim!.processingToken!,
      sourceMessageId: f.source.id,
      conversationId: f.conversation.id,
      engine,
    });
    expect(acquired).toBe(true);
    return claim!;
  }

  function replayService(
    f: Awaited<ReturnType<typeof fixture>>,
    deliveries: { recoverBatch: jest.Mock; getBatchProgress: jest.Mock },
    enabled = true,
  ) {
    const engine = { respond: jest.fn() };
    const service = new AutoReplyService(
      configFor(f.conversation.id, enabled),
      prisma,
      {} as MetaService,
      engine as unknown as ConversationEngineService,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as CommercialAuthorityService,
      {} as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue<AutoReplyJobData>,
      deliveries as unknown as AutomatedDeliveryService,
      f.turns,
    );
    return { service, engine };
  }

  const jobFor = (f: Awaited<ReturnType<typeof fixture>>) => ({
    conversationId: f.conversation.id,
    contactId: f.contact.id,
    inboundMessageId: f.source.id,
    inboundTurnId: f.turn.id,
  });

  it('allows one concurrent reservation and one Nous dispatch with durable state', async () => {
    const f = await fixture();
    const claim = await f.turns.claim(f.turn.id);
    const request = {
      turnId: f.turn.id,
      processingToken: claim!.processingToken!,
      sourceMessageId: f.source.id,
      conversationId: f.conversation.id,
      engine: 'nous_hermes' as const,
    };
    const acquisitions = await Promise.all([
      f.turns.reserveGeneration(request),
      f.turns.reserveGeneration(request),
    ]);
    expect(acquisitions.sort()).toEqual([false, true]);
    const dispatch = {
      turnId: f.turn.id,
      conversationId: f.conversation.id,
      sourceMessageId: f.source.id,
      generationToken: claim!.processingToken!,
    };
    const outcomes = await Promise.all([
      f.turns.reserveNousDispatch(dispatch),
      f.turns.reserveNousDispatch(dispatch),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .providerDispatchReservedAt,
    ).not.toBeNull();
  });

  it('enforces unique source identity across distinct turns in PostgreSQL', async () => {
    const first = await fixture();
    const second = await fixture();
    await reserve(first);
    await expect(
      prisma.inboundTurn.update({
        where: { id: second.turn.id },
        data: { generationSourceMessageId: first.source.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('limits duplicate BullMQ Nous jobs to one fake HTTP request', async () => {
    const f = await fixture();
    const claim = await reserve(f, 'nous_hermes');
    const endpoint = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Respuesta sintética.' }),
            },
          },
        ],
      },
    });
    const transport = new NousHermesTransport(
      configFor(f.conversation.id),
      new AgentOutputValidator(),
      { read: jest.fn().mockResolvedValue('synthetic-secret') },
      f.turns,
      prisma,
    );
    const parsed = new URL(redisUrl);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port),
      maxRetriesPerRequest: null,
    };
    const name = `f3-single-generation-${randomUUID()}`;
    const queue = new Queue<ConversationTurnInput, ConversationTurnResult>(
      name,
      { connection },
    );
    const events = new QueueEvents(name, { connection });
    const worker = new Worker<ConversationTurnInput, ConversationTurnResult>(
      name,
      async (job) => transport.execute(job.data),
      { connection, concurrency: 2 },
    );
    try {
      await Promise.all([
        queue.waitUntilReady(),
        events.waitUntilReady(),
        worker.waitUntilReady(),
      ]);
      const payload = {
        conversationId: f.conversation.id,
        inboundMessageId: f.source.id,
        customerMessage: 'Consulta sintética',
        singleGenerationCanary: {
          turnId: f.turn.id,
          processingToken: claim.processingToken!,
          generationToken: claim.processingToken!,
        },
        approvedContext: {
          recentMessages: [],
          approvedKnowledge: [],
          handoffActive: false,
          contactName: 'Cliente',
        },
      };
      const first = await queue.add('infer', payload, {
        jobId: `first-${randomUUID()}`,
        attempts: 1,
      });
      const second = await queue.add('infer', payload, {
        jobId: `replay-${randomUUID()}`,
        attempts: 1,
      });
      const outcomes = await Promise.allSettled([
        first.waitUntilFinished(events, 5000),
        second.waitUntilFinished(events, 5000),
      ]);
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(endpoint).toHaveBeenCalledTimes(1);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      endpoint.mockRestore();
    }
  });

  it('denies a replay after a Nous worker restart through the real queue handler', async () => {
    // A timed BullMQ stall depends on lock-renew scheduling. Re-delivery after
    // worker restart runs the same WorkerHost.process path deterministically.
    const f = await fixture();
    const claim = await reserve(f, 'nous_hermes');
    const endpoint = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Respuesta sintética.' }),
            },
          },
        ],
      },
    });
    const parsed = new URL(redisUrl);
    const connection = {
      host: parsed.hostname,
      port: Number(parsed.port),
      maxRetriesPerRequest: null,
    };
    const name = `f3-restart-replay-${randomUUID()}`;
    const queue = new Queue<ConversationTurnInput, ConversationTurnResult>(
      name,
      { connection },
    );
    const events = new QueueEvents(name, { connection });
    const processor = () =>
      new NousHermesProcessor(
        new NousHermesTransport(
          configFor(f.conversation.id),
          new AgentOutputValidator(),
          { read: jest.fn().mockResolvedValue('synthetic-secret') },
          f.turns,
          prisma,
        ),
      );
    let worker:
      | Worker<ConversationTurnInput, ConversationTurnResult>
      | undefined;
    const payload: ConversationTurnInput = {
      conversationId: f.conversation.id,
      inboundMessageId: f.source.id,
      customerMessage: 'Consulta sintética',
      singleGenerationCanary: {
        turnId: f.turn.id,
        processingToken: claim.processingToken!,
        generationToken: claim.processingToken!,
      },
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Cliente',
      },
    };
    try {
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
      const firstProcessor = processor();
      worker = new Worker(name, (job) => firstProcessor.process(job), {
        connection,
      });
      await worker.waitUntilReady();
      const first = await queue.add('infer', payload, { attempts: 1 });
      await first.waitUntilFinished(events, 5000);
      expect(
        (
          await prisma.inboundTurn.findUniqueOrThrow({
            where: { id: f.turn.id },
          })
        ).providerDispatchReservedAt,
      ).not.toBeNull();
      expect(endpoint).toHaveBeenCalledTimes(1);

      await worker.close();
      worker = undefined;
      const restartedProcessor = processor();
      worker = new Worker(name, (job) => restartedProcessor.process(job), {
        connection,
      });
      await worker.waitUntilReady();
      const replay = await queue.add('infer', payload, { attempts: 1 });
      await expect(replay.waitUntilFinished(events, 5000)).rejects.toThrow(
        'CANARY_NOUS_DISPATCH_DENIED',
      );
      expect(endpoint).toHaveBeenCalledTimes(1);
    } finally {
      await worker?.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      endpoint.mockRestore();
    }
  });

  it('denies a Nous HTTP request that starts after the turn was blocked', async () => {
    const f = await fixture();
    const claim = await reserve(f, 'nous_hermes');
    await f.turns.blockAmbiguous(f.turn.id, claim.processingToken!);
    const endpoint = jest.spyOn(axios, 'post');
    try {
      const transport = new NousHermesTransport(
        configFor(f.conversation.id),
        new AgentOutputValidator(),
        { read: jest.fn().mockResolvedValue('synthetic-secret') },
        f.turns,
        prisma,
      );
      await expect(
        transport.execute({
          conversationId: f.conversation.id,
          inboundMessageId: f.source.id,
          customerMessage: 'Consulta sintética',
          singleGenerationCanary: {
            turnId: f.turn.id,
            processingToken: claim.processingToken!,
            generationToken: claim.processingToken!,
          },
          approvedContext: {
            recentMessages: [],
            approvedKnowledge: [],
            handoffActive: false,
            contactName: 'Cliente',
          },
        }),
      ).rejects.toThrow('CANARY_NOUS_DISPATCH_DENIED');
      expect(endpoint).not.toHaveBeenCalled();
    } finally {
      endpoint.mockRestore();
    }
  });

  it('blocks after reservation before provider and survives flag OFF', async () => {
    const f = await fixture();
    const claim = await reserve(f);
    await f.turns.release(f.turn.id, claim.processingToken!);
    const blocked = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: f.turn.id },
    });
    expect(blocked.status).toBe(InboundTurnStatus.BLOCKED);
    expect(blocked.generationBlockReason).toBe(
      'CANARY_BLOCKED_AMBIGUOUS_GENERATION',
    );
    const off = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    expect(await off.claim(f.turn.id)).toBeNull();
    expect(blocked.generationSourceMessageId).toBe(f.source.id);
  });

  it('keeps a historical reservation closed after flag OFF even if an old job reopens the turn', async () => {
    const f = await fixture();
    await reserve(f);
    await prisma.inboundTurn.update({
      where: { id: f.turn.id },
      data: {
        status: InboundTurnStatus.OPEN,
        processingToken: null,
        processingAt: null,
      },
    });
    const { service, engine } = replayService(
      f,
      {
        recoverBatch: jest.fn().mockResolvedValue(null),
        getBatchProgress: jest.fn().mockResolvedValue(undefined),
      },
      false,
    );
    await service.process(jobFor(f));
    expect(engine.respond).not.toHaveBeenCalled();
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.BLOCKED);
  });

  it('recovers an existing durable multipart batch without another generation', async () => {
    const f = await fixture();
    const claim = await reserve(f);
    const deliveries = new AutomatedDeliveryService(prisma, {} as MetaService);
    await deliveries.prepareBatch(
      {
        deliveryKind: 'HERMES_REPLY',
        conversationId: f.conversation.id,
        contactId: f.contact.id,
        sourceMessageId: f.source.id,
        sender: 'HERMES',
        allowHandedOff: false,
        parts: [
          { partIndex: 0, content: 'Primera parte' },
          { partIndex: 1, content: 'Segunda parte' },
        ],
      },
      {
        turnId: f.turn.id,
        processingToken: claim.processingToken!,
        generationToken: claim.processingToken!,
      },
    );
    await f.turns.release(f.turn.id, claim.processingToken!);
    const recovered = {
      recoverBatch: jest
        .fn()
        .mockResolvedValue({ handled: true, confirmed: 0, terminal: true }),
      getBatchProgress: jest.fn().mockResolvedValue(undefined),
    };
    const { service, engine } = replayService(f, recovered);
    await service.process(jobFor(f));
    expect(recovered.recoverBatch).toHaveBeenCalledWith(f.source.id);
    expect(engine.respond).not.toHaveBeenCalled();
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.PROCESSED);
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: f.source.id },
      }),
    ).toBe(2);
  });

  it('blocks stale reserved turns during periodic recovery without enqueueing', async () => {
    const f = await fixture();
    await reserve(f);
    await prisma.inboundTurn.update({
      where: { id: f.turn.id },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    const queueAdd = jest.fn();
    const queue = { add: queueAdd } as unknown as Queue<AutoReplyJobData>;
    const recovery = new InboundTurnRecoveryService(f.turns, queue);
    await recovery.scan();
    expect(
      (
        queueAdd.mock.calls as unknown as Array<[string, AutoReplyJobData]>
      ).some(([, job]) => job.inboundTurnId === f.turn.id),
    ).toBe(false);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.BLOCKED);
  });

  it('serializes prepareBatch against BLOCKED: complete batch or no rows', async () => {
    const f = await fixture();
    const claim = await reserve(f);
    const deliveries = new AutomatedDeliveryService(prisma, {} as MetaService);
    const batch = {
      deliveryKind: 'HERMES_REPLY' as const,
      conversationId: f.conversation.id,
      contactId: f.contact.id,
      sourceMessageId: f.source.id,
      sender: 'HERMES' as const,
      allowHandedOff: false,
      parts: [
        { partIndex: 0, content: 'Primera parte' },
        { partIndex: 1, content: 'Segunda parte' },
      ],
    };
    const outcome = await Promise.allSettled([
      deliveries.prepareBatch(batch, {
        turnId: f.turn.id,
        processingToken: claim.processingToken!,
        generationToken: claim.processingToken!,
      }),
      f.turns.blockAmbiguous(f.turn.id),
    ]);
    const rows = await prisma.automatedDelivery.findMany({
      where: { sourceMessageId: f.source.id },
      orderBy: { partIndex: 'asc' },
    });
    const current = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: f.turn.id },
    });
    expect([
      [0, 'BLOCKED'],
      [2, 'PROCESSING'],
    ]).toContainEqual([rows.length, current.status]);
    if (rows.length === 2)
      expect(rows.map((row) => row.partIndex)).toEqual([0, 1]);
    expect(outcome).toHaveLength(2);
  });

  it('rejects a late batch from a worker whose turn was blocked', async () => {
    const f = await fixture();
    const claim = await reserve(f);
    expect(
      await f.turns.blockAmbiguous(f.turn.id, claim.processingToken!),
    ).toBe(true);
    const deliveries = new AutomatedDeliveryService(prisma, {} as MetaService);
    await expect(
      deliveries.prepareBatch(
        {
          deliveryKind: 'HERMES_REPLY',
          conversationId: f.conversation.id,
          contactId: f.contact.id,
          sourceMessageId: f.source.id,
          sender: 'HERMES',
          allowHandedOff: false,
          parts: [{ partIndex: 0, content: 'Respuesta tardía' }],
        },
        {
          turnId: f.turn.id,
          processingToken: claim.processingToken!,
          generationToken: claim.processingToken!,
        },
      ),
    ).rejects.toThrow('CANARY_GENERATION_CLAIM_LOST');
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: f.source.id },
      }),
    ).toBe(0);
  });

  it.each([
    ['before provider', false],
    ['during provider', true],
    ['after provider before batch', true],
  ])(
    'does not call provider again after crash %s',
    async (_label, reachedProvider) => {
      const f = await fixture();
      const provider = jest.fn();
      const engine = {
        selectedEngine: jest.fn().mockReturnValue('gemini_direct'),
        respond: jest.fn().mockImplementation(async () => {
          await Promise.resolve();
          if (reachedProvider) provider();
          if (reachedProvider && _label === 'after provider before batch')
            return {
              replyText: 'Respuesta sintética.',
              proposedActions: [{ type: 'none' }],
              engine: 'gemini_direct',
              providerModel: 'fake',
              traceId: f.source.id,
            };
          throw new Error('simulated crash');
        }),
      };
      const deliveries = {
        recoverBatch: jest.fn().mockResolvedValue(null),
        getBatchProgress: jest.fn().mockResolvedValue(undefined),
        prepareBatch: jest
          .fn()
          .mockRejectedValue(new Error('simulated crash before batch')),
        recordSuppressedInference: jest.fn(),
      };
      const reply = new AutoReplyService(
        configFor(f.conversation.id),
        prisma,
        { showTypingIndicator: jest.fn() } as unknown as MetaService,
        engine as unknown as ConversationEngineService,
        { create: jest.fn() } as unknown as HandoffService,
        {
          recordCommercialProfileFromConversation: jest.fn(),
        } as unknown as LeadsService,
        { requestCallback: jest.fn() } as unknown as TasksService,
        new CommercialPolicyService(),
        {
          snapshot: jest.fn().mockResolvedValue({
            market: 'EC',
            marketSource: 'PROFILE',
            relevantServiceCodes: [],
            offers: [],
            needsMarketClarification: false,
          }),
        } as unknown as CommercialAuthorityService,
        {
          consumeAiQuota: jest.fn().mockResolvedValue(true),
          inspectGeneratedResponse: jest
            .fn()
            .mockReturnValue({ action: 'ALLOW' }),
        } as unknown as ConversationGuardService,
        { add: jest.fn() } as unknown as Queue<AutoReplyJobData>,
        deliveries as unknown as AutomatedDeliveryService,
        f.turns,
      );
      await expect(
        reply.process({
          conversationId: f.conversation.id,
          contactId: f.contact.id,
          inboundMessageId: f.source.id,
          inboundTurnId: f.turn.id,
        }),
      ).rejects.toThrow('simulated crash');
      await reply.process({
        conversationId: f.conversation.id,
        contactId: f.contact.id,
        inboundMessageId: f.source.id,
        inboundTurnId: f.turn.id,
      });
      expect(engine.respond).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(reachedProvider ? 1 : 0);
      expect(deliveries.prepareBatch).toHaveBeenCalledTimes(
        _label === 'after provider before batch' ? 1 : 0,
      );
      expect(
        (
          await prisma.inboundTurn.findUniqueOrThrow({
            where: { id: f.turn.id },
          })
        ).status,
      ).toBe(InboundTurnStatus.BLOCKED);
    },
  );
});

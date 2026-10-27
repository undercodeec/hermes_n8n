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
import { HermesService } from '../src/hermes/hermes.service';
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
if (!/127\.0\.0\.1:(?:55432|55888)\/hermes_learning_test/.test(databaseUrl))
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
          NOUS_HERMES_MAX_ATTEMPTS: '3',
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
      configFor(enabled ? f.conversation.id : '', enabled),
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

  it('reserves one normal Nous dispatch per inbound across workers and later turns', async () => {
    const first = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(first.conversation.id, false),
    );
    const claim = await normal.claim(first.turn.id);
    const dispatch = {
      turnId: first.turn.id,
      conversationId: first.conversation.id,
      sourceMessageId: first.source.id,
      generationToken: claim!.processingToken!,
      normal: true,
    };
    expect(
      (
        await Promise.all([
          normal.reserveNousDispatch(dispatch),
          normal.reserveNousDispatch(dispatch),
        ])
      ).sort(),
    ).toEqual([false, true]);
    await normal.release(first.turn.id, claim!.processingToken!);
    expect(
      (
        await prisma.inboundTurn.findUniqueOrThrow({
          where: { id: first.turn.id },
        })
      ).status,
    ).toBe(InboundTurnStatus.BLOCKED);
    expect(await normal.reserveNousDispatch(dispatch)).toBe(false);

    const second = await prisma.message.create({
      data: {
        conversationId: first.conversation.id,
        contactId: first.contact.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        content: 'Otro mensaje',
        wamid: `wamid.${randomUUID()}`,
      },
    });
    const next = await prisma.inboundTurn.create({
      data: {
        conversationId: first.conversation.id,
        contactId: first.contact.id,
        firstAt: new Date(Date.now() - 2000),
        lastAt: new Date(Date.now() - 2000),
        dueAt: new Date(Date.now() - 1000),
        lastMessageId: second.id,
      },
    });
    const nextClaim = await normal.claim(next.id);
    expect(
      await normal.reserveNousDispatch({
        turnId: next.id,
        conversationId: first.conversation.id,
        sourceMessageId: second.id,
        generationToken: nextClaim!.processingToken!,
        normal: true,
      }),
    ).toBe(true);
  });

  it('keeps the monitor-only dispatch claim unique in PostgreSQL', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    const dispatch = {
      turnId: f.turn.id,
      conversationId: f.conversation.id,
      sourceMessageId: f.source.id,
      generationToken: claim!.processingToken!,
      normal: true,
      pilotBudget: { mode: 'MONITOR_ONLY' as const },
    };
    expect(
      (
        await Promise.all([
          normal.reserveNousDispatch(dispatch),
          normal.reserveNousDispatch(dispatch),
        ])
      ).sort(),
    ).toEqual([false, true]);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .providerDispatchReservedAt,
    ).not.toBeNull();
  });

  it('recovers one original Nous result after a detached wait and a stale lease', async () => {
    const f = await fixture();
    const turns = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await turns.claim(f.turn.id);
    const token = claim!.processingToken!;
    expect(
      await turns.markNousQueued({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
      }),
    ).toBe(true);
    await prisma.inboundTurn.update({
      where: { id: f.turn.id },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    expect(await turns.claim(f.turn.id)).toBeNull();
    expect(
      (await turns.recoverable()).some((turn) => turn.id === f.turn.id),
    ).toBe(false);
    expect(
      (await turns.stalePendingNous()).some((turn) => turn.id === f.turn.id),
    ).toBe(true);
    expect(
      await turns.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: token,
        normal: true,
        pilotBudget: { mode: 'MONITOR_ONLY' },
      }),
    ).toBe(true);
    const result: ConversationTurnResult = {
      replyText: 'Respuesta sintética original.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'synthetic',
      traceId: f.source.id,
    };
    const [detached, stored] = await Promise.all([
      turns.detachNousWait(f.turn.id, token),
      turns.storeNousResult({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
        result,
      }),
    ]);
    expect(detached).toBe(true);
    expect(stored).toBe(true);
    expect(await turns.readNousResult(f.turn.id, f.source.id)).toEqual(result);
    const resumed = await turns.claim(f.turn.id);
    expect(resumed?.status).toBe(InboundTurnStatus.PROCESSING);
    expect(resumed?.generationToken).toBe(token);
    expect(
      await turns.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: resumed!.processingToken!,
        normal: true,
        pilotBudget: { mode: 'MONITOR_ONLY' },
      }),
    ).toBe(false);
    await turns.complete(f.turn.id, resumed!.processingToken!);
    expect(await turns.readNousResult(f.turn.id, f.source.id)).toBeNull();
  });

  it('leaves a long worker outage pending and resumes its original result on recovery scan', async () => {
    const f = await fixture();
    const turns = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await turns.claim(f.turn.id);
    const token = claim!.processingToken!;
    expect(
      await turns.markNousQueued({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
      }),
    ).toBe(true);
    expect(await turns.detachNousWait(f.turn.id, token)).toBe(true);
    await prisma.inboundTurn.update({
      where: { id: f.turn.id },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const recovery = new InboundTurnRecoveryService(
      turns,
      { add: queueAdd } as unknown as Queue<AutoReplyJobData>,
      undefined,
      undefined,
      {
        getJob: jest.fn().mockResolvedValue({
          getState: jest.fn().mockResolvedValue('waiting'),
        }),
      } as unknown as Queue<ConversationTurnInput>,
    );
    await recovery.scan();
    expect(queueAdd).not.toHaveBeenCalled();
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.PROCESSING);
    expect(
      await turns.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: token,
        normal: true,
        pilotBudget: { mode: 'MONITOR_ONLY' },
      }),
    ).toBe(true);
    expect(
      await turns.storeNousResult({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
        result: {
          replyText: 'Respuesta después del reinicio.',
          proposedActions: [{ type: 'none' }],
          engine: 'nous_hermes',
          providerModel: 'synthetic',
          traceId: f.source.id,
        },
      }),
    ).toBe(true);
    await recovery.scan();
    expect(queueAdd).toHaveBeenCalledWith(
      'send-auto-reply',
      expect.objectContaining({ inboundTurnId: f.turn.id }),
      expect.any(Object),
    );
    const resumed = await turns.claim(f.turn.id);
    expect(resumed).not.toBeNull();
    await turns.complete(f.turn.id, resumed!.processingToken!);
  });

  it('sends a recovered Nous result once through the PostgreSQL delivery ledger', async () => {
    const f = await fixture();
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
          NOUS_PILOT_OPERATIONS_ENABLED: 'true',
          NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
          HERMES_CONVERSATION_MESSAGE_DELAY_MS: 0,
          AI_MESSAGE_PART_DELAY_MS: 0,
        })[key as 'NOUS_PILOT_BUDGET_MODE'] ?? fallback,
    } as ConfigService;
    const turns = new InboundTurnService(prisma, config);
    const claim = await turns.claim(f.turn.id);
    const token = claim!.processingToken!;
    expect(
      await turns.markNousQueued({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
      }),
    ).toBe(true);
    expect(
      await turns.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: token,
        normal: true,
        pilotBudget: { mode: 'MONITOR_ONLY' },
      }),
    ).toBe(true);
    expect(await turns.detachNousWait(f.turn.id, token)).toBe(true);
    expect(
      await turns.storeNousResult({
        turnId: f.turn.id,
        sourceMessageId: f.source.id,
        processingToken: token,
        result: {
          replyText: 'Respuesta recuperada.',
          proposedActions: [{ type: 'none' }],
          engine: 'nous_hermes',
          providerModel: 'synthetic',
          traceId: f.source.id,
        },
      }),
    ).toBe(true);
    const sendTextMessage = jest
      .fn()
      .mockResolvedValue({ messages: [{ id: `wamid.${randomUUID()}` }] });
    const meta = {
      sendTextMessage,
      showTypingIndicator: jest.fn().mockResolvedValue(undefined),
    } as unknown as MetaService;
    const provider = jest.fn();
    const delivery = new AutomatedDeliveryService(prisma, meta, config);
    const reply = new AutoReplyService(
      config,
      prisma,
      meta,
      {
        selectedEngine: () => 'nous_hermes',
        respond: provider,
      } as unknown as ConversationEngineService,
      { create: jest.fn() } as unknown as HandoffService,
      {
        recordCommercialProfileFromConversation: jest
          .fn()
          .mockResolvedValue({}),
        qualifyFromConversation: jest.fn().mockResolvedValue({}),
      } as unknown as LeadsService,
      {
        requestHermesReview: jest.fn(),
        requestQuote: jest.fn(),
        requestCallback: jest.fn(),
      } as unknown as TasksService,
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
        consumeAiQuota: jest.fn(),
        inspectGeneratedResponse: () => ({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue<AutoReplyJobData>,
      delivery,
      turns,
    );
    const data = {
      conversationId: f.conversation.id,
      contactId: f.contact.id,
      inboundMessageId: f.source.id,
      inboundTurnId: f.turn.id,
    };
    await reply.process(data);
    await reply.process(data); // duplicate completion event
    expect(provider).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: f.source.id, status: 'CONFIRMED' },
      }),
    ).toBe(1);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.PROCESSED);
  });

  it('releases a normal turn after a proven pre-HTTP configuration failure', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    const endpoint = jest.spyOn(axios, 'post');
    try {
      const transport = new NousHermesTransport(
        configFor(f.conversation.id, false),
        new AgentOutputValidator(),
        { read: jest.fn().mockRejectedValue(new Error('missing file')) },
        normal,
        prisma,
      );
      const result = await transport.execute({
        conversationId: f.conversation.id,
        inboundMessageId: f.source.id,
        customerMessage: 'Consulta sintética',
        normalNousClaim: {
          turnId: f.turn.id,
          processingToken: claim!.processingToken!,
        },
        approvedContext: {
          recentMessages: [],
          approvedKnowledge: [],
          handoffActive: false,
          contactName: 'Cliente',
        },
      });
      expect(result.diagnostic?.code).toBe('NOUS_HERMES_CONFIGURATION_INVALID');
      expect(endpoint).not.toHaveBeenCalled();
      await normal.release(f.turn.id, claim!.processingToken!);
      expect(
        (
          await prisma.inboundTurn.findUniqueOrThrow({
            where: { id: f.turn.id },
          })
        ).status,
      ).toBe(InboundTurnStatus.OPEN);
      expect(await normal.claim(f.turn.id)).not.toBeNull();
    } finally {
      endpoint.mockRestore();
    }
  });

  it('blocks a normal timeout after one HTTP dispatch and denies restart replay', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    const endpoint = jest
      .spyOn(axios, 'post')
      .mockRejectedValue({ code: 'ECONNABORTED' });
    const input: ConversationTurnInput = {
      conversationId: f.conversation.id,
      inboundMessageId: f.source.id,
      customerMessage: 'Consulta sintética',
      normalNousClaim: {
        turnId: f.turn.id,
        processingToken: claim!.processingToken!,
      },
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Cliente',
      },
    };
    try {
      const transport = new NousHermesTransport(
        configFor(f.conversation.id, false),
        new AgentOutputValidator(),
        { read: jest.fn().mockResolvedValue('synthetic-secret') },
        normal,
        prisma,
      );
      expect((await transport.execute(input)).diagnostic?.code).toBe(
        'NOUS_HERMES_TIMEOUT',
      );
      await normal.release(f.turn.id, claim!.processingToken!);
      expect(
        (
          await prisma.inboundTurn.findUniqueOrThrow({
            where: { id: f.turn.id },
          })
        ).status,
      ).toBe(InboundTurnStatus.BLOCKED);
      expect(await normal.claim(f.turn.id)).toBeNull();
      await expect(transport.execute(input)).rejects.toThrow(
        'NOUS_DISPATCH_DENIED',
      );
      expect(endpoint).toHaveBeenCalledTimes(1);
    } finally {
      endpoint.mockRestore();
    }
  });

  it('lets only one of two normal workers reach HTTP for the same inbound', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    const endpoint = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"replyText":"Respuesta sintética."}' },
          },
        ],
      },
    });
    try {
      const transport = new NousHermesTransport(
        configFor(f.conversation.id, false),
        new AgentOutputValidator(),
        { read: jest.fn().mockResolvedValue('synthetic-secret') },
        normal,
        prisma,
      );
      const input: ConversationTurnInput = {
        conversationId: f.conversation.id,
        inboundMessageId: f.source.id,
        customerMessage: 'Consulta sintética',
        normalNousClaim: {
          turnId: f.turn.id,
          processingToken: claim!.processingToken!,
        },
        approvedContext: {
          recentMessages: [],
          approvedKnowledge: [],
          handoffActive: false,
          contactName: 'Cliente',
        },
      };
      const results = await Promise.allSettled([
        transport.execute(input),
        transport.execute(input),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(endpoint).toHaveBeenCalledTimes(1);
    } finally {
      endpoint.mockRestore();
    }
  });

  it('revokes a queued normal job before HTTP when its outcome is unknown', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    expect(
      await normal.blockAmbiguous(f.turn.id, claim!.processingToken!, true),
    ).toBe(true);
    expect(
      await normal.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: claim!.processingToken!,
        normal: true,
      }),
    ).toBe(false);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .generationBlockReason,
    ).toBe('NOUS_QUEUE_OUTCOME_UNKNOWN');
  });

  it('creates one durable human review after recovery blocks an uncertain Nous turn', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    expect(
      await normal.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: claim!.processingToken!,
        normal: true,
      }),
    ).toBe(true);
    await prisma.inboundTurn.update({
      where: { id: f.turn.id },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    const queueAdd = jest.fn();
    const requestHermesReview = jest
      .fn()
      .mockResolvedValue({ id: 'synthetic-review' });
    const handoff = jest.fn().mockResolvedValue({ id: 'synthetic-handoff' });
    const recovery = new InboundTurnRecoveryService(
      normal,
      { add: queueAdd } as unknown as Queue<AutoReplyJobData>,
      { requestHermesReview } as unknown as TasksService,
      { create: handoff } as unknown as HandoffService,
    );
    await recovery.scan();
    expect(queueAdd).not.toHaveBeenCalled();
    expect(requestHermesReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: f.source.id,
        code: 'NOUS_DISPATCH_AMBIGUOUS',
      }),
    );
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: f.conversation.id,
        reason: 'INFO_ERROR',
      }),
    );
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .generationBlockReason,
    ).toBe('NOUS_DISPATCH_AMBIGUOUS_REVIEWED');
    await recovery.scan();
    const reviewCalls = requestHermesReview.mock.calls as Array<
      [{ sourceMessageId: string }]
    >;
    expect(
      reviewCalls.filter(([params]) => params.sourceMessageId === f.source.id),
    ).toHaveLength(1);
  });

  it('recovers a persisted normal reply batch without another Nous dispatch', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    expect(
      await normal.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: claim!.processingToken!,
        normal: true,
      }),
    ).toBe(true);
    const deliveries = new AutomatedDeliveryService(prisma, {} as MetaService);
    await deliveries.prepareBatch(
      {
        deliveryKind: 'HERMES_REPLY',
        conversationId: f.conversation.id,
        contactId: f.contact.id,
        sourceMessageId: f.source.id,
        sender: 'HERMES',
        allowHandedOff: false,
        parts: [{ partIndex: 0, content: 'Respuesta válida persistida' }],
      },
      {
        turnId: f.turn.id,
        processingToken: claim!.processingToken!,
        generationToken: claim!.processingToken!,
      },
    );
    await normal.release(f.turn.id, claim!.processingToken!);
    const recovered = {
      recoverBatch: jest
        .fn()
        .mockResolvedValue({ handled: true, confirmed: 1, terminal: true }),
      getBatchProgress: jest.fn().mockResolvedValue(undefined),
    };
    const { service, engine } = replayService(f, recovered, false);
    await service.process(jobFor(f));
    expect(recovered.recoverBatch).toHaveBeenCalledWith(f.source.id, false);
    expect(engine.respond).not.toHaveBeenCalled();
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .status,
    ).toBe(InboundTurnStatus.PROCESSED);
  });

  it('does not persist a late normal reply after its generation claim is blocked', async () => {
    const f = await fixture();
    const normal = new InboundTurnService(
      prisma,
      configFor(f.conversation.id, false),
    );
    const claim = await normal.claim(f.turn.id);
    expect(
      await normal.reserveNousDispatch({
        turnId: f.turn.id,
        conversationId: f.conversation.id,
        sourceMessageId: f.source.id,
        generationToken: claim!.processingToken!,
        normal: true,
      }),
    ).toBe(true);
    expect(
      await normal.blockAmbiguous(f.turn.id, claim!.processingToken!),
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
          processingToken: claim!.processingToken!,
          generationToken: claim!.processingToken!,
        },
      ),
    ).rejects.toThrow('CANARY_GENERATION_CLAIM_LOST');
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: f.source.id },
      }),
    ).toBe(0);
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

  it('reserves one Gemini HTTP dispatch durably across concurrent calls and neutralization', async () => {
    const f = await fixture();
    const claim = await reserve(f);
    const armed = new HermesService(configFor(f.conversation.id), prisma);
    const post = jest.fn().mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({ response: 'Respuesta sintética.' }),
            },
          },
        ],
      },
    });
    (
      armed as unknown as { httpClient: { post: typeof post } }
    ).httpClient.post = post;
    const request = {
      conversationId: f.conversation.id,
      correlationId: f.source.id,
      contactName: 'Prueba',
      messageContent: 'Consulta sintética',
      conversationHistory: [],
      singleGenerationCanary: {
        turnId: f.turn.id,
        processingToken: claim.processingToken!,
        generationToken: claim.processingToken!,
      },
    };
    const outcomes = await Promise.allSettled([
      armed.generateResponse(request),
      armed.generateResponse(request),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: f.turn.id } }))
        .providerDispatchReservedAt,
    ).not.toBeNull();

    const neutral = new HermesService(
      configFor(f.conversation.id, false),
      prisma,
    );
    const latePost = jest.fn();
    (
      neutral as unknown as { httpClient: { post: typeof latePost } }
    ).httpClient.post = latePost;
    await expect(
      neutral.generateResponse({
        ...request,
        singleGenerationCanary: undefined,
      }),
    ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
    expect(latePost).not.toHaveBeenCalled();
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
    const off = new InboundTurnService(prisma, configFor('', false));
    expect(await off.claim(f.turn.id)).toBeNull();
    expect(blocked.generationSourceMessageId).toBe(f.source.id);
  });

  it('keeps the F3 Nous block reason separate from normal Nous review', async () => {
    const f = await fixture();
    const claim = await reserve(f, 'nous_hermes');
    await f.turns.release(f.turn.id, claim.processingToken!);
    const blocked = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: f.turn.id },
    });
    expect(blocked.generationBlockReason).toBe(
      'CANARY_BLOCKED_AMBIGUOUS_GENERATION',
    );
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
    expect(recovered.recoverBatch).toHaveBeenCalledWith(f.source.id, false);
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

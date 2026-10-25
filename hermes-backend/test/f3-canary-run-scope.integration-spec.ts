import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { InboundTurnStatus } from '@prisma/client';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import { AutoReplyService } from '../src/auto-replies/auto-reply.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { CommercialPolicyService } from '../src/hermes/commercial-policy.service';
import { HermesService } from '../src/hermes/hermes.service';
import { appendNativeDiagnostic } from '../src/hermes/f3-native-diagnostics';
import { PrismaService } from '../src/prisma/prisma.service';

const isolatedUrl = process.env.DATABASE_INTEGRATION_URL;
if (!isolatedUrl?.includes('127.0.0.1:55888/hermes_a6_d1_temp'))
  throw new Error('Refusing non-isolated database');

describe('F3 Gemini run scope on isolated PostgreSQL', () => {
  let prisma: PrismaService;
  const contacts: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = isolatedUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.automatedDelivery.deleteMany({
      where: { contactId: { in: contacts } },
    });
    await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    await prisma.$disconnect();
  });

  async function fixture() {
    const contact = await prisma.contact.create({
      data: { waId: `a6d1-${randomUUID()}` },
    });
    contacts.push(contact.id);
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const values: Record<string, string> = {
      F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
      F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: conversation.id,
      F3_GEMINI_CAPS_ENABLED: 'true',
      F3_CANARY_RUN_GUARD_ENABLED: 'true',
      F3_CANARY_RUN_ID: randomUUID(),
      F3_CANARY_RUN_START_UTC: new Date(Date.now() - 5000).toISOString(),
      F3_CANARY_RUN_DEADLINE_UTC: new Date(Date.now() + 60000).toISOString(),
    };
    const config = {
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
    } as ConfigService;
    const turns = new InboundTurnService(prisma, config);
    async function newTurn() {
      const source = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          contactId: contact.id,
          direction: 'INBOUND',
          sender: 'CONTACT',
          content: 'Consulta sintética',
          wamid: `wamid.${randomUUID()}`,
          rawPayload: { timestamp: String(Math.floor(Date.now() / 1000)) },
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
      const claim = await turns.claim(turn.id);
      expect(claim).not.toBeNull();
      return { source, turn, claim: claim! };
    }
    const reserve = (item: Awaited<ReturnType<typeof newTurn>>) =>
      turns.reserveGeneration({
        turnId: item.turn.id,
        processingToken: item.claim.processingToken!,
        sourceMessageId: item.source.id,
        conversationId: conversation.id,
        engine: 'gemini_direct',
      });
    const dispatch = (item: Awaited<ReturnType<typeof newTurn>>) =>
      turns.reserveCanaryRunDispatch({
        turnId: item.turn.id,
        generationToken: item.claim.processingToken!,
        sourceMessageId: item.source.id,
        conversationId: conversation.id,
      });
    return { contact, conversation, values, turns, newTurn, reserve, dispatch };
  }

  it('admits a fresh run after a terminal historical reservation without delivery', async () => {
    const f = await fixture();
    const old = await f.newTurn();
    await prisma.message.update({
      where: { id: old.source.id },
      data: {
        createdAt: new Date('2026-01-01T00:00:00Z'),
        rawPayload: { timestamp: '1767225600' },
      },
    });
    await prisma.inboundTurn.update({
      where: { id: old.turn.id },
      data: {
        status: InboundTurnStatus.BLOCKED,
        processingToken: null,
        processingAt: null,
        generationSourceMessageId: old.source.id,
        generationReservedAt: new Date(),
        providerDispatchReservedAt: new Date(),
        generationBlockedAt: new Date(),
      },
    });
    const fresh = await f.newTurn();
    expect(await f.reserve(fresh)).toBe(true);
    expect(await f.dispatch(fresh)).toBe(true);
    expect(await f.dispatch(fresh)).toBe(false);
    const persisted = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: fresh.turn.id },
    });
    expect(persisted.canaryRunId).toBe(f.values.F3_CANARY_RUN_ID);
    expect(persisted.providerDispatchReservedAt).not.toBeNull();
  });

  it('permits one logical reservation per run and source, including replay', async () => {
    const f = await fixture();
    const first = await f.newTurn();
    expect(await f.reserve(first)).toBe(true);
    await f.turns.complete(first.turn.id, first.claim.processingToken!);
    const second = await f.newTurn();
    expect(await f.reserve(second)).toBe(false);
    expect(await f.reserve(first)).toBe(false);
    expect(
      await prisma.inboundTurn.count({
        where: { canaryRunId: f.values.F3_CANARY_RUN_ID },
      }),
    ).toBe(1);
  });

  it('allows only one of two concurrent workers to reserve a source', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    const results = await Promise.all([f.reserve(item), f.reserve(item)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('allows at most one of two different inbounds during the same run', async () => {
    const f = await fixture();
    const first = await f.newTurn();
    const second = await f.newTurn();
    const results = await Promise.all([f.reserve(first), f.reserve(second)]);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(
      await prisma.inboundTurn.count({
        where: { canaryRunId: f.values.F3_CANARY_RUN_ID },
      }),
    ).toBeLessThanOrEqual(1);
  });

  it('allows a separately authorized run only after the previous run closes', async () => {
    const f = await fixture();
    const first = await f.newTurn();
    expect(await f.reserve(first)).toBe(true);
    expect(await f.dispatch(first)).toBe(true);
    await f.turns.complete(first.turn.id, first.claim.processingToken!);
    f.values.F3_CANARY_RUN_ID = randomUUID();
    const second = await f.newTurn();
    expect(await f.reserve(second)).toBe(true);
    expect(await f.dispatch(second)).toBe(true);
  });

  it('requires a fresh Meta timestamp as well as a fresh database row', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    await prisma.message.update({
      where: { id: item.source.id },
      data: {
        rawPayload: { timestamp: '1767225600' },
      },
    });
    expect(await f.reserve(item)).toBe(false);
  });

  it.each(['PREPARED', 'DISPATCHING', 'AMBIGUOUS'] as const)(
    'stops a new run while historical delivery is %s',
    async (status) => {
      const f = await fixture();
      const old = await f.newTurn();
      await prisma.inboundTurn.update({
        where: { id: old.turn.id },
        data: {
          status: InboundTurnStatus.BLOCKED,
          processingToken: null,
          processingAt: null,
          generationSourceMessageId: old.source.id,
          generationReservedAt: new Date(),
          providerDispatchReservedAt: new Date(),
          generationBlockedAt: new Date(),
        },
      });
      await prisma.automatedDelivery.create({
        data: {
          operationKey: `${old.source.id}:HERMES_REPLY:0`,
          deliveryKind: 'HERMES_REPLY',
          partIndex: 0,
          conversationId: f.conversation.id,
          contactId: f.contact.id,
          sourceMessageId: old.source.id,
          sender: 'HERMES',
          content: 'fixture',
          status,
        },
      });
      const fresh = await f.newTurn();
      expect(await f.reserve(fresh)).toBe(false);
      expect(await f.dispatch(fresh)).toBe(false);
    },
  );

  it('stops while a historical worker is still processing', async () => {
    const f = await fixture();
    await f.newTurn();
    const fresh = await f.newTurn();
    expect(await f.reserve(fresh)).toBe(false);
  });

  it('keeps a dispatch reservation closed after Prisma reconnect and a lost lease', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    expect(await f.reserve(item)).toBe(true);
    expect(await f.dispatch(item)).toBe(true);
    await prisma.inboundTurn.update({
      where: { id: item.turn.id },
      data: {
        processingAt: new Date(Date.now() - 16 * 60_000),
      },
    });
    const reclaimed = await f.turns.claim(item.turn.id);
    expect(reclaimed?.processingToken).not.toBe(item.claim.processingToken);
    await prisma.$disconnect();
    await prisma.$connect();
    expect(await f.dispatch(item)).toBe(false);
    expect(await f.reserve(item)).toBe(false);
  });

  it('blocks a restarted worker after a crash between logical reservation and HTTP', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    expect(await f.reserve(item)).toBe(true);
    await prisma.$disconnect();
    await prisma.$connect();
    await prisma.inboundTurn.update({
      where: { id: item.turn.id },
      data: {
        processingAt: new Date(Date.now() - 16 * 60_000),
      },
    });
    const newClaim = await f.turns.claim(item.turn.id);
    expect(newClaim?.processingToken).not.toBe(item.claim.processingToken);
    expect(await f.dispatch(item)).toBe(false);
    expect(
      await f.turns.reserveCanaryRunDispatch({
        turnId: item.turn.id,
        generationToken: newClaim!.processingToken!,
        sourceMessageId: item.source.id,
        conversationId: f.conversation.id,
      }),
    ).toBe(false);
  });

  it('preserves legacy reservation behavior when the new flag is off', async () => {
    const f = await fixture();
    f.values.F3_CANARY_RUN_GUARD_ENABLED = 'false';
    const item = await f.newTurn();
    expect(await f.reserve(item)).toBe(true);
    const persisted = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: item.turn.id },
    });
    expect(persisted.canaryRunId).toBeNull();
  });

  it('rejects an expired deadline and a distinct configured run at dispatch', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    expect(await f.reserve(item)).toBe(true);
    f.values.F3_CANARY_RUN_ID = randomUUID();
    expect(await f.dispatch(item)).toBe(false);
    f.values.F3_CANARY_RUN_DEADLINE_UTC = new Date(
      Date.now() - 1000,
    ).toISOString();
    await expect(f.dispatch(item)).rejects.toThrow(
      'CANARY_RUN_CONFIGURATION_INVALID',
    );
    expect(
      (
        await prisma.inboundTurn.findUniqueOrThrow({
          where: { id: item.turn.id },
        })
      ).providerDispatchReservedAt,
    ).toBeNull();
  });

  it('rejects an expired deadline before the first logical reservation', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    f.values.F3_CANARY_RUN_DEADLINE_UTC = new Date(
      Date.now() - 1000,
    ).toISOString();
    await expect(f.reserve(item)).rejects.toThrow(
      'CANARY_RUN_CONFIGURATION_INVALID',
    );
    const persisted = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: item.turn.id },
    });
    expect(persisted.generationReservedAt).toBeNull();
    expect(persisted.canaryRunId).toBeNull();
  });

  it('persists only allowlisted learning identities and stages after restart', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    const learningId = randomUUID();
    await appendNativeDiagnostic(prisma, item.source.id, {
      stage: 'SELECTED_FOR_CONTEXT',
      consideredCount: 1,
      selectedCount: 1,
      learningItems: [{ id: learningId, version: 2 }],
      selectionFailed: false,
      retrievalEnabled: true,
    });
    await appendNativeDiagnostic(prisma, item.source.id, {
      stage: 'INCLUDED_IN_COUNT_PAYLOAD',
    });
    await appendNativeDiagnostic(prisma, item.source.id, {
      stage: 'COUNT_HTTP_ATTEMPTED',
      exposureStatus: 'UNKNOWN',
    });
    await prisma.$disconnect();
    await prisma.$connect();
    const persisted = await prisma.message.findUniqueOrThrow({
      where: { id: item.source.id },
    });
    const metadata = persisted.metadata as Record<string, unknown>;
    const events = metadata.f3NativeDiagnostics as Array<
      Record<string, unknown>
    >;
    expect(events.map((event) => event.stage)).toEqual([
      'SELECTED_FOR_CONTEXT',
      'INCLUDED_IN_COUNT_PAYLOAD',
      'COUNT_HTTP_ATTEMPTED',
    ]);
    expect(events[0].learningItems).toEqual([{ id: learningId, version: 2 }]);
    expect(JSON.stringify(events)).not.toContain('Consulta sintética');
    expect(
      events.some((event) => event.stage === 'INCLUDED_IN_GENERATE_PAYLOAD'),
    ).toBe(false);
  });

  it('bounds native diagnostic retention and fails closed at the 33rd event', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    await appendNativeDiagnostic(prisma, item.source.id, {
      stage: 'SELECTED_FOR_CONTEXT',
      consideredCount: 0,
      selectedCount: 0,
      learningItems: [],
      selectionFailed: false,
      retrievalEnabled: false,
    });
    for (let index = 0; index < 31; index++) {
      await appendNativeDiagnostic(prisma, item.source.id, {
        stage: 'COUNT_COMPLETED',
      });
    }
    await expect(
      appendNativeDiagnostic(prisma, item.source.id, {
        stage: 'INCLUDED_IN_GENERATE_PAYLOAD',
      }),
    ).rejects.toThrow('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: item.source.id },
    });
    const events = (row.metadata as Record<string, unknown>)
      .f3NativeDiagnostics as unknown[];
    expect(events).toHaveLength(32);
  });

  it('keeps historical diagnostic appends unchanged without a run trace', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    for (let index = 0; index < 33; index++) {
      await appendNativeDiagnostic(prisma, item.source.id, {
        stage: 'COUNT_COMPLETED',
      });
    }
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: item.source.id },
    });
    const events = (row.metadata as Record<string, unknown>)
      .f3NativeDiagnostics as unknown[];
    expect(events).toHaveLength(33);
  });

  it('records count and generate exposure around exactly one mocked HTTP dispatch', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    const learningId = randomUUID();
    const secret = 'FORBIDDEN_PROMPT_GUIDANCE_HEADER';
    expect(await f.reserve(item)).toBe(true);
    await appendNativeDiagnostic(prisma, item.source.id, {
      stage: 'SELECTED_FOR_CONTEXT',
      consideredCount: 1,
      selectedCount: 1,
      learningItems: [{ id: learningId, version: 1 }],
      selectionFailed: false,
      retrievalEnabled: true,
    });
    const model = 'gemini-3-synthetic';
    f.values.HERMES_MODEL = model;
    f.values.F3_GEMINI_API_KEY = 'synthetic-test-only';
    f.values.F3_GEMINI_BUDGET_JSON = JSON.stringify({
      model,
      targetConversationId: f.conversation.id,
      validUntil: new Date(Date.now() + 45000).toISOString(),
      serviceWindowExpiresAt: new Date(Date.now() + 45000).toISOString(),
      channel: 'CLOUD_API',
      category: 'SERVICE',
      sourceUrl: 'https://example.test/synthetic',
      auditedAt: new Date().toISOString(),
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      countCallUsdMax: 0.001,
      metaUsdPerPartMax: 0.01,
      bspUsdPerPartMax: 0.01,
      marginUsd: 0.1,
      maxParts: 9,
    });
    const config = {
      get: (key: string, fallback?: unknown) => f.values[key] ?? fallback,
    } as ConfigService;
    const hermes = new HermesService(config, prisma);
    const post = jest.fn((url: string) =>
      Promise.resolve(
        url.endsWith(':countTokens')
          ? { data: { totalTokens: 10 } }
          : {
              status: 200,
              data: {
                modelVersion: model,
                candidates: [
                  {
                    content: { parts: [{ text: '{"response":"Hola."}' }] },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 2,
                  thoughtsTokenCount: 0,
                },
              },
            },
      ),
    );
    (hermes as unknown as { nativeClient: { post: jest.Mock } }).nativeClient =
      { post };
    const legacy = jest.fn(() => {
      throw new Error('legacy fallback reached');
    });
    (hermes as unknown as { httpClient: { post: jest.Mock } }).httpClient.post =
      legacy;
    const request = {
      conversationId: f.conversation.id,
      correlationId: item.source.id,
      contactName: 'Cliente sintético',
      messageContent: secret,
      conversationHistory: [],
      canaryServiceWindowExpiresAt: new Date(Date.now() + 60000).toISOString(),
      canaryReceivedAt: new Date().toISOString(),
      singleGenerationCanary: {
        turnId: item.turn.id,
        processingToken: item.claim.processingToken!,
        generationToken: item.claim.processingToken!,
      },
      approvedLearning: [
        {
          id: learningId,
          version: 1,
          kind: 'STYLE',
          trigger: 'fixture',
          guidance: secret,
        },
      ],
    };
    const first = await hermes.generateResponse(request);
    expect(first.response).toBe('Hola.');
    expect(
      post.mock.calls.filter(([url]) => url.endsWith(':generateContent')),
    ).toHaveLength(1);
    expect(legacy).not.toHaveBeenCalled();
    await prisma.$disconnect();
    await prisma.$connect();
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: item.source.id },
    });
    const events = (row.metadata as Record<string, unknown>)
      .f3NativeDiagnostics as Array<Record<string, unknown>>;
    const stages = events.map((event) => event.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        'SELECTED_FOR_CONTEXT',
        'INCLUDED_IN_COUNT_PAYLOAD',
        'COUNT_HTTP_ATTEMPTED',
        'COUNT_HTTP_RESPONSE_OBSERVED',
        'COUNT_COMPLETED',
        'DISPATCH_RESERVED',
        'INCLUDED_IN_GENERATE_PAYLOAD',
        'GENERATE_HTTP_ATTEMPTED',
        'GENERATE_HTTP_RESPONSE_OBSERVED',
      ]),
    );
    expect(
      events.find((event) => event.stage === 'GENERATE_HTTP_RESPONSE_OBSERVED')
        ?.exposureStatus,
    ).toBe('CONFIRMED');
    expect(JSON.stringify(events)).not.toContain(secret);
    await expect(hermes.generateResponse(request)).rejects.toThrow(
      'CANARY_GEMINI_DISPATCH_DENIED',
    );
    expect(
      post.mock.calls.filter(([url]) => url.endsWith(':generateContent')),
    ).toHaveLength(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('suppresses a canary notice before Meta and does not fall back', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    const meta = { sendTextMessage: jest.fn(), sendVoiceNote: jest.fn() };
    const config = {
      get: (key: string, fallback?: unknown) => f.values[key] ?? fallback,
    } as ConfigService;
    const deliveries = new AutomatedDeliveryService(
      prisma,
      meta as never,
      config,
    );
    await deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId: f.conversation.id,
      contactId: f.contact.id,
      sourceMessageId: item.source.id,
      sender: 'SYSTEM',
      allowHandedOff: false,
      parts: [{ partIndex: 0, content: 'Aviso sintético' }],
    });
    await deliveries.deliverPreparedBatch(item.source.id);
    const row = await prisma.automatedDelivery.findFirstOrThrow({
      where: { sourceMessageId: item.source.id },
    });
    expect(row.status).toBe('SUPPRESSED');
    expect(row.reasonCode).toBe('CANARY_RUN_SYSTEM_NOTICE_SUPPRESSED');
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(meta.sendVoiceNote).not.toHaveBeenCalled();
  });

  it('suppresses a same-source PREPARED replay without delivery or inference', async () => {
    const f = await fixture();
    const item = await f.newTurn();
    await prisma.automatedDelivery.create({
      data: {
        operationKey: `${item.source.id}:HERMES_REPLY:0`,
        deliveryKind: 'HERMES_REPLY',
        partIndex: 0,
        conversationId: f.conversation.id,
        contactId: f.contact.id,
        sourceMessageId: item.source.id,
        sender: 'HERMES',
        content: 'fixture',
        status: 'PREPARED',
      },
    });
    const deliveryMocks = {
      recoverBatch: jest.fn(),
      deliverPreparedBatch: jest.fn(),
    };
    const engine = {
      selectedEngine: jest.fn().mockReturnValue('gemini_direct'),
      respond: jest.fn(),
    };
    const config = {
      get: (key: string, fallback?: unknown) => f.values[key] ?? fallback,
    } as ConfigService;
    const service = new AutoReplyService(
      config,
      prisma,
      {} as never,
      engine as never,
      {} as never,
      {} as never,
      {} as never,
      new CommercialPolicyService(),
      {} as never,
      {} as never,
      {} as never,
      deliveryMocks as never,
      f.turns,
    );
    await (
      service as unknown as {
        processTurn: (
          data: unknown,
          messages: undefined,
          claim: typeof item.claim,
        ) => Promise<void>;
      }
    ).processTurn(
      {
        conversationId: f.conversation.id,
        contactId: f.contact.id,
        inboundMessageId: item.source.id,
        inboundTurnId: item.turn.id,
      },
      undefined,
      item.claim,
    );
    const row = await prisma.automatedDelivery.findFirstOrThrow({
      where: { sourceMessageId: item.source.id },
    });
    expect(row.status).toBe('SUPPRESSED');
    expect(deliveryMocks.recoverBatch).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverPreparedBatch).not.toHaveBeenCalled();
    expect(engine.respond).not.toHaveBeenCalled();
  });
});

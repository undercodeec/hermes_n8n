import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageSender } from '@prisma/client';
import { appendNativeDiagnostic } from '../src/hermes/f3-native-diagnostics';
import { HermesService } from '../src/hermes/hermes.service';
import { PrismaService } from '../src/prisma/prisma.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
if (!databaseUrl) throw new Error('DATABASE_INTEGRATION_URL is required');
const target = new URL(databaseUrl);
if (
  target.protocol !== 'postgresql:' ||
  target.hostname !== '127.0.0.1' ||
  target.port !== '55439' ||
  target.pathname !== '/hermes_a3_temp' ||
  target.username !== 'a3_gate'
)
  throw new Error('Refusing a database outside the isolated A3 container');

const sentinel = 'A3_FORBIDDEN_SECRET_PROMPT_HEADER_BODY';

describe('F3 native diagnostics on isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let contactId: string;
  let conversationId: string;
  let inboundId: string;
  let outboundId: string;
  let nullMetadataId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const identity = await prisma.$queryRaw<
      Array<{ database: string; username: string }>
    >`SELECT current_database() AS database, current_user AS username`;
    expect(identity).toEqual([
      { database: 'hermes_a3_temp', username: 'a3_gate' },
    ]);
    const contact = await prisma.contact.create({
      data: { waId: `a3-synthetic-${randomUUID()}` },
    });
    contactId = contact.id;
    const conversation = await prisma.conversation.create({
      data: { contactId },
    });
    conversationId = conversation.id;
    const inbound = await prisma.message.create({
      data: {
        contactId,
        conversationId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        metadata: { existingSyntheticField: 'preserved' },
      },
    });
    inboundId = inbound.id;
    const outbound = await prisma.message.create({
      data: {
        contactId,
        conversationId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        metadata: { existingSyntheticField: 'outbound-untouched' },
      },
    });
    outboundId = outbound.id;
    const nullMetadata = await prisma.message.create({
      data: {
        contactId,
        conversationId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
      },
    });
    nullMetadataId = nullMetadata.id;
  });

  afterAll(async () => {
    if (prisma) {
      if (contactId) await prisma.contact.delete({ where: { id: contactId } });
      await prisma.$disconnect();
    }
  });

  async function metadata(messageId: string): Promise<Record<string, unknown>> {
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { metadata: true },
    });
    return row.metadata as Record<string, unknown>;
  }

  it('appends ordered allowlisted events without losing prior metadata', async () => {
    await appendNativeDiagnostic(prisma, inboundId, {
      stage: 'COUNT_COMPLETED',
      countTokenCount: 3648,
      header: sentinel,
      prompt: sentinel,
      body: sentinel,
    } as never);
    await appendNativeDiagnostic(prisma, inboundId, {
      stage: 'HTTP_RESPONSE_OBSERVED',
      httpStatus: 429,
      requestAttemptedLocal: true,
      httpResponseObserved: true,
      providerReceipt: 'UNKNOWN',
      billingReconciled: 'UNKNOWN',
      error: { message: sentinel },
    } as never);
    const stored = await metadata(inboundId);
    const events = stored.f3NativeDiagnostics as Array<Record<string, unknown>>;
    expect(stored.existingSyntheticField).toBe('preserved');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.stage)).toEqual([
      'COUNT_COMPLETED',
      'HTTP_RESPONSE_OBSERVED',
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        sourceMessageId: inboundId,
        httpStatus: 429,
        requestAttemptedLocal: true,
        httpResponseObserved: true,
        providerReceipt: 'UNKNOWN',
        billingReconciled: 'UNKNOWN',
      }),
    );
    expect(JSON.stringify(stored)).not.toContain(sentinel);
  });

  it('rejects missing and non-INBOUND source IDs without changing other rows', async () => {
    await expect(
      appendNativeDiagnostic(prisma, randomUUID(), {
        stage: 'DISPATCH_RESERVED',
      }),
    ).rejects.toThrow('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
    await expect(
      appendNativeDiagnostic(prisma, outboundId, {
        stage: 'DISPATCH_RESERVED',
      }),
    ).rejects.toThrow('F3_DIAGNOSTIC_PERSISTENCE_FAILED');
    expect(await metadata(outboundId)).toEqual({
      existingSyntheticField: 'outbound-untouched',
    });
  });

  it('initializes a missing metadata object and preserves concurrent appends', async () => {
    await appendNativeDiagnostic(prisma, nullMetadataId, {
      stage: 'COUNT_COMPLETED',
      countTokenCount: 1,
    });
    await Promise.all([
      appendNativeDiagnostic(prisma, nullMetadataId, {
        stage: 'COUNT_COMPLETED',
        countTokenCount: 2,
      }),
      appendNativeDiagnostic(prisma, nullMetadataId, {
        stage: 'COUNT_COMPLETED',
        countTokenCount: 3,
      }),
    ]);
    const events = (await metadata(nullMetadataId))
      .f3NativeDiagnostics as Array<Record<string, unknown>>;
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.countTokenCount).sort()).toEqual([
      1, 2, 3,
    ]);
  });

  it('blocks generation when the real database cannot persist before dispatch', async () => {
    const model = 'gemini-3-synthetic';
    const values: Record<string, string> = {
      F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
      F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: conversationId,
      F3_GEMINI_CAPS_ENABLED: 'true',
      F3_GEMINI_BUDGET_JSON: JSON.stringify({
        model,
        targetConversationId: conversationId,
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        serviceWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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
      }),
      F3_GEMINI_API_KEY: 'synthetic-test-only',
      HERMES_MODEL: model,
    };
    const config = {
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
    } as ConfigService;
    const service = new HermesService(config, prisma);
    const nativePost = jest.fn((url: string) => {
      if (url.endsWith(':countTokens'))
        return Promise.resolve({ data: { totalTokens: 100 } });
      throw new Error('Unexpected external generation');
    });
    (service as unknown as { nativeClient: { post: jest.Mock } }).nativeClient =
      {
        post: nativePost,
      };
    const response = await service.generateResponse({
      conversationId,
      canaryServiceWindowExpiresAt: new Date(
        Date.now() + 120_000,
      ).toISOString(),
      canaryReceivedAt: new Date().toISOString(),
      correlationId: randomUUID(),
      singleGenerationCanary: {
        turnId: randomUUID(),
        processingToken: 'synthetic-token',
        generationToken: 'synthetic-token',
      },
      messageContent: 'consulta sintética',
      conversationHistory: [],
    });
    expect(response.diagnostic?.code).toBe('F3_NATIVE_GENERATION_UNAVAILABLE');
    expect(response.f3NativeDiagnostic?.failureClass).toBe(
      'PERSISTENCE_FAILED',
    );
    expect(nativePost).toHaveBeenCalledTimes(1);
    expect(nativePost.mock.calls[0][0]).toContain(':countTokens');
    expect(
      nativePost.mock.calls.some(([url]) => url.endsWith(':generateContent')),
    ).toBe(false);
  });

  it('retains the event sequence after Prisma client disconnect and restart', async () => {
    await prisma.$disconnect();
    prisma = new PrismaService();
    await prisma.$connect();
    const stored = await metadata(inboundId);
    const events = stored.f3NativeDiagnostics as Array<Record<string, unknown>>;
    expect(events.map((event) => event.stage)).toEqual([
      'COUNT_COMPLETED',
      'HTTP_RESPONSE_OBSERVED',
    ]);
    expect(JSON.stringify(stored)).not.toContain(sentinel);
  });
});

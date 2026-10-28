import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageSender, MessageType } from '@prisma/client';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { AgentOutputValidator } from '../src/conversation-engine/agent-output.validator';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from '../src/conversation-engine/conversation-engine.types';
import { NousHermesEngine } from '../src/conversation-engine/nous-hermes.engine';
import { NousHermesProcessor } from '../src/conversation-engine/nous-hermes.processor';
import { NousHermesQueueEvents } from '../src/conversation-engine/nous-hermes.queue-events';
import { NOUS_HERMES_ENDPOINT } from '../src/conversation-engine/nous-hermes.constants';
import { NousHermesTransport } from '../src/conversation-engine/nous-hermes.transport';
import { MetaService } from '../src/meta/meta.service';
import { PrismaService } from '../src/prisma/prisma.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (
  databaseUrl !==
    'postgresql://a7_d16_test:a7_d16_test_only@127.0.0.1:55433/hermes_a7_d16_test?schema=public' ||
  redisUrl !== 'redis://127.0.0.1:56380/0'
)
  throw new Error(
    'A7-D16 E2E requires its exact local synthetic database and Redis',
  );

describe('A7-D16 isolated Nous path (PostgreSQL + BullMQ)', () => {
  const config = {
    get: (key: string, fallback?: unknown) =>
      (
        ({
          NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
          NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
          NOUS_PILOT_OPERATIONS_ENABLED: 'true',
          NOUS_PILOT_DAILY_REQUEST_LIMIT: '1',
          NOUS_PILOT_DAILY_ESTIMATED_USD_LIMIT: '0.01',
          NOUS_PILOT_ESTIMATED_USD_PER_REQUEST: '0.116122',
          NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS: '10000',
        }) as Record<string, string>
      )[key] ?? fallback,
  } as ConfigService;
  const redis = new URL(redisUrl!);
  const connection = {
    host: redis.hostname,
    port: Number(redis.port),
    maxRetriesPerRequest: null,
  };
  const queueName = `a7-d16-nous-${randomUUID()}`;
  const queue = new Queue<ConversationTurnInput, ConversationTurnResult>(
    queueName,
    { connection },
  );
  const events = new QueueEvents(queueName, { connection });
  let worker: Worker<ConversationTurnInput, ConversationTurnResult>;
  let prisma: PrismaService;
  let turns: InboundTurnService;
  const contacts: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    turns = new InboundTurnService(prisma, config);
    await events.waitUntilReady();
    await queue.setGlobalConcurrency(1);
  });

  afterEach(async () => {
    await worker?.close();
    await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    contacts.length = 0;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await events.close();
    await queue.close();
    await prisma.$disconnect();
  });

  it('blocks an external socket before any provider connection', () => {
    expect(() =>
      new Socket().connect({ host: 'example.invalid', port: 443 }),
    ).toThrow('A7_D16_EGRESS_BLOCKED');
  });

  it('persists one Nous result and confirms one simulated Meta delivery for one inbound', async () => {
    const suffix = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `a7-d16-${suffix}` },
    });
    contacts.push(contact.id);
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
    const inbound = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'Mensaje sintético',
        wamid: `wamid.a7.${suffix}`,
      },
    });
    const turn = await turns.schedule({
      conversationId: conversation.id,
      contactId: contact.id,
      inboundMessageId: inbound.id,
    });
    expect(
      (
        await turns.schedule({
          conversationId: conversation.id,
          contactId: contact.id,
          inboundMessageId: inbound.id,
        })
      ).id,
    ).toBe(turn.id);
    await prisma.inboundTurn.update({
      where: { id: turn.id },
      data: { dueAt: new Date(0) },
    });
    const claim = await turns.claim(turn.id);
    expect(claim?.processingToken).toBeTruthy();
    const input: ConversationTurnInput = {
      conversationId: conversation.id,
      inboundMessageId: inbound.id,
      assignedEngine: 'nous_hermes',
      normalNousClaim: {
        turnId: turn.id,
        processingToken: claim!.processingToken!,
      },
      customerMessage: inbound.content!,
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Prueba',
      },
    };
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
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
      config,
      new AgentOutputValidator(),
      { read: async () => 'synthetic-only-key' },
      turns,
      prisma,
    );
    const processor = new NousHermesProcessor(transport, turns, config);
    worker = new Worker(
      queueName,
      (job) => processor.process(job as Job<ConversationTurnInput>),
      { connection, concurrency: 1 },
    );
    const engine = new NousHermesEngine(
      config,
      queue,
      { queueEvents: events } as NousHermesQueueEvents,
      turns,
    );
    const result = await engine.respond(input);
    expect(result.replyText).toBe('Respuesta sintética.');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(NOUS_HERMES_ENDPOINT);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: turn.id } }))
        .nousResultAt,
    ).not.toBeNull();
    expect((await turns.readNousResult(turn.id, inbound.id))?.replyText).toBe(
      result.replyText,
    );

    const sendTextMessage = jest
      .fn()
      .mockResolvedValue({ messages: [{ id: `wamid.out.${suffix}` }] });
    const delivery = new AutomatedDeliveryService(
      prisma,
      { sendTextMessage } as unknown as MetaService,
      config,
    );
    const batch = {
      deliveryKind: 'HERMES_REPLY' as const,
      conversationId: conversation.id,
      contactId: contact.id,
      sourceMessageId: inbound.id,
      sender: 'HERMES' as const,
      allowHandedOff: false,
      parts: [
        {
          partIndex: 0,
          content: result.replyText,
          metadata: { conversationEngine: 'nous_hermes', traceId: inbound.id },
        },
      ],
    };
    await delivery.prepareBatch(batch);
    await delivery.prepareBatch(batch);
    expect((await delivery.deliverPreparedBatch(inbound.id)).confirmed).toBe(1);
    expect((await delivery.deliverPreparedBatch(inbound.id)).confirmed).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(
      await prisma.automatedDelivery.count({
        where: { sourceMessageId: inbound.id },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.automatedDelivery.findFirstOrThrow({
          where: { sourceMessageId: inbound.id },
        })
      ).status,
    ).toBe('CONFIRMED');
    await turns.complete(turn.id, claim!.processingToken!);
    expect(
      (await prisma.inboundTurn.findUniqueOrThrow({ where: { id: turn.id } }))
        .status,
    ).toBe('PROCESSED');
  });
});

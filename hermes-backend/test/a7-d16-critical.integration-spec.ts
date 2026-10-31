import { randomUUID } from 'node:crypto';
import { fork, ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageSender, MessageType } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ConversationTurnInput } from '../src/conversation-engine/conversation-engine.types';
import { MetaService } from '../src/meta/meta.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (
  databaseUrl !==
    'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/hermes_a7_d16_test?schema=public' ||
  redisUrl !== 'redis://127.0.0.1:56380/0'
)
  throw new Error('Critical validation requires the exact synthetic services');

type ChildOptions = {
  mode: string;
  nousQueueName: string;
  autoQueueName: string;
  turnId: string;
  processingToken: string;
  sourceMessageId: string;
  conversationId: string;
  contactId: string;
  nousCallsKey: string;
  metaCallsKey: string;
};
type Signal = { event: string; pid: number; [key: string]: unknown };
type ControlledChild = {
  process: ChildProcess;
  messages: Signal[];
  output: string;
};

describe('A7-D16 R2 process interruption (real PostgreSQL and Redis)', () => {
  const redisAddress = new URL(redisUrl);
  const connection = {
    host: redisAddress.hostname,
    port: Number(redisAddress.port),
    maxRetriesPerRequest: null,
  };
  const config = {
    get: (key: string, fallback?: unknown) =>
      (
        ({
          NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
          NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
          NOUS_PILOT_OPERATIONS_ENABLED: 'true',
        }) as Record<string, string>
      )[key] ?? fallback,
  } as ConfigService;
  let prisma: PrismaService;
  let redis: IORedis;
  let turns: InboundTurnService;
  const contacts: string[] = [];
  const queues: Queue[] = [];
  const children: ControlledChild[] = [];
  const keys: string[] = [];
  const evidence: Record<string, unknown>[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    turns = new InboundTurnService(prisma, config);
  });

  afterEach(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (
          child.process.exitCode === null &&
          child.process.signalCode === null
        )
          await stop(child);
      }),
    );
    children.length = 0;
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    queues.length = 0;
    await redis.del(...keys);
    keys.length = 0;
    await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    contacts.length = 0;
  });

  afterAll(async () => {
    if (process.env.A7_D16_CRITICAL_FILE)
      writeFileSync(
        process.env.A7_D16_CRITICAL_FILE,
        JSON.stringify(evidence, null, 2),
      );
    await redis?.quit();
    await prisma?.$disconnect();
  });

  function start(options: ChildOptions): ControlledChild {
    const child: ControlledChild = {
      process: fork(
        join(__dirname, 'a7-d16-critical-worker.cjs'),
        [JSON.stringify(options)],
        {
          cwd: join(__dirname, '..'),
          env: { ...process.env, DATABASE_URL: databaseUrl },
          execArgv: [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      ),
      messages: [],
      output: '',
    };
    child.process.on('message', (message: Signal) =>
      child.messages.push(message),
    );
    child.process.stdout?.on('data', (chunk: Buffer) => {
      child.output += chunk.toString();
    });
    child.process.stderr?.on('data', (chunk: Buffer) => {
      child.output += chunk.toString();
    });
    children.push(child);
    return child;
  }

  async function message(
    child: ControlledChild,
    event: string,
  ): Promise<Signal> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const found = child.messages.find((item) => item.event === event);
      if (found) return found;
      const error = child.messages.find((item) => item.event === 'error');
      if (
        error ||
        child.process.exitCode !== null ||
        child.process.signalCode !== null
      )
        throw new Error(
          `Child stopped before ${event}: ${JSON.stringify(error)} ${child.output.slice(-2000)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${event}: ${child.output.slice(-2000)}`,
    );
  }

  async function stop(child: ControlledChild): Promise<void> {
    if (child.process.exitCode !== null || child.process.signalCode !== null)
      return;
    const exited = new Promise<void>((resolve) =>
      child.process.once('exit', () => resolve()),
    );
    child.process.kill('SIGKILL');
    await exited;
  }

  async function exited(child: ControlledChild): Promise<void> {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      expect(child.process.exitCode).toBe(0);
      return;
    }
    await new Promise<void>((resolve) =>
      child.process.once('exit', () => resolve()),
    );
    expect(child.process.exitCode).toBe(0);
  }

  async function fixture() {
    const suffix = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `a7-r2-${suffix}` },
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
        content: 'Solicitud sintética R2',
        wamid: `wamid.r2.${suffix}`,
      },
    });
    const turn = await turns.schedule({
      conversationId: conversation.id,
      contactId: contact.id,
      inboundMessageId: inbound.id,
    });
    await prisma.inboundTurn.update({
      where: { id: turn.id },
      data: { dueAt: new Date(0) },
    });
    const claim = await turns.claim(turn.id);
    if (!claim?.processingToken)
      throw new Error('Synthetic turn was not claimed');
    const nousQueueName = `a7-r2-nous-${suffix}`;
    const autoQueueName = `a7-r2-auto-${suffix}`;
    const nousCallsKey = `a7:r2:nous:${suffix}`;
    const metaCallsKey = `a7:r2:meta:${suffix}`;
    keys.push(nousCallsKey, metaCallsKey);
    const options: ChildOptions = {
      mode: '',
      nousQueueName,
      autoQueueName,
      turnId: turn.id,
      processingToken: claim.processingToken,
      sourceMessageId: inbound.id,
      conversationId: conversation.id,
      contactId: contact.id,
      nousCallsKey,
      metaCallsKey,
    };
    const queue = new Queue<ConversationTurnInput>(nousQueueName, {
      connection,
    });
    queues.push(queue);
    queues.push(new Queue(autoQueueName, { connection }));
    return { options, queue, inbound };
  }

  it('resumes a durable Nous result after killing the worker before BullMQ completion', async () => {
    const { options, queue, inbound } = await fixture();
    expect(
      await turns.markNousQueued({
        turnId: options.turnId,
        sourceMessageId: inbound.id,
        processingToken: options.processingToken,
      }),
    ).toBe(true);
    const worker = start({ ...options, mode: 'nous-crash' });
    await message(worker, 'ready');
    const input: ConversationTurnInput = {
      conversationId: options.conversationId,
      inboundMessageId: inbound.id,
      assignedEngine: 'nous_hermes',
      normalNousClaim: {
        turnId: options.turnId,
        processingToken: options.processingToken,
      },
      customerMessage: inbound.content!,
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: 'Prueba',
      },
    };
    const queued = await queue.add('infer', input, {
      jobId: `nous-${inbound.id}`,
      removeOnComplete: false,
    });
    const persisted = await message(worker, 'result-persisted');
    expect(persisted.stored).toBe(true);
    const before = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: options.turnId },
    });
    expect(before.nousResultAt).not.toBeNull();
    expect(
      (await turns.readNousResult(options.turnId, inbound.id))?.replyText,
    ).toBe('Respuesta sintética recuperable.');
    expect(await queued.getState()).toBe('active');
    await stop(worker);
    await prisma.inboundTurn.update({
      where: { id: options.turnId },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    const restarted = start({ ...options, mode: 'resume-result' });
    await message(restarted, 'recovery-finished');
    await exited(restarted);
    const after = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: options.turnId },
    });
    const deliveries = await prisma.automatedDelivery.findMany({
      where: { sourceMessageId: inbound.id },
    });
    const outbound = await prisma.message.count({
      where: {
        conversationId: options.conversationId,
        direction: MessageDirection.OUTBOUND,
      },
    });
    expect(after.status).toBe('PROCESSED');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('CONFIRMED');
    expect(outbound).toBe(1);
    expect(await redis.get(options.nousCallsKey)).toBe('1');
    expect(await redis.get(options.metaCallsKey)).toBe('1');
    evidence.push({
      scenario: 'durable-result',
      workerPid: worker.process.pid,
      restartPid: restarted.process.pid,
      beforeStatus: before.status,
      durableAt: before.nousResultAt?.toISOString(),
      afterStatus: after.status,
      nousCalls: 1,
      metaCalls: 1,
      deliveries: deliveries.length,
      outbound,
    });
  });

  it('keeps an uncertain Meta dispatch ambiguous and creates human review after restart', async () => {
    const { options, inbound } = await fixture();
    const delivery = new AutomatedDeliveryService(
      prisma,
      {} as MetaService,
      config,
    );
    await delivery.prepareBatch({
      deliveryKind: 'HERMES_REPLY',
      conversationId: options.conversationId,
      contactId: options.contactId,
      sourceMessageId: inbound.id,
      sender: 'HERMES',
      allowHandedOff: false,
      parts: [
        {
          partIndex: 0,
          content: 'Respuesta sintética.',
          metadata: { conversationEngine: 'nous_hermes', traceId: inbound.id },
        },
      ],
    });
    const worker = start({ ...options, mode: 'meta-crash' });
    await message(worker, 'meta-called');
    const during = await prisma.automatedDelivery.findFirstOrThrow({
      where: { sourceMessageId: inbound.id },
    });
    expect(during.status).toBe('DISPATCHING');
    await stop(worker);
    await prisma.automatedDelivery.update({
      where: { id: during.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const restarted = start({ ...options, mode: 'meta-recover' });
    const recovered = await message(restarted, 'meta-recovered');
    await exited(restarted);
    const after = await prisma.automatedDelivery.findFirstOrThrow({
      where: { id: during.id },
    });
    const tasks = await prisma.task.findMany({
      where: { conversationId: options.conversationId },
    });
    const outbound = await prisma.message.count({
      where: {
        conversationId: options.conversationId,
        direction: MessageDirection.OUTBOUND,
      },
    });
    expect(after.status).toBe('AMBIGUOUS');
    expect(after.wamid).toBeNull();
    expect(outbound).toBe(0);
    expect(await redis.get(options.metaCallsKey)).toBe('1');
    expect((recovered.recovered as { confirmed: number }).confirmed).toBe(0);
    expect(recovered.reviewBeforeRetry).toBe(1);
    expect((recovered.recoveredAgain as { confirmed: number }).confirmed).toBe(
      0,
    );
    expect(tasks).toHaveLength(1);
    expect((tasks[0].metadata as Record<string, unknown>)?.actionStatus).toBe(
      'PENDING_REVIEW',
    );
    evidence.push({
      scenario: 'meta-uncertain',
      workerPid: worker.process.pid,
      restartPid: restarted.process.pid,
      ledgerStatus: after.status,
      reasonCode: after.reasonCode,
      metaCalls: 1,
      outbound,
      reviewTasks: tasks.length,
    });
  });

  it('blocks a queued marker with no Redis job after killing admission before queue.add', async () => {
    const { options, queue } = await fixture();
    const worker = start({ ...options, mode: 'admission-crash' });
    const marked = await message(worker, 'queue-marked');
    expect(marked.marked).toBe(true);
    expect(
      (
        await prisma.inboundTurn.findUniqueOrThrow({
          where: { id: options.turnId },
        })
      ).nousQueuedAt,
    ).not.toBeNull();
    expect(
      await queue.getJob(`nous-${options.sourceMessageId}`),
    ).toBeUndefined();
    await stop(worker);
    await prisma.inboundTurn.update({
      where: { id: options.turnId },
      data: { processingAt: new Date(Date.now() - 16 * 60_000) },
    });
    const restarted = start({ ...options, mode: 'resume-admission' });
    await message(restarted, 'recovery-finished');
    await exited(restarted);
    const after = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: options.turnId },
    });
    const tasks = await prisma.task.findMany({
      where: { conversationId: options.conversationId },
    });
    expect(after.status).toBe('BLOCKED');
    expect(after.generationBlockReason).toBe(
      'NOUS_QUEUE_OUTCOME_UNKNOWN_REVIEWED',
    );
    expect(tasks).toHaveLength(1);
    expect(
      await queue.getJob(`nous-${options.sourceMessageId}`),
    ).toBeUndefined();
    expect(await redis.get(options.nousCallsKey)).toBeNull();
    evidence.push({
      scenario: 'queue-admission',
      workerPid: worker.process.pid,
      restartPid: restarted.process.pid,
      status: after.status,
      reasonCode: after.generationBlockReason,
      nousCalls: 0,
      reviewTasks: tasks.length,
    });
  });
});

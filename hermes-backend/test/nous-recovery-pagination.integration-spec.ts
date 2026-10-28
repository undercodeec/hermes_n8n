import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConversationStatus, InboundTurnStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  InboundTurnService,
  NORMAL_NOUS_GENERATION_ENGINE,
} from '../src/auto-replies/inbound-turn.service';
import { InboundTurnRecoveryService } from '../src/auto-replies/inbound-turn-recovery.service';
import type { AutoReplyJobData } from '../src/auto-replies/auto-reply.constants';
import { HandoffService } from '../src/handoff/handoff.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TasksService } from '../src/tasks/tasks.service';

const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (
  !databaseUrl ||
  ![
    'postgresql://learning_test:learning_test_only@127.0.0.1:55432/hermes_learning_test?schema=public',
    'postgresql://a7_d16_test:a7_d16_test_only@127.0.0.1:55433/hermes_a7_d16_test?schema=public',
  ].includes(databaseUrl)
)
  throw new Error('Refusing non-isolated PostgreSQL');
if (
  !redisUrl ||
  !['redis://127.0.0.1:56379/0', 'redis://127.0.0.1:56380/0'].includes(redisUrl)
)
  throw new Error('Refusing non-isolated Redis');

describe('Nous pending recovery pagination (PostgreSQL + Redis)', () => {
  let prisma: PrismaService;
  const contacts: string[] = [];
  const queues: Queue[] = [];
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port),
    maxRetriesPerRequest: null,
  };
  const config = {
    get: (_key: string, fallback?: unknown) => fallback,
  } as ConfigService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await prisma.contact.deleteMany({ where: { id: { in: contacts } } });
    queues.length = 0;
    contacts.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function fixture(
    count: number,
    missingIndex?: number,
    options: { sameTimestamp?: boolean } = {},
  ) {
    const prefix = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `recovery-${prefix}` },
    });
    contacts.push(contact.id);
    const conversation = await prisma.conversation.create({
      data: { contactId: contact.id, status: ConversationStatus.ACTIVE },
    });
    const old = Date.now() - 20 * 60_000;
    const rows = Array.from({ length: count }, (_, index) => {
      const id = `${prefix}-${String(index).padStart(4, '0')}`;
      return {
        id,
        conversationId: conversation.id,
        contactId: contact.id,
        firstAt: new Date(old),
        lastAt: new Date(old),
        dueAt: new Date(old),
        lastMessageId: `source-${id}`,
        status: InboundTurnStatus.PROCESSING,
        processingAt: new Date(old + (options.sameTimestamp ? 0 : index)),
        processingToken: `token-${id}`,
        nousQueuedAt: new Date(old),
      };
    });
    await prisma.inboundTurn.createMany({ data: rows });
    const queue = new Queue(`nous-recovery-${prefix}`, { connection });
    queues.push(queue);
    await queue.addBulk(
      rows
        .filter((_, index) => index !== missingIndex)
        .map((row) => ({
          name: 'infer',
          data: {},
          opts: { jobId: `nous-${row.lastMessageId}` },
        })),
    );
    const requestHermesReview = jest.fn().mockResolvedValue({ id: 'review' });
    const handoff = jest.fn().mockResolvedValue({ id: 'handoff' });
    const autoReplyAdd = jest.fn().mockResolvedValue(undefined);
    const turns = new InboundTurnService(prisma, config);
    const makeRecovery = () =>
      new InboundTurnRecoveryService(
        turns,
        { add: autoReplyAdd } as unknown as Queue<AutoReplyJobData>,
        { requestHermesReview } as unknown as TasksService,
        { create: handoff } as unknown as HandoffService,
        queue,
      );
    return {
      rows,
      queue,
      turns,
      recovery: makeRecovery(),
      makeRecovery,
      requestHermesReview,
      handoff,
      autoReplyAdd,
    };
  }

  async function status(id: string) {
    return (await prisma.inboundTurn.findUniqueOrThrow({ where: { id } }))
      .status;
  }

  it('wraps a short page and revisits waiting turns without dispatching', async () => {
    const f = await fixture(99);
    const getJob = jest.spyOn(f.queue, 'getJob');
    await f.recovery.scan();
    await f.recovery.scan();
    expect(getJob).toHaveBeenCalledTimes(198);
    expect(await f.queue.getWaitingCount()).toBe(99);
    expect(f.autoReplyAdd).not.toHaveBeenCalled();
  });

  it('wraps after an exact page of 100 waiting turns', async () => {
    const f = await fixture(100);
    const getJob = jest.spyOn(f.queue, 'getJob');
    await f.recovery.scan();
    await f.recovery.scan(); // empty page resets the cursor
    await f.recovery.scan();
    expect(getJob).toHaveBeenCalledTimes(200);
    expect(await f.queue.getWaitingCount()).toBe(100);
    expect(f.requestHermesReview).not.toHaveBeenCalled();
  });

  it('reaches a missing job at turn 101 while the first 100 remain waiting', async () => {
    const f = await fixture(101, 100);
    await f.recovery.scan();
    await f.recovery.scan();
    const target = await prisma.inboundTurn.findUniqueOrThrow({
      where: { id: f.rows[100].id },
    });
    expect(target.status).toBe(InboundTurnStatus.BLOCKED);
    expect(target.generationBlockReason).toBe(
      'NOUS_QUEUE_OUTCOME_UNKNOWN_REVIEWED',
    );
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
    expect(f.handoff).toHaveBeenCalledTimes(1);
    expect(f.autoReplyAdd).not.toHaveBeenCalled();
    expect(
      await prisma.inboundTurn.count({
        where: {
          id: { in: f.rows.slice(0, 100).map((row) => row.id) },
          status: InboundTurnStatus.PROCESSING,
        },
      }),
    ).toBe(100);
    expect(await f.queue.getWaitingCount()).toBe(100);
    await f.recovery.scan(); // duplicate recovery event
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
    expect(f.handoff).toHaveBeenCalledTimes(1);
  });

  it('reaches the last of 250 turns in three bounded scans', async () => {
    const f = await fixture(250, 249);
    const getJob = jest.spyOn(f.queue, 'getJob');
    await f.recovery.scan();
    await f.recovery.scan();
    expect(await status(f.rows[249].id)).toBe(InboundTurnStatus.PROCESSING);
    await f.recovery.scan();
    expect(await status(f.rows[249].id)).toBe(InboundTurnStatus.BLOCKED);
    expect(getJob).toHaveBeenCalledTimes(250);
    expect(await f.queue.getWaitingCount()).toBe(249);
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
    expect(f.autoReplyAdd).not.toHaveBeenCalled();
  });

  it('uses id as a tie breaker when 101 turns share processingAt', async () => {
    const f = await fixture(101, 100, { sameTimestamp: true });
    await f.recovery.scan();
    await f.recovery.scan();
    expect(await status(f.rows[100].id)).toBe(InboundTurnStatus.BLOCKED);
    expect(await f.queue.getWaitingCount()).toBe(100);
  });

  it('eventually sees a new earlier turn after a page boundary and a state change', async () => {
    const f = await fixture(100);
    await f.recovery.scan();
    await prisma.inboundTurn.update({
      where: { id: f.rows[0].id },
      data: { status: InboundTurnStatus.PROCESSED },
    });
    const newId = `${randomUUID()}-inserted`;
    await prisma.inboundTurn.create({
      data: {
        ...f.rows[0],
        id: newId,
        lastMessageId: `source-${newId}`,
        processingToken: `token-${newId}`,
        processingAt: new Date(f.rows[0].processingAt.getTime() - 1),
      },
    });
    await f.recovery.scan(); // reaches the end and wraps
    await f.recovery.scan(); // sees the new earlier row
    expect(await status(newId)).toBe(InboundTurnStatus.BLOCKED);
    expect(await status(f.rows[0].id)).toBe(InboundTurnStatus.PROCESSED);
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
  });

  it('restarts safely and reaches turn 101 on the next scan', async () => {
    const f = await fixture(101, 100);
    await f.recovery.scan();
    const restarted = f.makeRecovery();
    await restarted.scan();
    await restarted.scan();
    expect(await status(f.rows[100].id)).toBe(InboundTurnStatus.BLOCKED);
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
  });

  it('retains the page boundary after a PostgreSQL query failure', async () => {
    const f = await fixture(101, 100);
    await f.recovery.scan();
    jest
      .spyOn(f.turns, 'stalePendingNous')
      .mockRejectedValueOnce(new Error('simulated PostgreSQL failure'));
    await f.recovery.scan();
    expect(await status(f.rows[100].id)).toBe(InboundTurnStatus.PROCESSING);
    await f.recovery.scan();
    expect(await status(f.rows[100].id)).toBe(InboundTurnStatus.BLOCKED);
    expect(f.requestHermesReview).toHaveBeenCalledTimes(1);
  });

  it('preserves a result that arrives after the page query but before reconciliation', async () => {
    const f = await fixture(101, 100);
    const target = f.rows[100];
    await prisma.inboundTurn.update({
      where: { id: target.id },
      data: {
        generationEngine: NORMAL_NOUS_GENERATION_ENGINE,
        generationReservedAt: new Date(target.processingAt),
        generationSourceMessageId: target.lastMessageId,
        providerDispatchReservedAt: new Date(target.processingAt),
      },
    });
    await f.recovery.scan();
    const originalGetJob = f.queue.getJob.bind(f.queue);
    jest.spyOn(f.queue, 'getJob').mockImplementation(async (jobId) => {
      if (jobId === `nous-${target.lastMessageId}`) {
        await prisma.inboundTurn.update({
          where: { id: target.id },
          data: {
            nousResultAt: new Date(),
            nousResult: {
              engine: 'nous_hermes',
              traceId: target.lastMessageId,
              replyText: 'Resultado tardío',
              providerModel: 'synthetic',
              proposedActions: [{ type: 'none' }],
            },
          },
        });
      }
      return originalGetJob(jobId);
    });
    await f.recovery.scan();
    expect(await status(target.id)).toBe(InboundTurnStatus.PROCESSING);
    expect(f.requestHermesReview).not.toHaveBeenCalled();
    await f.recovery.scan();
    expect(await status(target.id)).toBe(InboundTurnStatus.OPEN);
    expect(f.autoReplyAdd).toHaveBeenCalledTimes(1);
    expect(f.autoReplyAdd).toHaveBeenCalledWith(
      'send-auto-reply',
      expect.objectContaining({ inboundTurnId: target.id }),
      expect.any(Object),
    );
    expect(
      await f.turns.readNousResult(target.id, target.lastMessageId),
    ).not.toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { InboundTurnService } from '../src/auto-replies/inbound-turn.service';
import {
  NousHermesEngine,
  NousQueuePendingError,
} from '../src/conversation-engine/nous-hermes.engine';
import { NousHermesQueueEvents } from '../src/conversation-engine/nous-hermes.queue-events';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from '../src/conversation-engine/conversation-engine.types';

describe('Nous BullMQ global concurrency (integration)', () => {
  const redisUrl = process.env.REDIS_INTEGRATION_URL;
  if (!redisUrl) {
    throw new Error('REDIS_INTEGRATION_URL is required');
  }

  const queueName = `nous-concurrency-${randomUUID()}`;
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
  const queue = new Queue(queueName, { connection });
  const events = new QueueEvents(queueName, { connection });
  const workers: Worker[] = [];

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('runs only one job across two workers', async () => {
    let active = 0;
    let maximumActive = 0;
    const processor = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'ok';
      } finally {
        active -= 1;
      }
    };
    workers.push(
      new Worker(queueName, processor, { connection, concurrency: 2 }),
      new Worker(queueName, processor, { connection, concurrency: 2 }),
    );
    await events.waitUntilReady();
    await queue.setGlobalConcurrency(1);
    const jobs = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        queue.add('infer', { index }, { removeOnComplete: false }),
      ),
    );
    await Promise.all(jobs.map((job) => job.waitUntilFinished(events, 10_000)));
    expect(maximumActive).toBe(1);
    expect(await queue.getGlobalConcurrency()).toBe(1);
  });

  it('returns all 20 original results through a waiting backlog and worker restart', async () => {
    const name = `nous-monitor-${randomUUID()}`;
    const pilotQueue = new Queue<
      ConversationTurnInput,
      ConversationTurnResult,
      string
    >(name, { connection });
    const pilotEvents = new QueueEvents(name, { connection });
    pilotQueue.setMaxListeners(25);
    let firstWorker:
      | Worker<ConversationTurnInput, ConversationTurnResult>
      | undefined;
    let secondWorker:
      | Worker<ConversationTurnInput, ConversationTurnResult>
      | undefined;
    try {
      await pilotEvents.waitUntilReady();
      await pilotQueue.setGlobalConcurrency(1);
      let processed = 0;
      const durableResults = new Map<string, ConversationTurnResult>();
      let releaseFive: () => void = () => undefined;
      const fifth = new Promise<void>((resolve) => {
        releaseFive = resolve;
      });
      const processJob = async (job: {
        data: ConversationTurnInput;
      }): Promise<ConversationTurnResult> => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        processed += 1;
        if (processed === 5) releaseFive();
        const result: ConversationTurnResult = {
          replyText: 'Respuesta sintética.',
          proposedActions: [{ type: 'none' }],
          engine: 'nous_hermes',
          providerModel: 'synthetic',
          traceId: job.data.inboundMessageId,
        };
        durableResults.set(job.data.inboundMessageId, result);
        return result;
      };
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
            NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
            NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS: '100',
          })[key as 'NOUS_PILOT_BUDGET_MODE'] ?? fallback,
      } as ConfigService;
      const blockAmbiguous = jest.fn();
      const markNousQueued = jest.fn().mockResolvedValue(true);
      const readNousResult = jest
        .fn()
        .mockImplementation((_turnId: string, sourceMessageId: string) =>
          Promise.resolve(durableResults.get(sourceMessageId) ?? null),
        );
      const engine = new NousHermesEngine(
        config,
        pilotQueue,
        { queueEvents: pilotEvents } as NousHermesQueueEvents,
        {
          blockAmbiguous,
          markNousQueued,
          readNousResult,
        } as unknown as InboundTurnService,
      );
      const requests = Array.from({ length: 20 }, (_, index) => ({
        conversationId: `conversation-${index}`,
        inboundMessageId: `inbound-${index}`,
        assignedEngine: 'nous_hermes' as const,
        normalNousClaim: {
          turnId: `turn-${index}`,
          processingToken: `token-${index}`,
        },
        customerMessage: 'Solicitud sintética',
        approvedContext: {
          recentMessages: [],
          approvedKnowledge: [],
          handoffActive: false,
          contactName: 'Prueba',
        },
      }));
      const pending = requests.map((request) => engine.respond(request));
      firstWorker = new Worker(name, processJob, {
        connection,
        concurrency: 1,
      });
      await fifth;
      await firstWorker.close();
      secondWorker = new Worker(name, processJob, {
        connection,
        concurrency: 1,
      });
      const results = await Promise.allSettled(pending);
      expect(
        results.some(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof NousQueuePendingError,
        ),
      ).toBe(true);
      const deadline = Date.now() + 5000;
      while (processed < 20 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect([...durableResults.keys()].sort()).toEqual(
        requests.map((request) => request.inboundMessageId).sort(),
      );
      expect(processed).toBe(20);
      expect(blockAmbiguous).not.toHaveBeenCalled();
    } finally {
      await firstWorker?.close();
      await secondWorker?.close();
      await pilotEvents.close();
      await pilotQueue.obliterate({ force: true });
      await pilotQueue.close();
    }
  });

  it('detaches after a worker outage longer than the bounded wait and runs the original job on restart', async () => {
    const name = `nous-long-outage-${randomUUID()}`;
    const pilotQueue = new Queue<
      ConversationTurnInput,
      ConversationTurnResult,
      string
    >(name, { connection });
    const pilotEvents = new QueueEvents(name, { connection });
    let worker:
      | Worker<ConversationTurnInput, ConversationTurnResult>
      | undefined;
    try {
      await pilotEvents.waitUntilReady();
      const input: ConversationTurnInput = {
        conversationId: 'conversation-long-outage',
        inboundMessageId: 'inbound-long-outage',
        assignedEngine: 'nous_hermes',
        normalNousClaim: {
          turnId: 'turn-long-outage',
          processingToken: 'token-long-outage',
        },
        customerMessage: 'Solicitud sintética',
        approvedContext: {
          recentMessages: [],
          approvedKnowledge: [],
          handoffActive: false,
          contactName: 'Prueba',
        },
      };
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
            NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
            NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS: '100',
          })[key as 'NOUS_PILOT_BUDGET_MODE'] ?? fallback,
      } as ConfigService;
      const blockAmbiguous = jest.fn();
      const engine = new NousHermesEngine(
        config,
        pilotQueue,
        { queueEvents: pilotEvents } as NousHermesQueueEvents,
        {
          blockAmbiguous,
          markNousQueued: jest.fn().mockResolvedValue(true),
          readNousResult: jest.fn().mockResolvedValue(null),
        } as unknown as InboundTurnService,
      );
      const started = Date.now();
      await expect(engine.respond(input)).rejects.toBeInstanceOf(
        NousQueuePendingError,
      );
      expect(Date.now() - started).toBeLessThan(1500);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const original = await pilotQueue.getJob('nous-inbound-long-outage');
      expect(original).toBeDefined();
      expect(await original!.getState()).toBe('waiting');
      const processed = jest.fn().mockImplementation(() => ({
        replyText: 'Respuesta original.',
        proposedActions: [{ type: 'none' }],
        engine: 'nous_hermes',
        providerModel: 'synthetic',
        traceId: input.inboundMessageId,
      }));
      worker = new Worker(name, processed, { connection });
      await expect(
        original!.waitUntilFinished(pilotEvents, 5000),
      ).resolves.toMatchObject({
        replyText: 'Respuesta original.',
      });
      expect(processed).toHaveBeenCalledTimes(1);
      expect(blockAmbiguous).not.toHaveBeenCalled();
    } finally {
      await worker?.close();
      await pilotEvents.close();
      await pilotQueue.obliterate({ force: true });
      await pilotQueue.close();
    }
  });
});

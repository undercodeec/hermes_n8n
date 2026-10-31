'use strict';

require('./a7-d16-egress-guard.cjs');
require('reflect-metadata');
require('ts-node/register/transpile-only');

const axios = require('axios');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const { PrismaService } = require('../src/prisma/prisma.service.ts');
const {
  InboundTurnService,
} = require('../src/auto-replies/inbound-turn.service.ts');
const {
  InboundTurnRecoveryService,
} = require('../src/auto-replies/inbound-turn-recovery.service.ts');
const {
  AutomatedDeliveryService,
} = require('../src/automated-deliveries/automated-delivery.service.ts');
const { TasksService } = require('../src/tasks/tasks.service.ts');
const {
  AgentOutputValidator,
} = require('../src/conversation-engine/agent-output.validator.ts');
const {
  NousHermesTransport,
} = require('../src/conversation-engine/nous-hermes.transport.ts');
const {
  NousHermesProcessor,
} = require('../src/conversation-engine/nous-hermes.processor.ts');

const options = JSON.parse(process.argv[2]);
const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (
  redisUrl !== 'redis://127.0.0.1:56380/0' ||
  process.env.DATABASE_URL !==
    'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/hermes_a7_d16_test?schema=public'
)
  throw new Error('Critical worker requires the exact synthetic services');
const parsed = new URL(redisUrl);
const connection = {
  host: parsed.hostname,
  port: Number(parsed.port),
  maxRetriesPerRequest: null,
};
const config = {
  get(key, fallback) {
    return (
      {
        NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
        NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
        NOUS_PILOT_OPERATIONS_ENABLED: 'true',
        NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS: '10000',
      }[key] ?? fallback
    );
  },
};
const signal = (event, data = {}) =>
  process.send?.({ event, pid: process.pid, ...data });

async function main() {
  const prisma = new PrismaService();
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queues = [];
  let worker;
  try {
    await prisma.$connect();
    const turns = new InboundTurnService(prisma, config);
    const queue = (name) => {
      const value = new Queue(name, { connection });
      queues.push(value);
      return value;
    };

    if (options.mode === 'nous-crash') {
      axios.post = async () => {
        await redis.incr(options.nousCallsKey);
        return {
          data: {
            model: 'hermes-agent',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    replyText: 'Respuesta sintética recuperable.',
                  }),
                },
              },
            ],
          },
        };
      };
      const realStore = turns.storeNousResult.bind(turns);
      turns.storeNousResult = async (input) => {
        const stored = await realStore(input);
        signal('result-persisted', { stored });
        await new Promise(() => {}); // The parent kills this process before BullMQ completion.
      };
      const transport = new NousHermesTransport(
        config,
        new AgentOutputValidator(),
        { read: async () => 'synthetic-only-key' },
        turns,
        prisma,
      );
      const processor = new NousHermesProcessor(transport, turns, config);
      worker = new Worker(
        options.nousQueueName,
        (job) => processor.process(job),
        { connection, concurrency: 1 },
      );
      await worker.waitUntilReady();
      signal('ready');
      await new Promise(() => {});
    } else if (options.mode === 'admission-crash') {
      const marked = await turns.markNousQueued({
        turnId: options.turnId,
        sourceMessageId: options.sourceMessageId,
        processingToken: options.processingToken,
      });
      signal('queue-marked', { marked });
      await new Promise(() => {}); // Deliberately stop before queue.add.
    } else if (
      options.mode === 'resume-result' ||
      options.mode === 'resume-admission'
    ) {
      const autoQueue = queue(options.autoQueueName);
      const nousQueue = queue(options.nousQueueName);
      const tasks = new TasksService(prisma);
      let delivered;
      if (options.mode === 'resume-result') {
        const delivery = new AutomatedDeliveryService(
          prisma,
          {
            sendTextMessage: async () => {
              await redis.incr(options.metaCallsKey);
              return {
                messages: [{ id: `wamid.mock.${options.sourceMessageId}` }],
              };
            },
          },
          config,
        );
        worker = new Worker(
          options.autoQueueName,
          async (job) => {
            const claim = await turns.claim(job.data.inboundTurnId);
            if (!claim) throw new Error('Recovered turn was not claimable');
            const result = await turns.readNousResult(
              claim.id,
              options.sourceMessageId,
            );
            if (!result) throw new Error('Durable Nous result was lost');
            await delivery.prepareBatch({
              deliveryKind: 'HERMES_REPLY',
              conversationId: options.conversationId,
              contactId: options.contactId,
              sourceMessageId: options.sourceMessageId,
              sender: 'HERMES',
              allowHandedOff: false,
              parts: [
                {
                  partIndex: 0,
                  content: result.replyText,
                  metadata: {
                    conversationEngine: 'nous_hermes',
                    traceId: options.sourceMessageId,
                  },
                },
              ],
            });
            delivered = await delivery.deliverPreparedBatch(
              options.sourceMessageId,
            );
            await turns.complete(claim.id, claim.processingToken);
            signal('resumed-delivery', { confirmed: delivered.confirmed });
          },
          { connection, concurrency: 1 },
        );
        await worker.waitUntilReady();
      }
      const recovery = new InboundTurnRecoveryService(
        turns,
        autoQueue,
        tasks,
        undefined,
        nousQueue,
      );
      await recovery.scan();
      if (options.mode === 'resume-result') {
        const deadline = Date.now() + 10000;
        while (!delivered && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (!delivered) throw new Error('Recovered turn did not deliver');
      }
      signal('recovery-finished');
    } else if (
      options.mode === 'meta-crash' ||
      options.mode === 'meta-recover'
    ) {
      const meta = {
        sendTextMessage: async () => {
          await redis.incr(options.metaCallsKey);
          signal('meta-called');
          if (options.mode === 'meta-crash') await new Promise(() => {});
          return {
            messages: [{ id: `wamid.mock.${options.sourceMessageId}` }],
          };
        },
      };
      const delivery = new AutomatedDeliveryService(
        prisma,
        meta,
        config,
        new TasksService(prisma),
      );
      if (options.mode === 'meta-crash') {
        signal('ready');
        await delivery.deliverPreparedBatch(options.sourceMessageId);
      } else {
        const expired = await delivery.recoverExpiredClaims();
        const reviewBeforeRetry = await prisma.task.count({
          where: { conversationId: options.conversationId },
        });
        const recovered = await delivery.recoverBatch(options.sourceMessageId);
        const recoveredAgain = await delivery.recoverBatch(
          options.sourceMessageId,
        );
        signal('meta-recovered', {
          expired,
          reviewBeforeRetry,
          recovered,
          recoveredAgain,
        });
      }
    } else {
      throw new Error(`Unknown critical worker mode: ${options.mode}`);
    }
  } finally {
    await worker?.close();
    await Promise.all(queues.map((item) => item.close()));
    await redis.quit();
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    signal('error', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });

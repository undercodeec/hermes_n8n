const { randomUUID } = require('node:crypto');
const { readFileSync, statfsSync } = require('node:fs');
const { setTimeout: wait } = require('node:timers/promises');
const { ConfigService } = require('@nestjs/config');
const {
  AutomatedDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} = require('@prisma/client');
const { Queue, Worker } = require('bullmq');
const {
  ConversationEngineService,
} = require('../src/conversation-engine/conversation-engine.service');
const {
  AutomatedDeliveryService,
} = require('../src/automated-deliveries/automated-delivery.service');

function isolatedUrl(value, protocol, port, database) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid isolated target');
  }
  if (
    url.protocol !== protocol ||
    url.hostname !== '127.0.0.1' ||
    url.port !== port ||
    (database && url.pathname !== database)
  )
    throw new Error('Refusing non-isolated target');
  return url;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

function hostSample() {
  const cpu = readFileSync('/proc/stat', 'utf8')
    .split('\n')[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const memory = Object.fromEntries(
    [
      ...readFileSync('/proc/meminfo', 'utf8').matchAll(
        /^([A-Za-z_]+):\s+(\d+) kB/gm,
      ),
    ].map((match) => [match[1], Number(match[2]) * 1024]),
  );
  const disk = statfsSync('/');
  return {
    cpuTotal: cpu.reduce((sum, value) => sum + value, 0),
    cpuIdle: cpu[3] + cpu[4],
    memAvailable: memory.MemAvailable,
    swapUsed: memory.SwapTotal - memory.SwapFree,
    diskAvailable: disk.bavail * disk.bsize,
  };
}

async function main() {
  if (process.env.CAPACITY_ISOLATED_CONFIRMED !== '1') {
    throw new Error('Capacity workload requires the isolated runner');
  }
  const [concurrency, turns, durationSeconds, profile] = process.argv.slice(2);
  if (
    ![concurrency, turns, durationSeconds].every((value) =>
      /^[0-9]+$/.test(value),
    ) ||
    !['smoke', 'custom-unapproved'].includes(profile)
  )
    throw new Error('Invalid capacity parameters');
  const databaseUrl = isolatedUrl(
    process.env.DATABASE_URL,
    'postgresql:',
    '55432',
    '/hermes_learning_test',
  );
  const redisUrl = isolatedUrl(process.env.REDIS_URL, 'redis:', '56379', '/0');
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl.toString() } },
  });
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port),
    maxRetriesPerRequest: null,
  };
  const queue = new Queue(`phase0-capacity-${randomUUID()}`, { connection });
  const fakeProvider = {
    id: 'gemini_direct',
    async respond() {
      return {
        replyText: 'synthetic-response',
        proposedActions: [{ type: 'none' }],
        engine: 'gemini_direct',
        providerModel: 'local-double',
        traceId: randomUUID(),
      };
    },
  };
  const engine = new ConversationEngineService(
    new ConfigService({ HERMES_CONVERSATION_ENGINE: 'gemini_direct' }),
    fakeProvider,
    fakeProvider,
  );
  const fakeMeta = {
    async sendTextMessage() {
      return { messages: [{ id: `synthetic-${randomUUID()}` }] };
    },
  };
  const delivery = new AutomatedDeliveryService(prisma, fakeMeta);
  let peakQueueDepth = 0;
  let peakCpuPercent = 0;
  let minMemAvailable = Number.POSITIVE_INFINITY;
  let peakSwapUsed = 0;
  let minDiskAvailable = Number.POSITIVE_INFINITY;
  let previous = hostSample();
  let sampleBusy = false;
  let timer;
  let worker;
  async function sample() {
    if (sampleBusy) return;
    sampleBusy = true;
    try {
      const current = hostSample();
      const total = current.cpuTotal - previous.cpuTotal;
      if (total > 0) {
        peakCpuPercent = Math.max(
          peakCpuPercent,
          100 * (1 - (current.cpuIdle - previous.cpuIdle) / total),
        );
      }
      previous = current;
      minMemAvailable = Math.min(minMemAvailable, current.memAvailable);
      peakSwapUsed = Math.max(peakSwapUsed, current.swapUsed);
      minDiskAvailable = Math.min(minDiskAvailable, current.diskAvailable);
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      peakQueueDepth = Math.max(
        peakQueueDepth,
        counts.waiting + counts.active + counts.delayed,
      );
    } finally {
      sampleBusy = false;
    }
  }

  async function processTurn(job) {
    const contact = await prisma.contact.create({
      data: { waId: `synthetic-${randomUUID()}` },
    });
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
        content: 'synthetic-inbound',
        wamid: `synthetic-${randomUUID()}`,
        rawPayload: { timestamp: String(Math.floor(Date.now() / 1000)) },
      },
    });
    const result = await engine.respond({
      conversationId: conversation.id,
      inboundMessageId: inbound.id,
      customerMessage: 'synthetic-inbound',
      approvedContext: {
        recentMessages: [],
        approvedKnowledge: [],
        handoffActive: false,
        contactName: '',
      },
    });
    await delivery.prepareBatch({
      deliveryKind: 'HERMES_REPLY',
      conversationId: conversation.id,
      contactId: contact.id,
      sourceMessageId: inbound.id,
      sender: 'HERMES',
      allowHandedOff: false,
      parts: [{ partIndex: 0, content: result.replyText }],
    });
    const sent = await delivery.deliverPreparedBatch(inbound.id);
    if (!sent.handled || !sent.terminal || sent.confirmed !== 1) {
      throw new Error('Simulated final delivery was not confirmed');
    }
    return { latencyMs: Date.now() - job.data.queuedAt };
  }

  try {
    await prisma.$connect();
    worker = new Worker(queue.name, processTurn, {
      connection,
      concurrency: Number(concurrency),
    });
    worker.on('error', () => {});
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    await sample();
    timer = setInterval(() => {
      void sample().catch(() => {});
    }, 1000);
    const start = Date.now();
    const durationMs = Number(durationSeconds) * 1000;
    let enqueued = 0;
    for (let i = 0; i < Number(turns); i += 1) {
      const target = start + (i * durationMs) / Number(turns);
      if (target > Date.now()) await wait(target - Date.now());
      if (Date.now() > start + durationMs) break;
      await queue.add(
        'synthetic-final-turn',
        { queuedAt: Date.now() },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 50 },
        },
      );
      enqueued += 1;
    }
    const deadline = Date.now() + 60_000;
    let counts;
    do {
      counts = await queue.getJobCounts('completed', 'failed');
      if (counts.completed + counts.failed >= enqueued) break;
      await wait(200);
    } while (Date.now() < deadline);
    await sample();
    const completedJobs = await queue.getJobs(['completed'], 0, -1);
    const failedJobs = await queue.getJobs(['failed'], 0, -1);
    const latencies = completedJobs
      .map((job) => job.finishedOn - job.data.queuedAt)
      .filter((latency) => Number.isFinite(latency));
    const delivered = latencies.length;
    const retries = [...completedJobs, ...failedJobs].reduce(
      (sum, job) => sum + Math.max(0, job.attemptsMade - 1),
      0,
    );
    const confirmedDeliveries = await prisma.automatedDelivery.count({
      where: { status: AutomatedDeliveryStatus.CONFIRMED },
    });
    const errors =
      counts.failed + Math.max(0, enqueued - counts.completed - counts.failed);
    const summary = {
      profile,
      representative: false,
      concurrency: Number(concurrency),
      requestedTurns: Number(turns),
      enqueued,
      completed: counts.completed,
      delivered,
      confirmedDeliveries,
      errors,
      retries,
      queueDepthPeak: peakQueueDepth,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      cpuPeakPercent: Math.round(peakCpuPercent * 10) / 10,
      memoryAvailableMinBytes: minMemAvailable,
      swapUsedPeakBytes: peakSwapUsed,
      diskAvailableMinBytes: minDiskAvailable,
    };
    if (errors || delivered !== enqueued || confirmedDeliveries !== enqueued) {
      throw new Error('Capacity workload assertions failed');
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    if (timer) clearInterval(timer);
    if (worker) await worker.close(true).catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

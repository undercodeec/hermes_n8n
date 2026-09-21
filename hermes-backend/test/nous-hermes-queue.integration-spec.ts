import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';

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
});

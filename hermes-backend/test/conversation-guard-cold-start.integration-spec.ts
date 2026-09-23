import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ConversationGuardService } from '../src/conversation-guard/conversation-guard.service';

const redisUrl = process.env.REDIS_INTEGRATION_URL;
if (!redisUrl) throw new Error('REDIS_INTEGRATION_URL is required');

describe('ConversationGuard Redis cold start', () => {
  let observer: Redis;

  beforeAll(async () => {
    observer = new Redis(redisUrl);
    await observer.ping();
  });

  afterAll(async () => {
    await observer.quit();
  });

  function guard(url = redisUrl, timeoutMs?: number): ConversationGuardService {
    return new ConversationGuardService({
      get: (key: string, fallback?: string) =>
        key === 'REDIS_URL'
          ? url
          : key === 'AI_GUARD_REDIS_READY_TIMEOUT_MS'
            ? timeoutMs
            : fallback,
    } as ConfigService);
  }

  async function quotaCounts(
    contactIds: string[],
    now = new Date(),
  ): Promise<{
    contacts: number[];
    global: number;
  }> {
    const days = [now, new Date(now.getTime() + 24 * 3600 * 1000)].map((date) =>
      date.toISOString().slice(0, 10),
    );
    const hours = [now, new Date(now.getTime() + 3600 * 1000)].map((date) =>
      date.toISOString().slice(0, 13),
    );
    const keys = contactIds.flatMap((id) =>
      days.map((day) => `hermes:guard:ai-contact:${id}:${day}`),
    );
    const values = await observer.mget(
      ...keys,
      ...hours.map((hour) => `hermes:guard:ai-global:${hour}`),
    );
    return {
      contacts: contactIds.map((_, index) =>
        values
          .slice(index * 2, index * 2 + 2)
          .reduce((total, value) => total + Number(value ?? 0), 0),
      ),
      global: values
        .slice(-2)
        .reduce((total, value) => total + Number(value ?? 0), 0),
    };
  }

  async function clientCount(): Promise<number> {
    const clients = (await observer.call('CLIENT', 'LIST')) as string;
    return clients.trim().split('\n').length;
  }

  it.each([1, 2, 5])(
    'accepts %i cold concurrent inbound quotas exactly once',
    async (count) => {
      const service = guard();
      const contactIds = Array.from({ length: count }, () => randomUUID());
      const period = new Date();
      const before = await quotaCounts(contactIds, period);
      const connectionsBefore = await clientCount();
      try {
        await expect(
          Promise.all(contactIds.map((id) => service.consumeAiQuota(id))),
        ).resolves.toEqual(Array(count).fill(true));
        const after = await quotaCounts(contactIds, period);
        expect(after.contacts).toEqual(Array(count).fill(1));
        expect(after.global - before.global).toBe(count);
        expect((await clientCount()) - connectionsBefore).toBe(1);

        const second = randomUUID();
        expect(await service.inspect(second, 'Quiero una web')).toEqual({
          action: 'ALLOW',
        });
        expect(await service.consumeAiQuota(second)).toBe(true);
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('allows a new service instance while Redis stays alive', async () => {
    const first = guard();
    const second = guard();
    try {
      expect(await first.consumeAiQuota(randomUUID())).toBe(true);
      await first.onModuleDestroy();
      expect(await second.consumeAiQuota(randomUUID())).toBe(true);
    } finally {
      await first.onModuleDestroy();
      await second.onModuleDestroy();
    }
  });

  it('allows the first inbound through inspection and quota on a cold service', async () => {
    const service = guard();
    const contactId = randomUUID();
    try {
      expect(await service.inspect(contactId, 'Quiero una web')).toEqual({
        action: 'ALLOW',
      });
      expect(await service.consumeAiQuota(contactId)).toBe(true);
      expect((await quotaCounts([contactId])).contacts).toEqual([1]);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('fails closed when Redis is unavailable', async () => {
    const service = guard('redis://127.0.0.1:1');
    try {
      expect(await service.consumeAiQuota(randomUUID())).toBe(false);
      expect(await service.inspect(randomUUID(), 'Quiero una web')).toEqual({
        action: 'BLOCK',
        category: 'SPAM',
      });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('times out without READY and recovers on the next inbound', async () => {
    const service = guard(redisUrl, 100);
    const contactId = randomUUID();
    const period = new Date();
    const before = await quotaCounts([contactId], period);
    try {
      await observer.call('CLIENT', 'PAUSE', '750', 'ALL');
      expect(await service.consumeAiQuota(contactId)).toBe(false);
      await observer.ping();
      expect((await quotaCounts([contactId], period)).contacts).toEqual([0]);
      expect(await service.consumeAiQuota(contactId)).toBe(true);
      const after = await quotaCounts([contactId], period);
      expect(after.contacts).toEqual([1]);
      expect(after.global - before.global).toBe(1);
    } finally {
      await service.onModuleDestroy();
    }
  });
});

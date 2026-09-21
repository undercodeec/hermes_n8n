import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesEngine } from './nous-hermes.engine';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { NousHermesRateLimitError } from './nous-hermes.transport';

const baseInput = (
  overrides: Partial<ConversationTurnInput> = {},
): ConversationTurnInput => ({
  conversationId: 'conversation-1',
  inboundMessageId: 'inbound-1',
  customerMessage: 'Hola',
  approvedContext: {
    recentMessages: [],
    approvedKnowledge: [],
    handoffActive: false,
    contactName: 'Ana',
  },
  ...overrides,
});

describe('NousHermesEngine queue routing', () => {
  function harness() {
    const waitUntilFinished = jest.fn().mockResolvedValue({
      replyText: 'Respuesta.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-1',
    });
    const queue = {
      add: jest.fn().mockResolvedValue({ waitUntilFinished }),
    };
    const queueEvents = { queueEvents: { id: 'events' } };
    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const engine = new NousHermesEngine(
      config as unknown as ConfigService,
      queue as unknown as Queue<
        ConversationTurnInput,
        ConversationTurnResult,
        string
      >,
      queueEvents as unknown as NousHermesQueueEvents,
    );
    return { engine, queue, queueEvents, waitUntilFinished };
  }

  it('enqueues with bounded retries and waits on the shared event host', async () => {
    const { engine, queue, queueEvents, waitUntilFinished } = harness();

    await engine.respond(baseInput());

    expect(queue.add).toHaveBeenCalledWith(
      'infer',
      baseInput(),
      expect.objectContaining({
        jobId: 'nous-inbound-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1500 },
        removeOnComplete: true,
      }),
    );
    expect(waitUntilFinished).toHaveBeenCalledWith(
      queueEvents.queueEvents,
      120000,
    );
  });

  it('short-circuits an active handoff before Redis', async () => {
    const { engine, queue } = harness();
    const input = baseInput({
      approvedContext: {
        ...baseInput().approvedContext,
        handoffActive: true,
      },
    });

    const result = await engine.respond(input);

    expect(queue.add).not.toHaveBeenCalled();
    expect(result.diagnostic?.code).toBe('NOUS_HERMES_HANDOFF_ACTIVE');
  });

  it('maps a terminal typed 429 without exposing provider detail', async () => {
    const { engine, waitUntilFinished } = harness();
    waitUntilFinished.mockRejectedValue(new NousHermesRateLimitError());

    const result = await engine.respond(baseInput());

    expect(result.diagnostic?.code).toBe('NOUS_HERMES_RATE_LIMITED');
    expect(result.replyText).not.toMatch(/Redis|provider|rate limit/i);
  });

  it('maps the serialized BullMQ 429 failure reason', async () => {
    const { engine, waitUntilFinished } = harness();
    waitUntilFinished.mockRejectedValue(new Error('Nous Hermes rate limit'));

    const result = await engine.respond(baseInput());

    expect(result.diagnostic?.code).toBe('NOUS_HERMES_RATE_LIMITED');
    expect(result.replyText).not.toMatch(/Redis|provider|rate limit/i);
  });

  it('maps queue-add and wait infrastructure failures safely', async () => {
    const addFailure = harness();
    addFailure.queue.add.mockRejectedValue(
      new Error('Redis password private-detail'),
    );
    const addResult = await addFailure.engine.respond(baseInput());
    expect(addResult.diagnostic?.code).toBe('NOUS_HERMES_QUEUE_UNAVAILABLE');
    expect(addResult.replyText).not.toMatch(/Redis|private-detail/i);

    const waitFailure = harness();
    waitFailure.waitUntilFinished.mockRejectedValue(
      new Error('Redis connection private-detail'),
    );
    const waitResult = await waitFailure.engine.respond(baseInput());
    expect(waitResult.diagnostic?.code).toBe('NOUS_HERMES_QUEUE_UNAVAILABLE');
    expect(waitResult.replyText).not.toMatch(/Redis|private-detail/i);
  });
});

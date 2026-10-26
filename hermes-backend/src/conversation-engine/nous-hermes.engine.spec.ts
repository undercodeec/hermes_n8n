import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesEngine } from './nous-hermes.engine';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';

const baseInput = (
  overrides: Partial<ConversationTurnInput> = {},
): ConversationTurnInput => ({
  conversationId: 'conversation-1',
  inboundMessageId: 'inbound-1',
  normalNousClaim: { turnId: 'turn-1', processingToken: 'token-1' },
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
  function harness(values: Record<string, string> = {}) {
    const waitUntilFinished = jest.fn().mockResolvedValue({
      replyText: 'Respuesta.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-1',
    });
    const queue = {
      add: jest.fn().mockResolvedValue({ waitUntilFinished }),
      getWaitingCount: jest.fn().mockResolvedValue(0),
    };
    const queueEvents = { queueEvents: { id: 'events' } };
    const blockAmbiguous = jest.fn().mockResolvedValue(true);
    const config = {
      get: jest.fn(
        (key: string, fallback?: unknown) => values[key] ?? fallback,
      ),
    };
    const engine = new NousHermesEngine(
      config as unknown as ConfigService,
      queue as unknown as Queue<
        ConversationTurnInput,
        ConversationTurnResult,
        string
      >,
      queueEvents as unknown as NousHermesQueueEvents,
      { blockAmbiguous } as unknown as InboundTurnService,
    );
    return { engine, queue, queueEvents, waitUntilFinished, blockAmbiguous };
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

  it('stops a pinned commercial Nous turn before queueing when disabled', async () => {
    const { engine, queue } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'false',
    });
    const result = await engine.respond(
      baseInput({ assignedEngine: 'nous_hermes' }),
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.diagnostic?.code).toBe('NOUS_PILOT_STOPPED');
  });

  it('signals saturation before adding another commercial request', async () => {
    const { engine, queue } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
    });
    queue.getWaitingCount.mockResolvedValue(5);
    const result = await engine.respond(
      baseInput({ assignedEngine: 'nous_hermes' }),
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.diagnostic?.code).toBe('NOUS_PILOT_SATURATED');
  });

  it('blocks an unknown queued result before the caller can retry', async () => {
    const { engine, waitUntilFinished, blockAmbiguous } = harness();
    waitUntilFinished.mockRejectedValue(new Error('timeout'));
    await expect(engine.respond(baseInput())).rejects.toThrow(
      'NOUS_QUEUE_RESULT_AMBIGUOUS',
    );
    expect(blockAmbiguous).toHaveBeenCalledWith('turn-1', 'token-1', true);
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

  it('blocks a serialized failure without another dispatch', async () => {
    const { engine, waitUntilFinished } = harness();
    waitUntilFinished.mockRejectedValue(new Error('Nous Hermes rate limit'));

    await expect(engine.respond(baseInput())).rejects.toThrow(
      'NOUS_QUEUE_RESULT_AMBIGUOUS',
    );
  });

  it('maps queue-add and wait infrastructure failures safely', async () => {
    const addFailure = harness();
    addFailure.queue.add.mockRejectedValue(
      new Error('Redis password private-detail'),
    );
    await expect(addFailure.engine.respond(baseInput())).rejects.toThrow(
      'NOUS_QUEUE_ADMISSION_AMBIGUOUS',
    );
    expect(addFailure.blockAmbiguous).toHaveBeenCalledWith(
      'turn-1',
      'token-1',
      true,
    );

    const waitFailure = harness();
    waitFailure.waitUntilFinished.mockRejectedValue(
      new Error('Redis connection private-detail'),
    );
    await expect(waitFailure.engine.respond(baseInput())).rejects.toThrow(
      'NOUS_QUEUE_RESULT_AMBIGUOUS',
    );
    expect(waitFailure.blockAmbiguous).toHaveBeenCalledWith(
      'turn-1',
      'token-1',
      true,
    );
  });
});

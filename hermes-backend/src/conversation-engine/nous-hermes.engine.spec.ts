import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesEngine, NousQueuePendingError } from './nous-hermes.engine';
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
      getJob: jest.fn(),
    };
    const queueEvents = { queueEvents: { id: 'events' } };
    const blockAmbiguous = jest.fn().mockResolvedValue(true);
    const markNousQueued = jest.fn().mockResolvedValue(true);
    const readNousResult = jest.fn().mockResolvedValue(null);
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
      {
        blockAmbiguous,
        markNousQueued,
        readNousResult,
      } as unknown as InboundTurnService,
    );
    return {
      engine,
      queue,
      queueEvents,
      waitUntilFinished,
      blockAmbiguous,
      markNousQueued,
      readNousResult,
    };
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

  it.each([5, 10, 20])(
    'alerts but enqueues with %i waiting jobs in monitor mode',
    async (waiting) => {
      const { engine, queue, waitUntilFinished } = harness({
        NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
        NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
      });
      queue.getWaitingCount.mockResolvedValue(waiting);
      const result = await engine.respond(
        baseInput({ assignedEngine: 'nous_hermes' }),
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(waitUntilFinished).toHaveBeenCalledTimes(1);
      expect(result.diagnostic).toBeUndefined();
    },
  );

  it('bounds the original queued job wait without blocking its durable claim', async () => {
    const { engine, queue, waitUntilFinished, blockAmbiguous } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
      NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
    });
    const getState = jest.fn().mockResolvedValue('waiting');
    queue.add.mockResolvedValue({ waitUntilFinished, getState });
    waitUntilFinished.mockRejectedValueOnce(
      new Error(
        'Job wait infer timed out before finishing, no finish notification arrived after 120000ms (id=nous-inbound-1)',
      ),
    );
    await expect(
      engine.respond(baseInput({ assignedEngine: 'nous_hermes' })),
    ).rejects.toBeInstanceOf(NousQueuePendingError);
    expect(waitUntilFinished).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).not.toHaveBeenCalled();
  });

  it('detaches a monitored waiting job after one bounded wait without a second enqueue', async () => {
    const { engine, queue, waitUntilFinished, blockAmbiguous, markNousQueued } =
      harness({
        NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
        NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
      });
    queue.add.mockResolvedValue({
      id: 'nous-inbound-1',
      timestamp: Date.now(),
      waitUntilFinished,
      getState: jest.fn().mockResolvedValue('waiting'),
    });
    waitUntilFinished.mockRejectedValueOnce(
      new Error('Job wait infer timed out before finishing'),
    );
    await expect(
      engine.respond(baseInput({ assignedEngine: 'nous_hermes' })),
    ).rejects.toBeInstanceOf(NousQueuePendingError);
    expect(markNousQueued).toHaveBeenCalledTimes(1);
    expect(waitUntilFinished).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).not.toHaveBeenCalled();
  });

  it('does not admit a job when its durable queue marker cannot be recorded', async () => {
    const { engine, queue, markNousQueued, blockAmbiguous } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
      NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
    });
    markNousQueued.mockResolvedValue(false);
    await expect(
      engine.respond(baseInput({ assignedEngine: 'nous_hermes' })),
    ).rejects.toThrow('NOUS_QUEUE_ADMISSION_AMBIGUOUS');
    expect(queue.add).not.toHaveBeenCalled();
    expect(blockAmbiguous).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed result after its BullMQ completion notification is lost', async () => {
    const { engine, queue, waitUntilFinished, readNousResult, blockAmbiguous } =
      harness({
        NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
        NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
      });
    queue.add.mockResolvedValue({
      id: 'nous-inbound-1',
      waitUntilFinished,
      getState: jest.fn().mockResolvedValue('completed'),
    });
    waitUntilFinished.mockRejectedValue(
      new Error('Job wait infer timed out before finishing'),
    );
    readNousResult.mockResolvedValue({
      replyText: 'Respuesta original.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'synthetic',
      traceId: 'inbound-1',
    });
    const result = await engine.respond(
      baseInput({ assignedEngine: 'nous_hermes' }),
    );
    expect(result.replyText).toBe('Respuesta original.');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).not.toHaveBeenCalled();
  });

  it('recovers a committed result when BullMQ reports a missing completion key', async () => {
    const { engine, queue, waitUntilFinished, readNousResult, blockAmbiguous } =
      harness({
        NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
        NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
      });
    waitUntilFinished.mockRejectedValue(
      new Error('Missing key for job nous-inbound-1'),
    );
    readNousResult.mockResolvedValue({
      replyText: 'Respuesta original.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'synthetic',
      traceId: 'inbound-1',
    });
    const result = await engine.respond(
      baseInput({ assignedEngine: 'nous_hermes' }),
    );
    expect(result.replyText).toBe('Respuesta original.');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).not.toHaveBeenCalled();
  });

  it('keeps an active timed-out job ambiguous and does not enqueue it again', async () => {
    const { engine, queue, waitUntilFinished, blockAmbiguous } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
      NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
    });
    const getState = jest.fn().mockResolvedValue('active');
    queue.add.mockResolvedValue({ waitUntilFinished, getState });
    queue.getJob = jest
      .fn()
      .mockResolvedValue({ processedOn: Date.now() - 120_001 });
    waitUntilFinished.mockRejectedValue(
      new Error('Job wait infer timed out before finishing'),
    );
    await expect(
      engine.respond(baseInput({ assignedEngine: 'nous_hermes' })),
    ).rejects.toThrow('NOUS_QUEUE_RESULT_AMBIGUOUS');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).toHaveBeenCalledWith('turn-1', 'token-1', true);
  });

  it('detaches the same recently active job after its queue wait window expires', async () => {
    const { engine, queue, waitUntilFinished, blockAmbiguous } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
      NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
    });
    const getState = jest.fn().mockResolvedValue('active');
    queue.add.mockResolvedValue({
      waitUntilFinished,
      getState,
      id: 'nous-inbound-1',
      remove: jest.fn(),
    });
    queue.getJob = jest
      .fn()
      .mockResolvedValue({ processedOn: Date.now() - 100 });
    waitUntilFinished.mockRejectedValueOnce(
      new Error('Job wait infer timed out before finishing'),
    );
    await expect(
      engine.respond(baseInput({ assignedEngine: 'nous_hermes' })),
    ).rejects.toBeInstanceOf(NousQueuePendingError);
    expect(waitUntilFinished).toHaveBeenCalledTimes(1);
    expect(blockAmbiguous).not.toHaveBeenCalled();
  });

  it('allows queue admission when only waiting-count observation fails', async () => {
    const { engine, queue } = harness({
      NOUS_PILOT_COMMERCIAL_ENABLED: 'true',
      NOUS_PILOT_BUDGET_MODE: 'MONITOR_ONLY',
    });
    queue.getWaitingCount.mockRejectedValue(new Error('metric unavailable'));
    const result = await engine.respond(
      baseInput({ assignedEngine: 'nous_hermes' }),
    );
    expect(result.diagnostic).toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
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

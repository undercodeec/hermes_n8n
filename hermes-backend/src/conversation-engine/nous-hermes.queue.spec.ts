import type { Job, Queue } from 'bullmq';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesProcessor } from './nous-hermes.processor';
import { NousHermesQueuePolicy } from './nous-hermes.queue-policy';
import {
  NousHermesRateLimitError,
  NousHermesTransport,
} from './nous-hermes.transport';

const baseInput = (): ConversationTurnInput => ({
  conversationId: 'conversation-1',
  inboundMessageId: 'inbound-1',
  customerMessage: 'Hola',
  approvedContext: {
    recentMessages: [],
    approvedKnowledge: [],
    handoffActive: false,
    contactName: 'Ana',
  },
});

const safeTimeoutResult = (): ConversationTurnResult => ({
  replyText: 'Disculpe, no pude completar la respuesta en este momento.',
  proposedActions: [{ type: 'none' }],
  engine: 'nous_hermes',
  providerModel: 'unknown',
  traceId: 'inbound-1',
  diagnostic: {
    category: 'PROVIDER_ERROR',
    code: 'NOUS_HERMES_TIMEOUT',
    summary: 'Request timed out',
    attempts: 1,
    recovered: false,
    requiresHumanReview: true,
  },
});

describe('Nous Hermes queue runtime', () => {
  it('persists global concurrency one at application bootstrap', async () => {
    const queue = { setGlobalConcurrency: jest.fn().mockResolvedValue(1) };
    await new NousHermesQueuePolicy(
      queue as unknown as Queue,
    ).onApplicationBootstrap();
    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
  });

  it('lets BullMQ retry only a typed agent 429', async () => {
    const transport = { execute: jest.fn() };
    const processor = new NousHermesProcessor(
      transport as unknown as NousHermesTransport,
    );
    const queueJob = { data: baseInput() } as Job<ConversationTurnInput>;

    transport.execute.mockRejectedValue(new NousHermesRateLimitError());
    await expect(processor.process(queueJob)).rejects.toBeInstanceOf(
      NousHermesRateLimitError,
    );

    transport.execute.mockResolvedValue(safeTimeoutResult());
    await expect(processor.process(queueJob)).resolves.toEqual(
      safeTimeoutResult(),
    );
  });
});

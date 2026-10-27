import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesProcessor } from './nous-hermes.processor';
import { NousHermesTransport } from './nous-hermes.transport';

describe('durable Nous processor result', () => {
  const result: ConversationTurnResult = {
    replyText: 'Respuesta sintética.',
    proposedActions: [{ type: 'none' }],
    engine: 'nous_hermes',
    providerModel: 'synthetic',
    traceId: 'inbound-1',
  };
  const job = {
    data: {
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
      assignedEngine: 'nous_hermes',
      normalNousClaim: { turnId: 'turn-1', processingToken: 'token-1' },
    },
  } as Job<ConversationTurnInput>;
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'NOUS_PILOT_BUDGET_MODE' ? 'MONITOR_ONLY' : fallback,
  } as ConfigService;

  it('persists the original result before reporting job completion', async () => {
    const execute = jest.fn().mockResolvedValue(result);
    const storeNousResult = jest.fn().mockResolvedValue(true);
    const processor = new NousHermesProcessor(
      { execute } as unknown as NousHermesTransport,
      { storeNousResult } as unknown as InboundTurnService,
      config,
    );
    expect(await processor.process(job)).toEqual(result);
    expect(storeNousResult).toHaveBeenCalledWith({
      turnId: 'turn-1',
      sourceMessageId: 'inbound-1',
      processingToken: 'token-1',
      result,
    });
  });

  it('keeps a result without a durable write from completing', async () => {
    const processor = new NousHermesProcessor(
      {
        execute: jest.fn().mockResolvedValue(result),
      } as unknown as NousHermesTransport,
      {
        storeNousResult: jest.fn().mockResolvedValue(false),
      } as unknown as InboundTurnService,
      config,
    );
    await expect(processor.process(job)).rejects.toThrow(
      'NOUS_RESULT_PERSISTENCE_DENIED',
    );
  });
});

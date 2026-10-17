import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Queue } from 'bullmq';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentOutputValidator } from './agent-output.validator';
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';
import { NousHermesEngine } from './nous-hermes.engine';
import { NousHermesQueueEvents } from './nous-hermes.queue-events';
import { NousHermesTransport } from './nous-hermes.transport';

const input: ConversationTurnInput = {
  conversationId: 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc',
  inboundMessageId: 'source-a',
  customerMessage: 'Consulta sintética',
  singleGenerationCanary: {
    turnId: 'turn-a',
    processingToken: 'token-a',
    generationToken: 'token-a',
  },
  approvedContext: {
    recentMessages: [],
    approvedKnowledge: [],
    handoffActive: false,
    contactName: 'Cliente',
  },
};

const config = {
  get: (_key: string, fallback?: unknown) => fallback,
} as ConfigService;

describe('Nous canary HTTP boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  function transport(
    reserve: jest.Mock,
    prior: jest.Mock = jest.fn().mockResolvedValue(null),
  ) {
    const turns = {
      reserveNousDispatch: reserve,
    } as unknown as InboundTurnService;
    const prisma = {
      inboundTurn: { findFirst: prior },
    } as unknown as PrismaService;
    return new NousHermesTransport(
      config,
      new AgentOutputValidator(),
      { read: jest.fn().mockResolvedValue('synthetic-secret') },
      turns,
      prisma,
    );
  }

  it('admits exactly one HTTP request across duplicate and stalled executions', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Respuesta sintética.' }),
            },
          },
        ],
      },
    });
    const reserve = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const service = transport(reserve);
    await service.execute(input);
    await expect(service.execute(input)).rejects.toThrow(
      'CANARY_NOUS_DISPATCH_DENIED',
    );
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('denies a late job after BLOCKED and an unmarked replay of a reserved source', async () => {
    const post = jest.spyOn(axios, 'post');
    const reserve = jest.fn().mockResolvedValue(false);
    const prior = jest.fn().mockResolvedValue({ id: 'turn-a' });
    const service = transport(reserve, prior);
    await expect(service.execute(input)).rejects.toThrow(
      'CANARY_NOUS_DISPATCH_DENIED',
    );
    await expect(
      service.execute({ ...input, singleGenerationCanary: undefined }),
    ).rejects.toThrow('CANARY_NOUS_RESERVATION_REQUIRED');
    expect(post).not.toHaveBeenCalled();
  });

  it('blocks the turn when the caller times out before the queued job starts', async () => {
    const blockAmbiguous = jest.fn().mockResolvedValue(true);
    const queueAdd = jest.fn().mockResolvedValue({
      waitUntilFinished: jest.fn().mockRejectedValue(new Error('timeout')),
    });
    const queue = { add: queueAdd } as unknown as Queue<
      ConversationTurnInput,
      ConversationTurnResult,
      string
    >;
    const engine = new NousHermesEngine(
      config,
      queue,
      { queueEvents: {} } as NousHermesQueueEvents,
      { blockAmbiguous } as unknown as InboundTurnService,
    );
    await expect(engine.respond(input)).rejects.toThrow(
      'CANARY_NOUS_RESULT_AMBIGUOUS',
    );
    expect(blockAmbiguous).toHaveBeenCalledWith('turn-a', 'token-a');
    expect(queueAdd).toHaveBeenCalledWith(
      'infer',
      input,
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('blocks an ambiguous queue admission before returning to AutoReply', async () => {
    const blockAmbiguous = jest.fn().mockResolvedValue(true);
    const queue = {
      add: jest.fn().mockRejectedValue(new Error('redis dropped')),
    };
    const engine = new NousHermesEngine(
      config,
      queue as unknown as Queue<
        ConversationTurnInput,
        ConversationTurnResult,
        string
      >,
      { queueEvents: {} } as NousHermesQueueEvents,
      { blockAmbiguous } as unknown as InboundTurnService,
    );
    await expect(engine.respond(input)).rejects.toThrow(
      'CANARY_NOUS_QUEUE_AMBIGUOUS',
    );
    expect(blockAmbiguous).toHaveBeenCalledWith('turn-a', 'token-a');
  });
});

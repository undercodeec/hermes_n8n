import { ConfigService } from '@nestjs/config';
import axios, { AxiosAdapter, AxiosError } from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from '../hermes/hermes.service';
import { AgentOutputValidator } from './agent-output.validator';
import { NousHermesTransport } from './nous-hermes.transport';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import type { ConversationTurnInput } from './conversation-engine.types';

const TARGET = 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc';
const CLAIM = {
  turnId: 'turn-qa',
  processingToken: 'token-qa',
  generationToken: 'token-qa',
};
const values: Record<string, string> = {
  F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
  F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: TARGET,
  NOUS_HERMES_MAX_ATTEMPTS: '3',
  HERMES_API_URL: 'http://127.0.0.1:9/v1',
  HERMES_API_KEY: 'synthetic-key',
  HERMES_MODEL: 'synthetic-model',
};
const config = {
  get: (key: string, fallback?: unknown) => values[key] ?? fallback,
} as ConfigService;

function gemini() {
  const dispatched = new Set<string>();
  const prisma = {
    inboundTurn: {
      updateMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          await Promise.resolve();
          if (
            where.id !== CLAIM.turnId ||
            where.conversationId !== TARGET ||
            where.lastMessageId !== 'source-qa' ||
            where.generationSourceMessageId !== 'source-qa' ||
            where.generationToken !== CLAIM.generationToken ||
            where.processingToken !== CLAIM.processingToken ||
            where.generationEngine !== 'gemini_direct' ||
            dispatched.has('source-qa')
          )
            return { count: 0 };
          dispatched.add('source-qa');
          return { count: 1 };
        },
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { generationSourceMessageId: string } }) => {
          await Promise.resolve();
          return dispatched.has(where.generationSourceMessageId)
            ? { id: 'turn-qa' }
            : null;
        },
      ),
    },
    knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const service = new HermesService(config, prisma);
  return { service, prisma, dispatched };
}

const geminiRequest = (conversationId: string, source: string) => ({
  conversationId,
  correlationId: source,
  messageContent: 'Consulta sintética',
  conversationHistory: [],
  ...(conversationId === TARGET ? { singleGenerationCanary: CLAIM } : {}),
});

function nousInput(
  conversationId: string,
  source: string,
): ConversationTurnInput {
  return {
    conversationId,
    inboundMessageId: source,
    customerMessage: source,
    ...(conversationId === TARGET ? { singleGenerationCanary: CLAIM } : {}),
    ...(conversationId !== TARGET
      ? {
          normalNousClaim: {
            turnId: `turn-${source}`,
            processingToken: `token-${source}`,
          },
        }
      : {}),
    approvedContext: {
      recentMessages: [],
      approvedKnowledge: [],
      handoffActive: false,
      contactName: 'Cliente',
    },
  };
}

describe('scoped provider dispatch at the HTTP adapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the unguarded Gemini default at two physical POSTs', async () => {
    values.F3_SINGLE_GENERATION_CANARY_ENABLED = 'false';
    try {
      const { service } = gemini();
      let physicalPosts = 0;
      (
        service as unknown as {
          httpClient: { defaults: { adapter: AxiosAdapter } };
        }
      ).httpClient.defaults.adapter = async (request) => {
        await Promise.resolve();
        physicalPosts++;
        if (physicalPosts === 1) throw new Error('transient');
        return {
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({ response: 'Con gusto le ayudo.' }),
                },
              },
            ],
          },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: request,
        };
      };
      await service.generateResponse(
        geminiRequest('ordinary', 'ordinary-source'),
      );
      expect(physicalPosts).toBe(2);
    } finally {
      values.F3_SINGLE_GENERATION_CANARY_ENABLED = 'true';
    }
  });

  it('runs QA and two non-QA Gemini conversations concurrently at 1/2/2 physical POSTs', async () => {
    const { service } = gemini();
    const posts: Record<string, number> = {};
    const adapter: AxiosAdapter = async (request) => {
      await Promise.resolve();
      const { messages } = JSON.parse(String(request.data)) as {
        messages: Array<{ content: string }>;
      };
      const source = messages.at(-1)!.content;
      posts[source] = (posts[source] ?? 0) + 1;
      if (source === 'QA') expect(request.maxRedirects).toBe(0);
      if (source !== 'QA' && posts[source] === 1) throw new Error('transient');
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({ response: 'Con gusto le ayudo.' }),
              },
            },
          ],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    };
    (
      service as unknown as {
        httpClient: { defaults: { adapter: AxiosAdapter } };
      }
    ).httpClient.defaults.adapter = adapter;
    await Promise.all([
      service.generateResponse({
        ...geminiRequest(TARGET, 'source-qa'),
        messageContent: 'QA',
      }),
      service.generateResponse({
        ...geminiRequest('other-a', 'source-a'),
        messageContent: 'other-a',
      }),
      service.generateResponse({
        ...geminiRequest('other-b', 'source-b'),
        messageContent: 'other-b',
      }),
    ]);
    expect(posts).toEqual({ QA: 1, 'other-a': 2, 'other-b': 2 });
  });

  it.each(['timeout', '429', '500', 'invalid'])(
    'never redispatches Gemini QA after %s',
    async (kind) => {
      const { service } = gemini();
      let physicalPosts = 0;
      (
        service as unknown as {
          httpClient: { defaults: { adapter: AxiosAdapter } };
        }
      ).httpClient.defaults.adapter = async (request) => {
        await Promise.resolve();
        physicalPosts++;
        if (kind === 'invalid')
          return {
            data: { choices: [{ message: { content: 'invalid-json' } }] },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: request,
          };
        throw new AxiosError(
          kind,
          kind === 'timeout' ? 'ECONNABORTED' : undefined,
          request,
          undefined,
          kind === 'timeout'
            ? undefined
            : {
                data: {},
                status: Number(kind),
                statusText: kind,
                headers: {},
                config: request,
              },
        );
      };
      await service.generateResponse(geminiRequest(TARGET, 'source-qa'));
      await expect(
        service.generateResponse(geminiRequest(TARGET, 'source-qa')),
      ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
      expect(physicalPosts).toBe(1);
    },
  );

  it('keeps an already reserved Gemini source closed after the flag goes OFF', async () => {
    const { service } = gemini();
    let physicalPosts = 0;
    (
      service as unknown as {
        httpClient: { defaults: { adapter: AxiosAdapter } };
      }
    ).httpClient.defaults.adapter = async (request) => {
      await Promise.resolve();
      physicalPosts++;
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({ response: 'Con gusto le ayudo.' }),
              },
            },
          ],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    };
    await service.generateResponse(geminiRequest(TARGET, 'source-qa'));
    values.F3_SINGLE_GENERATION_CANARY_ENABLED = 'false';
    try {
      await expect(
        service.generateResponse({
          ...geminiRequest(TARGET, 'source-qa'),
          singleGenerationCanary: undefined,
        }),
      ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
      expect(physicalPosts).toBe(1);
    } finally {
      values.F3_SINGLE_GENERATION_CANARY_ENABLED = 'true';
    }
  });

  it('fails closed before Gemini HTTP for a missing, forged or out-of-scope claim', async () => {
    const { service } = gemini();
    let physicalPosts = 0;
    (
      service as unknown as {
        httpClient: { defaults: { adapter: AxiosAdapter } };
      }
    ).httpClient.defaults.adapter = async (request) => {
      await Promise.resolve();
      physicalPosts++;
      return {
        data: {},
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    };
    const qa = geminiRequest(TARGET, 'source-qa');
    await expect(
      service.generateResponse({ ...qa, singleGenerationCanary: undefined }),
    ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
    await expect(
      service.generateResponse({
        ...qa,
        singleGenerationCanary: {
          ...CLAIM,
          generationToken: 'wrong-token',
        },
      }),
    ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
    await expect(
      service.generateResponse({
        ...geminiRequest('other-conversation', 'other-source'),
        singleGenerationCanary: CLAIM,
      }),
    ).rejects.toThrow('CANARY_GEMINI_DISPATCH_DENIED');
    expect(physicalPosts).toBe(0);
  });

  it('keeps Nous QA and each ordinary inbound at one HTTP dispatch', async () => {
    const dispatched = new Set<string>();
    const turns = {
      reserveNousDispatch: jest.fn(
        async ({ sourceMessageId }: { sourceMessageId: string }) => {
          await Promise.resolve();
          if (dispatched.has(sourceMessageId)) return false;
          dispatched.add(sourceMessageId);
          return true;
        },
      ),
    } as unknown as InboundTurnService;
    const prisma = {
      inboundTurn: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const transport = new NousHermesTransport(
      config,
      new AgentOutputValidator(),
      { read: jest.fn().mockResolvedValue('synthetic-secret') },
      turns,
      prisma,
    );
    const previousAdapter = axios.defaults.adapter;
    const posts: Record<string, number> = {};
    axios.defaults.adapter = async (request) => {
      await Promise.resolve();
      const body = JSON.parse(String(request.data)) as {
        messages: Array<{ content: string }>;
      };
      const state = JSON.parse(body.messages.at(-1)!.content) as {
        customerMessage: string;
      };
      const source = state.customerMessage;
      posts[source] = (posts[source] ?? 0) + 1;
      throw new AxiosError('rate limited', undefined, request, undefined, {
        data: {},
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        config: request,
      });
    };
    try {
      const qa = nousInput(TARGET, 'source-qa');
      const a = nousInput('other-a', 'source-a');
      const b = nousInput('other-b', 'source-b');
      await Promise.all([
        transport.execute(qa).catch(() => undefined),
        (async () => {
          for (let n = 0; n < 3; n++)
            await transport.execute(a).catch(() => undefined);
        })(),
        (async () => {
          for (let n = 0; n < 3; n++)
            await transport.execute(b).catch(() => undefined);
        })(),
      ]);
      await expect(transport.execute(qa)).rejects.toThrow(
        'CANARY_NOUS_DISPATCH_DENIED',
      );
      expect(posts).toEqual({ 'source-qa': 1, 'source-a': 1, 'source-b': 1 });
    } finally {
      axios.defaults.adapter = previousAdapter;
    }
  });
});

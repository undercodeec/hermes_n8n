import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from './hermes.service';

const target = 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc';
const claim = {
  turnId: 'synthetic-turn',
  processingToken: 'synthetic-token',
  generationToken: 'synthetic-token',
};

function setup(enabled: boolean, shortSystemPrompt = false) {
  const values: Record<string, string> = {
    F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
    F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: target,
    F3_GEMINI_CAPS_ENABLED: String(enabled),
    HERMES_MODEL: 'gemini-3-synthetic',
    HERMES_API_URL: 'http://127.0.0.1:9/v1',
    HERMES_API_KEY: 'synthetic-key',
    HERMES_MAX_OUTPUT_TOKENS: '2048',
  };
  const config = {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as ConfigService;
  const reserve = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    inboundTurn: { updateMany: reserve },
    knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const service = new HermesService(config, prisma);
  if (shortSystemPrompt) {
    (service as unknown as { systemPrompt: string }).systemPrompt =
      'Synthetic system instruction.';
  }
  const post = jest.fn().mockResolvedValue({
    data: { choices: [{ message: { content: '{"response":"Hola."}' } }] },
  });
  (service as unknown as { httpClient: { post: jest.Mock } }).httpClient.post =
    post;
  return { service, post, reserve };
}

const request = (messageContent: string) => ({
  conversationId: target,
  correlationId: 'synthetic-source',
  singleGenerationCanary: claim,
  messageContent,
  conversationHistory: [],
});

describe('F3 Gemini local caps preflight', () => {
  it('blocks when the new budget quote is absent before reservation and provider dispatch', async () => {
    const { service, post, reserve } = setup(true);
    const result = await service.generateResponse(request('x'.repeat(13000)));
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(post).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('blocks a short final request when the total USD 1 cap has no certified bound', async () => {
    const { service, post, reserve } = setup(true, true);
    const result = await service.generateResponse(
      request('Consulta sintética'),
    );
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(post).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('preserves the previous provider request when the new cap flag is off', async () => {
    const { service, post } = setup(false);
    await service.generateResponse(request('Consulta sintética'));
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      (post.mock.calls as Array<[string, { max_tokens: number }]>)[0][1]
        .max_tokens,
    ).toBe(2048);
  });
});

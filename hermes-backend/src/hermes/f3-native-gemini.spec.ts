import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from './hermes.service';

const target = 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc';
const model = 'gemini-3-synthetic';
const budget = {
  model,
  targetConversationId: target,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
  serviceWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  channel: 'CLOUD_API',
  category: 'SERVICE',
  sourceUrl: 'https://example.test/audited-prices',
  auditedAt: new Date().toISOString(),
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  countCallUsdMax: 0.001,
  metaUsdPerPartMax: 0.01,
  bspUsdPerPartMax: 0.01,
  marginUsd: 0.1,
  maxParts: 9,
};

function setup(override: Record<string, unknown> = {}) {
  const values: Record<string, string> = {
    F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
    F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: target,
    F3_GEMINI_CAPS_ENABLED: 'true',
    F3_GEMINI_BUDGET_JSON: JSON.stringify({ ...budget, ...override }),
    F3_GEMINI_API_KEY: 'synthetic-key',
    HERMES_MODEL: model,
    HERMES_MAX_OUTPUT_TOKENS: '2048',
  };
  const config = {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as ConfigService;
  const reserve = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    inboundTurn: {
      updateMany: reserve,
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    ),
    knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const service = new HermesService(config, prisma);
  const count = jest.fn().mockResolvedValue({ data: { totalTokens: 11999 } });
  const generate = jest.fn().mockResolvedValue({
    data: {
      modelVersion: model,
      candidates: [
        {
          content: { parts: [{ text: '{"response":"Hola."}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 11999,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
        totalTokenCount: 12005,
      },
    },
  });
  const nativePost = jest.fn(
    (url: string, body: string): Promise<unknown> =>
      url.endsWith(':countTokens')
        ? (count(url, body) as Promise<unknown>)
        : (generate(url, body) as Promise<unknown>),
  );
  (service as unknown as { nativeClient: { post: jest.Mock } }).nativeClient = {
    post: nativePost,
  };
  (service as unknown as { httpClient: { post: jest.Mock } }).httpClient.post =
    jest.fn(() => {
      throw new Error('legacy provider reached');
    });
  const request = {
    conversationId: target,
    canaryServiceWindowExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    canaryReceivedAt: new Date().toISOString(),
    correlationId: 'synthetic-source',
    singleGenerationCanary: {
      turnId: 'synthetic-turn',
      processingToken: 'synthetic-token',
      generationToken: 'synthetic-token',
    },
    messageContent: 'Consulta sintética',
    conversationHistory: [{ role: 'assistant', content: 'Mensaje anterior' }],
    approvedLearning: [
      { id: 'approved-1', version: 1, content: 'Orientación aprobada' },
    ],
  };
  return { service, prisma, reserve, count, generate, nativePost, request };
}

function estimatedSetup() {
  const result = setup();
  const values = {
    F3_GEMINI_BUDGET_MODE: 'estimated',
    F3_GEMINI_CANARY_WINDOW_START_UTC: new Date(
      Date.now() - 30_000,
    ).toISOString(),
    F3_GEMINI_ESTIMATE_JSON: JSON.stringify({
      model: 'gemini-3.8-flash',
      targetConversationId: target,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      auditedAt: new Date().toISOString(),
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 3.75,
      maxParts: 9,
    }),
    HERMES_MODEL: 'gemini-3.8-flash',
  };
  const serviceConfig = (
    result.service as unknown as { configService: ConfigService }
  ).configService;
  const originalGet = serviceConfig.get.bind(serviceConfig);
  (serviceConfig as unknown as { get: jest.Mock }).get = jest.fn(
    (key: string, fallback?: unknown) =>
      (values as Record<string, string>)[key] ?? originalGet(key, fallback),
  );
  (result.service as unknown as { model: string }).model = 'gemini-3.8-flash';
  result.request.canaryReceivedAt = new Date().toISOString();
  result.count.mockResolvedValue({ data: { totalTokens: 10000 } });
  result.generate.mockResolvedValue({
    data: {
      modelVersion: 'gemini-3.8-flash',
      responseId: 'safe-request-id',
      candidates: [
        {
          content: { parts: [{ text: '{"response":"Hola."}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10001,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
      },
    },
  });
  return { ...result, values };
}

describe('F3 native Gemini canary', () => {
  it('allows a 30-minute estimated window for the exact new F3 inbound', async () => {
    const { service, request, generate } = estimatedSetup();
    const result = await service.generateResponse(request);
    expect(result.response).toBe('Hola.');
    expect(result.f3CapsBudget?.mode).toBe('ESTIMATED');
    expect(result.f3CapsBudget?.upperBoundUsd).toBeNull();
    expect(result.costEstimate).toBe((10001 * 0.75 + 6 * 3.75) / 1_000_000);
    expect(result.f3CallTrace).toEqual(
      expect.objectContaining({
        requestId: 'safe-request-id',
        sourceMessageId: 'synthetic-source',
        model: 'gemini-3.8-flash',
        countTokenCount: 10000,
        promptTokenCount: 10001,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
        countUsageDelta: 1,
        estimatedGeminiUsd: (10001 * 0.75 + 6 * 3.75) / 1_000_000,
        metaBspUsd: null,
      }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('blocks estimated mode when prior count exceeds its 10000-token margin', async () => {
    const { service, request, count, generate } = estimatedSetup();
    count.mockResolvedValue({ data: { totalTokens: 10001 } });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('INPUT_12000_NOT_ENFORCEABLE');
    expect(generate).not.toHaveBeenCalled();
  });

  it('blocks an old source message in estimated mode', async () => {
    const { service, request, count } = estimatedSetup();
    request.canaryReceivedAt = new Date(Date.now() - 60_000).toISOString();
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });

  it('blocks an expired estimated activation window before count', async () => {
    const { service, request, count, values } = estimatedSetup();
    values.F3_GEMINI_CANARY_WINDOW_START_UTC = new Date(
      Date.now() - 31 * 60_000,
    ).toISOString();
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });

  it('blocks estimated mode for a mismatched target and unaudited rate', async () => {
    const { service, request, count, values } = estimatedSetup();
    values.F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID = 'another-target';
    let result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    values.F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID = target;
    const estimate = JSON.parse(values.F3_GEMINI_ESTIMATE_JSON) as Record<
      string,
      unknown
    >;
    estimate.inputUsdPerMillion = 0.01;
    values.F3_GEMINI_ESTIMATE_JSON = JSON.stringify(estimate);
    result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });
  it('counts the same final request and model before one generation', async () => {
    const { service, count, generate, nativePost, request, reserve } = setup();
    const result = await service.generateResponse(request);
    expect(result.response).toBe('Hola.');
    expect(result.learningExposed).toEqual([{ id: 'approved-1', version: 1 }]);
    expect(result.f3CapsBudget?.maxParts).toBe(9);
    expect(count).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    const counted = (
      JSON.parse((count.mock.calls as Array<[string, string]>)[0][1]) as {
        generateContentRequest: {
          model: string;
          generationConfig: { maxOutputTokens: number };
        };
      }
    ).generateContentRequest;
    const generated = JSON.parse(
      (generate.mock.calls as Array<[string, string]>)[0][1],
    ) as {
      generationConfig: { maxOutputTokens: number };
    };
    expect(counted.model).toBe(`models/${model}`);
    expect(counted).toEqual({ model: `models/${model}`, ...generated });
    expect(generated).not.toHaveProperty('model');
    expect(generated.generationConfig).toEqual({ maxOutputTokens: 1500 });
    expect(generated.generationConfig.maxOutputTokens).toBe(1500);
    expect(JSON.stringify(generated)).toContain('Orientación aprobada');
    expect(
      (nativePost.mock.calls as Array<[string, string]>).map((call) => call[0]),
    ).toEqual([
      `/models/${model}:countTokens`,
      `/models/${model}:generateContent`,
    ]);
  });

  it('keeps the counted payload when upstream request data changes during count', async () => {
    const { service, count, generate, request } = setup();
    count.mockImplementationOnce(() => {
      request.messageContent = 'Contenido mutado';
      return Promise.resolve({ data: { totalTokens: 20 } });
    });
    await service.generateResponse(request);
    const counted = (
      JSON.parse((count.mock.calls as Array<[string, string]>)[0][1]) as {
        generateContentRequest: unknown;
      }
    ).generateContentRequest;
    const generated = JSON.parse(
      (generate.mock.calls as Array<[string, string]>)[0][1],
    ) as unknown;
    expect(counted).toEqual({
      model: `models/${model}`,
      ...(generated as object),
    });
    expect(JSON.stringify(generated)).toContain('Consulta sintética');
    expect(JSON.stringify(generated)).not.toContain('Contenido mutado');
  });

  it.each([12000, 12001])(
    'enforces count boundary at %i',
    async (totalTokens) => {
      const { service, count, generate, request } = setup();
      count.mockResolvedValue({ data: { totalTokens } });
      const result = await service.generateResponse(request);
      expect(generate).toHaveBeenCalledTimes(totalTokens === 12000 ? 1 : 0);
      if (totalTokens === 12001)
        expect(result.diagnostic?.code).toBe('INPUT_12000_NOT_ENFORCEABLE');
    },
  );

  it.each([0, -1, '120', null, undefined])(
    'blocks invalid count %s',
    async (totalTokens) => {
      const { service, count, generate, request, reserve } = setup();
      count.mockResolvedValue({ data: { totalTokens } });
      const result = await service.generateResponse(request);
      expect(result.diagnostic?.code).toBe('INPUT_12000_NOT_ENFORCEABLE');
      expect(generate).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('blocks an unpriced delivery before token count', async () => {
    const { service, count, request } = setup({ bspUsdPerPartMax: null });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });

  it('blocks a canary outside the actual inbound service window', async () => {
    const { service, count, request } = setup();
    request.canaryServiceWindowExpiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });

  it('blocks a quote above USD 1 before token count', async () => {
    const { service, count, request } = setup({ metaUsdPerPartMax: 1 });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown Meta category', { category: 'UNKNOWN' }],
    ['unknown channel', { channel: 'BSP_UNKNOWN' }],
    [
      'expired service window',
      { serviceWindowExpiresAt: new Date(Date.now() - 1_000).toISOString() },
    ],
    ['unknown Gemini input rate', { inputUsdPerMillion: null }],
    ['wrong model', { model: 'gemini-other' }],
  ])('blocks %s before any native request', async (_label, override) => {
    const { service, count, generate, request } = setup(override);
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(count).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not generate after a count timeout', async () => {
    const { service, count, generate, request, reserve } = setup();
    count.mockRejectedValueOnce(new Error('synthetic timeout'));
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('INPUT_12000_NOT_ENFORCEABLE');
    expect(generate).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('blocks a response whose visible and thinking tokens exceed 1500', async () => {
    const { service, generate, request } = setup();
    generate.mockResolvedValueOnce({
      data: {
        modelVersion: model,
        candidates: [
          {
            content: { parts: [{ text: '{"response":"Hola."}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 1401,
        },
      },
    });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('OUTPUT_1500_NOT_ENFORCEABLE');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed native generation', async () => {
    const { service, generate, request } = setup();
    generate.mockRejectedValueOnce(new Error('synthetic disconnect'));
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('F3_NATIVE_GENERATION_UNAVAILABLE');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not reserve a second generation for the target after an earlier F3 dispatch', async () => {
    const { service, prisma, reserve, generate, request } = setup();
    (prisma.inboundTurn.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 'earlier-turn',
    });
    await expect(service.generateResponse(request)).rejects.toThrow(
      'CANARY_GEMINI_DISPATCH_DENIED',
    );
    expect(generate).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('suppresses a generated result from a different model', async () => {
    const { service, generate, request } = setup();
    generate.mockResolvedValue({
      data: {
        modelVersion: 'other',
        candidates: [
          {
            content: { parts: [{ text: '{"response":"Hola."}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 2,
        },
      },
    });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('INPUT_12000_NOT_ENFORCEABLE');
  });

  it('accepts the REST modelVersion with its models/ prefix', async () => {
    const { service, generate, request } = setup();
    const data = (await generate.getMockImplementation()?.('', '')) as {
      data: Record<string, unknown>;
    };
    generate.mockResolvedValueOnce({
      data: { ...data.data, modelVersion: `models/${model}` },
    });
    const result = await service.generateResponse(request);
    expect(result.response).toBe('Hola.');
  });

  it('does not generate if the budget expires while counting', async () => {
    const { service, count, generate, request, reserve } = setup({
      validUntil: new Date(Date.now() + 40).toISOString(),
    });
    count.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { data: { totalTokens: 20 } };
    });
    const result = await service.generateResponse(request);
    expect(result.diagnostic?.code).toBe('COST_CAP_NOT_ENFORCEABLE');
    expect(generate).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});

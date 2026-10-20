import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosAdapter, AxiosError, AxiosRequestConfig } from 'axios';
import { inspect } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from './hermes.service';

const marker = {
  message: 'FAKE_PROMPT_DO_NOT_USE',
  provider: 'FAKE_PII_DO_NOT_USE',
  body: 'FAKE_BODY_DO_NOT_USE',
  url: 'FAKE_URL_SECRET_DO_NOT_USE',
  header: 'FAKE_API_TOKEN_DO_NOT_USE',
  stack: 'FAKE_STACK_DO_NOT_USE',
  cause: 'FAKE_CAUSE_DO_NOT_USE',
  json: 'FAKE_JSON_DO_NOT_USE',
  code: 'FAKE_CODE_DO_NOT_USE',
  status: 'FAKE_STATUS_DO_NOT_USE',
  finish: 'FAKE_FINISH_REASON_DO_NOT_USE',
  correlation: 'FAKE_CORRELATION_DO_NOT_USE',
};

const config = {
  get: (key: string, fallback?: unknown) =>
    ({
      HERMES_API_URL: 'http://127.0.0.1:9/v1',
      HERMES_API_KEY: 'synthetic-key',
      HERMES_MODEL: 'gemini-3-synthetic',
      HERMES_COMPLETION_ATTEMPTS: '2',
    })[key as 'HERMES_API_URL'] ?? fallback,
} as ConfigService;

function harness(adapter: AxiosAdapter) {
  const calls: unknown[][] = [];
  for (const level of ['error', 'warn', 'log'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((...args: unknown[]) => {
        calls.push([level, ...args]);
      });
  }
  const service = new HermesService(config, {} as PrismaService);
  jest
    .spyOn(service as never, 'loadBusinessContext' as never)
    .mockResolvedValue('' as never);
  jest
    .spyOn(service as never, 'reserveProviderDispatch' as never)
    .mockResolvedValue(undefined as never);
  (
    service as unknown as {
      httpClient: { defaults: { adapter: AxiosAdapter } };
    }
  ).httpClient.defaults.adapter = adapter;
  return { service, calls };
}

const request = () => ({
  conversationId: '00000000-0000-4000-8000-000000000001',
  correlationId: marker.correlation,
  messageContent: 'Synthetic request',
  conversationHistory: [],
});

function syntheticError(
  cfg: AxiosRequestConfig,
  status?: number | string,
  code = marker.code,
) {
  const poisonedConfig = {
    ...cfg,
    url: `http://127.0.0.1:9/${marker.url}`,
    data: marker.message,
    headers: { ...cfg.headers, Authorization: marker.header },
  } as AxiosRequestConfig;
  const response =
    status === undefined
      ? undefined
      : {
          data: {
            error: {
              message: marker.provider,
              nested: { prompt: marker.body },
            },
          },
          status: status as number,
          statusText: marker.body,
          headers: { 'X-Test': marker.header },
          config: cfg,
        };
  const error = new AxiosError(
    marker.message,
    code,
    poisonedConfig,
    undefined,
    response,
  );
  error.stack = marker.stack;
  error.cause = { message: marker.cause, nested: { token: marker.header } };
  error.toJSON = () => ({ hidden: marker.json });
  return error;
}

function assertNoMarkers(calls: unknown[][]) {
  const output = JSON.stringify(calls) + inspect(calls, { depth: 10 });
  for (const value of Object.values(marker))
    expect(output).not.toContain(value);
}

function fields(calls: unknown[][]) {
  return calls.map(([level, value]) => {
    expect(typeof value).toBe('string');
    return {
      level,
      payload: JSON.parse(value as string) as Record<string, unknown>,
    };
  });
}

describe('Gate D-R synthetic Gemini logger regression', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { name: '429', status: 429, code: marker.code, category: 'RATE_LIMIT' },
    { name: '500', status: 500, code: marker.code, category: 'UPSTREAM_5XX' },
    {
      name: 'timeout',
      status: undefined,
      code: 'ECONNABORTED',
      category: 'TIMEOUT',
    },
    {
      name: 'network',
      status: undefined,
      code: marker.code,
      category: 'TRANSPORT_ERROR',
    },
    {
      name: 'invalid status',
      status: marker.status,
      code: marker.code,
      category: 'TRANSPORT_ERROR',
    },
  ])(
    'sanitizes the real retry and final catch for $name',
    async ({ status, code, category }) => {
      let posts = 0;
      const { service, calls } = harness(async (cfg) => {
        posts++;
        throw syntheticError(cfg, status, code);
      });
      const result = await service.generateResponse(request());
      expect(posts).toBe(2);
      expect(result).toMatchObject({
        response: 'Disculpe, no pude completar la respuesta en este momento.',
        tokensUsed: 0,
        costEstimate: 0,
        detectedIntent: 'error',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          attempts: 2,
          recovered: false,
          requiresHumanReview: true,
        },
      });
      expect(calls.map((call) => call[0])).toEqual(['warn', 'error']);
      assertNoMarkers(calls);
      const logged = fields(calls);
      expect(logged[0].payload).toEqual({
        event: 'hermes_completion_retry',
        attempt: 1,
        category,
        ...(typeof status === 'number' ? { httpStatus: status } : {}),
      });
      expect(logged[1].payload).toEqual({
        event: 'hermes_completion_failed',
        category,
        ...(typeof status === 'number' ? { httpStatus: status } : {}),
      });
    },
  );

  it('does not print an arbitrary finish reason or malformed provider response', async () => {
    const { service, calls } = harness(async (cfg) => ({
      data: {
        choices: [
          {
            finish_reason: marker.finish,
            message: { content: marker.message },
          },
        ],
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: cfg,
    }));
    const result = await service.generateResponse(request());
    expect(result.diagnostic?.category).toBe('INVALID_PROVIDER_RESPONSE');
    expect(calls.map((call) => call[0])).toEqual(['warn', 'error']);
    assertNoMarkers(calls);
  });

  it('keeps generic exception messages, stack and cause out of both logs', async () => {
    const { service, calls } = harness(async () => {
      const error = new Error(marker.message);
      error.stack = marker.stack;
      error.cause = { nested: marker.cause };
      throw error;
    });
    await service.generateResponse(request());
    expect(fields(calls).map((entry) => entry.payload.category)).toEqual([
      'GENERATION_ERROR',
      'GENERATION_ERROR',
    ]);
    assertNoMarkers(calls);
  });

  it('keeps a synthetic single-generation turn at one POST and one safe error log', async () => {
    let posts = 0;
    const { service, calls } = harness(async (cfg) => {
      posts++;
      throw syntheticError(cfg, 429);
    });
    const result = await service.generateResponse({
      ...request(),
      singleGenerationCanary: {
        turnId: 'synthetic-turn',
        processingToken: 'synthetic-processing-token',
        generationToken: 'synthetic-processing-token',
      },
    });
    expect(posts).toBe(1);
    expect(result.diagnostic?.attempts).toBe(1);
    expect(calls.map((call) => call[0])).toEqual(['error']);
    expect(fields(calls)[0].payload).toEqual({
      event: 'hermes_completion_failed',
      category: 'RATE_LIMIT',
      httpStatus: 429,
    });
    assertNoMarkers(calls);
  });

  it('preserves the successful response and its existing log event', async () => {
    let posts = 0;
    const { service, calls } = harness(async (cfg) => {
      posts++;
      return {
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({ response: 'Respuesta sintética.' }),
              },
            },
          ],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: cfg,
      };
    });
    const result = await service.generateResponse({
      ...request(),
      correlationId: 'synthetic-source',
    });
    expect(posts).toBe(1);
    expect(result.response).toBe('Respuesta sintética.');
    expect(result.diagnostic).toBeUndefined();
    expect(calls.map((call) => call[0])).toEqual(['log']);
    expect(fields(calls)[0].payload.event).toBe('hermes_response_generated');
  });
});

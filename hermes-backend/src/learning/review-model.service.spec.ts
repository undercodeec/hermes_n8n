import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ReviewModelService } from './review-model.service';

const messages = [{ id: 'm1', sender: 'CONTACT', content: 'Dato sintético' }];
const valid = {
  issueCode: 'REPETITION',
  summary: 'Falta evidencia para una pauta',
  counterexample: null,
  confidence: 0.5,
  candidate: null,
};

describe('review provider JSON contract', () => {
  let post: jest.SpyInstance;
  let service: ReviewModelService;

  beforeEach(() => {
    service = new ReviewModelService({
      get: (name: string, fallback?: string) =>
        ({
          HERMES_API_URL: 'http://127.0.0.1:1/v1',
          HERMES_API_KEY: 'synthetic-only',
          LEARNING_REVIEW_MODEL: 'gemini-3.8-flash',
        })[name] ?? fallback,
    } as ConfigService);
    post = jest.spyOn(axios, 'post');
  });

  afterEach(() => jest.restoreAllMocks());

  async function respond(content: string, finishReason = 'stop') {
    post.mockResolvedValue({
      data: {
        choices: [{ finish_reason: finishReason, message: { content } }],
      },
    });
    return service.review(messages, 'REPETITION', null);
  }

  it('requests native schema through the existing OpenAI-compatible endpoint', async () => {
    await respond(JSON.stringify(valid));
    const calls = post.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    const body = calls[0][1];
    const format = body.response_format as {
      type: string;
      json_schema: {
        strict: boolean;
        schema: { additionalProperties: boolean };
      };
    };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBeUndefined();
  });

  it.each([
    ['truncated JSON', '{"issueCode":', 'REVIEW_PROVIDER_JSON'],
    ['empty text', '', 'REVIEW_PROVIDER_EMPTY'],
    [
      'fenced JSON',
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      'REVIEW_PROVIDER_JSON',
    ],
    [
      'surrounding text',
      `antes ${JSON.stringify(valid)} después`,
      'REVIEW_PROVIDER_JSON',
    ],
    [
      'valid JSON, wrong schema',
      JSON.stringify({ ...valid, summary: 12 }),
      'REVIEW_OUTPUT_INVALID',
    ],
    [
      'unknown top-level field',
      JSON.stringify({ ...valid, price: 'free' }),
      'REVIEW_OUTPUT_INVALID',
    ],
    [
      'invalid candidate evidence',
      JSON.stringify({
        ...valid,
        candidate: {
          kind: 'STYLE',
          trigger: 'Cambio',
          guidance: 'Confirmar',
          evidenceMessageIds: ['m2'],
        },
      }),
      'REVIEW_CANDIDATE_INVALID',
    ],
    [
      'forbidden commercial candidate',
      JSON.stringify({
        ...valid,
        candidate: {
          kind: 'STYLE',
          trigger: 'Cambio',
          guidance: 'Ofrecer 20% de descuento',
          evidenceMessageIds: ['m1'],
        },
      }),
      'COMMERCIAL_VALIDATION_FAILED',
    ],
  ])('rejects %s', async (_label, content, code) => {
    await expect(respond(content)).rejects.toThrow(code);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('distinguishes provider truncation from JSON syntax failure', async () => {
    await expect(respond('{', 'length')).rejects.toThrow(
      'REVIEW_PROVIDER_TRUNCATED',
    );
  });

  it('rejects a safety or error finish reason even with valid JSON content', async () => {
    await expect(
      respond(JSON.stringify(valid), 'content_filter'),
    ).rejects.toThrow('REVIEW_PROVIDER_FINISH');
  });

  it('accepts a valid candidate only with allowed evidence aliases', async () => {
    const output = await respond(
      JSON.stringify({
        ...valid,
        candidate: {
          kind: 'STYLE',
          trigger: 'Cambio de dato',
          guidance: 'Confirmar el dato más reciente',
          serviceCode: null,
          market: null,
          evidenceMessageIds: ['m1'],
        },
      }),
    );
    expect(output.candidate?.evidenceMessageIds).toEqual(['m1']);
  });
});

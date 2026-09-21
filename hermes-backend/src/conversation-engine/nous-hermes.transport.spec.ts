import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AgentOutputValidator } from './agent-output.validator';
import {
  NOUS_HERMES_ENDPOINT,
  NOUS_HERMES_MODEL,
} from './nous-hermes.constants';
import {
  NousHermesRateLimitError,
  NousHermesTransport,
} from './nous-hermes.transport';
import type { ConversationTurnInput } from './conversation-engine.types';

const baseInput = (
  overrides: Partial<ConversationTurnInput> = {},
): ConversationTurnInput => ({
  conversationId: 'conversation-a',
  inboundMessageId: 'inbound-1',
  customerMessage: 'canary-a',
  approvedContext: {
    recentMessages: [{ role: 'assistant', text: 'Contexto previo' }],
    commercialProfile: { sector: 'servicios', company: 'dato privado' },
    approvedKnowledge: ['Landing publicada: USD $250'],
    handoffActive: false,
    contactName: 'Ana',
  },
  ...overrides,
});

const inputFor = (conversationId: string, customerMessage: string) =>
  baseInput({
    conversationId,
    inboundMessageId: `inbound-${conversationId}`,
    customerMessage,
    approvedContext: {
      ...baseInput().approvedContext,
      recentMessages: [{ role: 'user', text: customerMessage }],
    },
  });

describe('NousHermesTransport', () => {
  let post: jest.SpiedFunction<typeof axios.post>;
  let secretReader: { read: jest.Mock };

  beforeEach(() => {
    post = jest.spyOn(axios, 'post');
    secretReader = { read: jest.fn().mockResolvedValue('file-secret\n') };
  });

  afterEach(() => jest.restoreAllMocks());

  function configuredTransport(
    values: Record<string, string | number | undefined> = {},
  ) {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        values[key] === undefined ? fallback : values[key],
      ),
    } as unknown as ConfigService;
    return new NousHermesTransport(
      config,
      new AgentOutputValidator(),
      secretReader,
    );
  }

  it('uses only the exact alias, stateless messages, and minimal headers', async () => {
    post.mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          { finish_reason: 'stop', message: { content: 'Respuesta.' } },
        ],
      },
    });
    const result = await configuredTransport().execute(baseInput());
    expect(post).toHaveBeenCalledWith(
      NOUS_HERMES_ENDPOINT,
      expect.objectContaining({ model: NOUS_HERMES_MODEL, stream: false }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer file-secret',
          'Content-Type': 'application/json',
        },
        maxRedirects: 0,
      }),
    );
    expect(JSON.stringify(post.mock.calls[0][2])).not.toMatch(
      /X-Hermes-Session|X-Hermes-Conversation|X-Hermes-Trace/i,
    );
    expect(result.providerModel).toBe('hermes-agent');
  });

  it.each([
    'https://nous-hermes-api:8642/v1/chat/completions',
    'http://public.example/v1/chat/completions',
    'http://nous-hermes-api:8642/v1/chat/completions?x=1',
    'http://user@nous-hermes-api:8642/v1/chat/completions',
  ])(
    'rejects any destination outside the exact private contract: %s',
    async (url) => {
      const result = await configuredTransport({
        NOUS_HERMES_CHAT_COMPLETIONS_URL: url,
      }).execute(baseInput());
      expect(post).not.toHaveBeenCalled();
      expect(result.diagnostic?.code).toBe('NOUS_HERMES_CONFIGURATION_INVALID');
    },
  );

  it('reads and trims the mounted secret without logging it', async () => {
    post.mockResolvedValue({
      data: {
        choices: [
          { finish_reason: 'stop', message: { content: 'Respuesta.' } },
        ],
      },
    });
    await configuredTransport().execute(baseInput());
    expect(secretReader.read).toHaveBeenCalledWith(
      '/run/secrets/nous_hermes_api_key',
    );
  });

  it('throws a typed rate limit for queue retry and maps other failures safely', async () => {
    post.mockRejectedValueOnce({ response: { status: 429 } });
    await expect(
      configuredTransport().execute(baseInput()),
    ).rejects.toBeInstanceOf(NousHermesRateLimitError);
    post.mockRejectedValueOnce({ response: { status: 500 } });
    const result = await configuredTransport().execute(baseInput());
    expect(result.diagnostic?.code).toBe('NOUS_HERMES_UNAVAILABLE');
  });

  it.each([
    [401, 'NOUS_HERMES_AUTH_REJECTED'],
    [403, 'NOUS_HERMES_AUTH_REJECTED'],
    [500, 'NOUS_HERMES_UNAVAILABLE'],
  ])('maps HTTP %i to %s without provider detail', async (status, code) => {
    post.mockRejectedValue({
      response: {
        status,
        data: { error: { message: 'private-provider-detail' } },
      },
    });
    const result = await configuredTransport().execute(baseInput());
    expect(result.diagnostic?.code).toBe(code);
    expect(result.replyText).not.toContain('private-provider-detail');
  });

  it.each([
    { choices: [] },
    { error: { message: 'failed' }, choices: [] },
    {
      choices: [{ finish_reason: 'error', message: { content: 'failed' } }],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'x', tool_calls: [{}] },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'x', reasoning_content: 'hidden' },
        },
      ],
    },
  ])('rejects malformed or privileged completion %#', async (data) => {
    post.mockResolvedValue({ data });
    const result = await configuredTransport().execute(baseInput());
    expect(result.diagnostic?.code).toBe('NOUS_HERMES_INVALID_RESPONSE');
  });

  it('maps timeout and an absent secret file safely', async () => {
    post.mockRejectedValueOnce({ code: 'ECONNABORTED' });
    expect(
      (await configuredTransport().execute(baseInput())).diagnostic?.code,
    ).toBe('NOUS_HERMES_TIMEOUT');
    secretReader.read.mockRejectedValueOnce(new Error('ENOENT /private/path'));
    const missing = await configuredTransport().execute(baseInput());
    expect(missing.diagnostic?.code).toBe('NOUS_HERMES_CONFIGURATION_INVALID');
    expect(missing.replyText).not.toContain('/private/path');
  });

  it('keeps two request histories disjoint and distrusts a mismatched model', async () => {
    post
      .mockResolvedValueOnce({
        data: {
          model: 'different-model',
          choices: [{ finish_reason: 'stop', message: { content: 'A' } }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          model: 'hermes-agent',
          choices: [{ finish_reason: 'stop', message: { content: 'B' } }],
        },
      });
    const first = await configuredTransport().execute(
      inputFor('conversation-a', 'canary-a'),
    );
    const second = await configuredTransport().execute(
      inputFor('conversation-b', 'canary-b'),
    );
    expect(first.providerModel).toBe('unknown');
    expect(JSON.stringify(post.mock.calls[0][1])).toContain('canary-a');
    expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('canary-b');
    expect(JSON.stringify(post.mock.calls[1][1])).toContain('canary-b');
    expect(JSON.stringify(post.mock.calls[1][1])).not.toContain('canary-a');
    expect(second.providerModel).toBe('hermes-agent');
  });
});

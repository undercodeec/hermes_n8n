import { ConfigService } from '@nestjs/config';
import { MetaSendError, MetaService } from './meta.service';

function createService(): MetaService {
  return new MetaService({
    get: jest.fn((_key: string, fallback?: string) => fallback),
  } as unknown as ConfigService);
}

function httpPost(service: MetaService): jest.Mock {
  const client = service as unknown as {
    httpClient: { post: jest.Mock };
  };
  client.httpClient.post = jest.fn();
  return client.httpClient.post;
}

describe('MetaService typing indicator', () => {
  it.each([
    [429, 'DEFINITIVE_REJECTION', true, 'META_HTTP_429'],
    [400, 'DEFINITIVE_REJECTION', false, 'META_HTTP_400'],
    [401, 'DEFINITIVE_REJECTION', false, 'META_HTTP_401'],
    [500, 'AMBIGUOUS', false, 'META_HTTP_500'],
  ])(
    'classifies HTTP %i without exposing the provider body',
    async (status, outcome, retryable, safeCode) => {
      const service = createService();
      httpPost(service).mockRejectedValue({
        response: {
          status,
          data: { error: { code: 999, message: 'provider-secret-detail' } },
        },
      });

      const failure = await service
        .sendTextMessage('593991234567', 'Mensaje')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MetaSendError);
      expect(failure).toEqual(
        expect.objectContaining({ outcome, retryable, status, safeCode }),
      );
      expect((failure as Error).message).not.toContain(
        'provider-secret-detail',
      );
    },
  );

  it.each([{ code: 'ECONNABORTED' }, { code: 'ECONNRESET' }])(
    'classifies a transport failure as ambiguous',
    async (transportError) => {
      const service = createService();
      httpPost(service).mockRejectedValue(transportError);
      await expect(
        service.sendTextMessage('593991234567', 'Mensaje'),
      ).rejects.toEqual(
        expect.objectContaining({ outcome: 'AMBIGUOUS', retryable: false }),
      );
    },
  );

  it('classifies a successful response without wamid as ambiguous', async () => {
    const service = createService();
    httpPost(service).mockResolvedValue({ data: { messages: [] } });
    await expect(
      service.sendTextMessage('593991234567', 'Mensaje'),
    ).rejects.toEqual(expect.objectContaining({ outcome: 'AMBIGUOUS' }));
  });

  it('marks the inbound message as read and enables the native text indicator', async () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string> = {
          META_ACCESS_TOKEN: 'test-token',
          META_API_VERSION: 'v25.0',
          META_PHONE_NUMBER_ID: 'phone-number-id',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const service = new MetaService(config);
    const post = jest.fn().mockResolvedValue({ data: { success: true } });
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await service.showTypingIndicator('wamid.inbound');

    expect(post).toHaveBeenCalledWith('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.inbound',
      typing_indicator: { type: 'text' },
    });
  });

  it('does not interrupt the reply flow if Meta rejects the indicator', async () => {
    const service = new MetaService({
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService);
    const post = jest.fn().mockRejectedValue(new Error('Meta unavailable'));
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await expect(
      service.showTypingIndicator('wamid.inbound'),
    ).resolves.toBeUndefined();
  });

  it('rejects a text send when Meta does not accept the request', async () => {
    const service = new MetaService({
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService);
    const post = jest.fn().mockRejectedValue(new Error('Meta unavailable'));
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await expect(
      service.sendTextMessage('593991234567', 'Mensaje de prueba'),
    ).rejects.toEqual(
      expect.objectContaining({
        outcome: 'AMBIGUOUS',
        safeCode: 'META_TRANSPORT_ERROR',
      }),
    );
  });

  it('rejects a text send when Meta omits the outbound wamid', async () => {
    const service = new MetaService({
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService);
    const post = jest.fn().mockResolvedValue({
      data: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '593991234567', wa_id: '593991234567' }],
        messages: [],
      },
    });
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await expect(
      service.sendTextMessage('593991234567', 'Mensaje de prueba'),
    ).rejects.toEqual(
      expect.objectContaining({
        outcome: 'AMBIGUOUS',
        safeCode: 'META_WAMID_MISSING',
      }),
    );
  });
});

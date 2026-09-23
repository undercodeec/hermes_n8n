import { ConfigService } from '@nestjs/config';
import axios from 'axios';
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
  it('uploads OGG/Opus and sends a native WhatsApp voice note', async () => {
    const service = createService();
    const post = httpPost(service)
      .mockResolvedValueOnce({ data: { id: 'media-voice-1' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.voice' }] } });
    const mediaId = await service.uploadVoiceNote(Buffer.from('OggSopus'));
    const response = await service.sendVoiceNote('593991234567', mediaId);
    const calls = post.mock.calls as unknown[][];
    expect(calls[0][0]).toBe('/media');
    expect(calls[0][1]).toBeInstanceOf(FormData);
    expect(calls[1]).toEqual([
      '/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '593991234567',
        type: 'audio',
        audio: { id: 'media-voice-1', voice: true },
      },
    ]);
    expect(response.messages[0].id).toBe('wamid.voice');
  });

  it('rejects a media download host outside Meta before sending the token', async () => {
    const service = createService();
    const graph = service as unknown as { graphClient: { get: jest.Mock } };
    graph.graphClient.get = jest.fn().mockResolvedValue({
      data: {
        url: 'https://attacker.example/audio',
        mime_type: 'audio/ogg',
        file_size: 5,
      },
    });
    const get = jest.spyOn(axios, 'get');
    await expect(service.downloadInboundAudio('media-1', 100)).rejects.toThrow(
      'Host de descarga',
    );
    expect(get).not.toHaveBeenCalled();
  });
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
        expect.objectContaining({
          outcome,
          retryable,
          providerStatus: status,
          safeCode,
        }),
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

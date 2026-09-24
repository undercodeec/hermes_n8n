import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AddressInfo } from 'node:net';
import { createServer, IncomingHttpHeaders } from 'node:http';
import {
  MetaMediaUploadError,
  MetaSendError,
  MetaService,
} from './meta.service';

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

function realHttpClient(service: MetaService): AxiosInstance {
  return (service as unknown as { httpClient: AxiosInstance }).httpClient;
}

function uploadAxiosError(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): axios.AxiosError {
  return new axios.AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    undefined,
    {},
    { data, status, statusText: 'Bad Request', headers } as never,
  );
}

describe('MetaService typing indicator', () => {
  it('returns a media ID without logging an error after a successful voice upload', async () => {
    const service = createService();
    const post = httpPost(service).mockResolvedValue({
      data: { id: 'media-voice-1' },
    });
    const error = jest.spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );

    const audio = Buffer.from('OggSopus');
    await expect(service.uploadVoiceNote(audio)).resolves.toBe('media-voice-1');

    expect(post).toHaveBeenCalledWith('/media', expect.any(FormData), {
      headers: { 'Content-Type': undefined },
      timeout: 30000,
      maxBodyLength: 16 * 1024 * 1024,
    });
    const uploadCall = post.mock.calls[0] as unknown as [string, FormData];
    const form = uploadCall[1];
    const file = form.get('file');
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(file).toBeInstanceOf(Blob);
    if (!(file instanceof Blob)) throw new Error('Missing voice note file');
    expect((file as Blob & { name: string }).name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg; codecs=opus');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    expect(error).not.toHaveBeenCalled();
  });

  it('serializes voice uploads as multipart without inheriting the JSON header', async () => {
    let headers: IncomingHttpHeaders | undefined;
    let body: Buffer | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        headers = request.headers;
        body = Buffer.concat(chunks);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'media-test-1' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const service = createService();
      const port = (server.address() as AddressInfo).port;
      realHttpClient(service).defaults.baseURL = `http://127.0.0.1:${port}`;
      const audio = Buffer.from('OggSopus-original-bytes');

      await expect(service.uploadVoiceNote(audio)).resolves.toBe(
        'media-test-1',
      );

      const contentType = headers?.['content-type'];
      const serialized = body?.toString('latin1') ?? '';
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(headers?.['content-length']).toEqual(expect.any(String));
      expect(Number(headers?.['content-length'])).toBeGreaterThan(42);
      expect(contentType).not.toBe('application/json');
      expect(serialized).toContain('name="messaging_product"');
      expect(serialized).toContain('whatsapp');
      expect(serialized).toContain('filename="voice.ogg"');
      expect(serialized).toContain('Content-Type: audio/ogg; codecs=opus');
      expect(serialized).toContain(audio.toString('latin1'));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps the JSON content type for text message requests', async () => {
    let headers: IncomingHttpHeaders | undefined;
    let body: Buffer | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        headers = request.headers;
        body = Buffer.concat(chunks);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ messages: [{ id: 'wamid-test-1' }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const service = createService();
      const port = (server.address() as AddressInfo).port;
      realHttpClient(service).defaults.baseURL = `http://127.0.0.1:${port}`;

      await service.sendTextMessage('recipient-test', 'Mensaje de prueba');

      expect(headers?.['content-type']).toBe('application/json');
      expect(JSON.parse(body?.toString() ?? '')).toEqual(
        expect.objectContaining({
          messaging_product: 'whatsapp',
          type: 'text',
        }),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('logs sanitized Meta diagnostics and classifies a 400 voice upload failure', async () => {
    const service = createService();
    const error = jest.spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );
    httpPost(service).mockRejectedValue(
      uploadAxiosError(
        400,
        {
          error: {
            type: 'OAuthException',
            code: 100,
            error_subcode: 2494010,
            message: 'Unsupported audio codec',
            fbtrace_id: 'FBTRACE-1',
            access_token: 'response-secret',
          },
        },
        {
          'content-type': 'application/json',
          'x-request-id': 'meta-request-1',
          authorization: 'Bearer header-secret',
        },
      ),
    );

    const failure = await service
      .uploadVoiceNote(Buffer.from('OggSopus'))
      .catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(MetaMediaUploadError);
    expect(failure).toEqual(
      expect.objectContaining({ reasonCode: 'META_MEDIA_UPLOAD_FAILED' }),
    );
    const diagnostic = JSON.parse(error.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(diagnostic).toEqual(
      expect.objectContaining({
        event: 'meta_voice_media_upload_failed',
        httpStatus: 400,
        metaErrorType: 'OAuthException',
        metaErrorCode: '100',
        metaErrorSubcode: '2494010',
        metaErrorMessage: 'Unsupported audio codec',
        fbtraceId: 'FBTRACE-1',
        requestId: 'meta-request-1',
        responseContentType: 'application/json',
        audioMimeType: 'audio/ogg; codecs=opus',
        audioBytes: 8,
        filename: 'voice.ogg',
        graphApiVersion: 'v21.0',
      }),
    );
    expect(JSON.stringify(diagnostic)).not.toContain('response-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('header-secret');
  });

  it.each([401, 403])(
    'sanitizes credentials when Meta rejects a voice upload with HTTP %i',
    async (status) => {
      const service = createService();
      const error = jest.spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      );
      httpPost(service).mockRejectedValue(
        uploadAxiosError(
          status,
          { error: { message: 'Invalid token=body-secret' } },
          {
            'content-type': 'application/json',
            authorization: 'Bearer header-secret',
          },
        ),
      );

      await expect(
        service.uploadVoiceNote(Buffer.from('OggSopus')),
      ).rejects.toEqual(
        expect.objectContaining({ reasonCode: 'META_MEDIA_UPLOAD_FAILED' }),
      );

      expect(error).toHaveBeenCalledTimes(1);
      const output = error.mock.calls[0][0] as string;
      expect(output).not.toContain('body-secret');
      expect(output).not.toContain('header-secret');
    },
  );

  it('logs sanitized transport details when the voice upload has no response', async () => {
    const service = createService();
    const error = jest.spyOn(
      (service as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );
    httpPost(service).mockRejectedValue(
      new axios.AxiosError(
        'socket failed for +593991234567 token=transport-secret',
        'ECONNRESET',
      ),
    );

    await expect(
      service.uploadVoiceNote(Buffer.from('OggSopus')),
    ).rejects.toEqual(
      expect.objectContaining({ reasonCode: 'META_MEDIA_UPLOAD_FAILED' }),
    );

    const diagnostic = JSON.parse(error.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(diagnostic).toEqual(
      expect.objectContaining({
        transportCode: 'ECONNRESET',
        transportMessage: 'socket failed for [phone redacted] token=[redacted]',
        httpStatus: null,
      }),
    );
    expect(JSON.stringify(diagnostic)).not.toContain('transport-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('593991234567');
  });

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

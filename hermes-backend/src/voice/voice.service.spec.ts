import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetaService } from '../meta/meta.service';
import { VoiceProcessingError, VoiceService } from './voice.service';

type VoiceInternals = {
  audioDuration: (bytes: Buffer) => Promise<number>;
  speechFrom: (provider: string, text: string) => Promise<Buffer>;
  runBinary: (
    command: string,
    args: string[],
    input: Buffer,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<Buffer>;
};

function setup(values: Record<string, string> = {}) {
  const meta = {
    downloadInboundAudio: jest.fn().mockResolvedValue({
      bytes: Buffer.from('audio'),
      mimeType: 'audio/ogg',
    }),
  };
  const voice = new VoiceService(
    {
      get: (key: string, fallback?: string) => values[key] ?? fallback,
    } as ConfigService,
    meta as unknown as MetaService,
  );
  jest
    .spyOn(voice as unknown as VoiceInternals, 'audioDuration')
    .mockResolvedValue(5);
  return { voice, meta };
}

async function rejectedVoiceError(
  operation: Promise<unknown>,
): Promise<VoiceProcessingError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof VoiceProcessingError) return error;
    throw error;
  }
  throw new Error('Expected VoiceProcessingError');
}

describe('VoiceService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a server-side transcript and keeps raw audio out of the result', async () => {
    const { voice, meta } = setup({ ELEVENLABS_API_KEY: 'test-key' });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { text: 'Necesito una página web.', language_code: 'es' },
    });
    await expect(voice.transcribe('media-1')).resolves.toEqual({
      text: 'Necesito una página web.',
      language: 'es',
      confidence: undefined,
      sourceType: 'AUDIO',
    });
    expect(meta.downloadInboundAudio).toHaveBeenCalledWith(
      'media-1',
      16 * 1024 * 1024,
    );
    expect(post).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/speech-to-text',
      expect.any(FormData),
      expect.objectContaining({ headers: { 'xi-api-key': 'test-key' } }),
    );
  });

  it('rejects low-confidence transcripts before discovery', async () => {
    const { voice } = setup({ ELEVENLABS_API_KEY: 'test-key' });
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { text: 'Precio quince', confidence: 0.2 },
    });
    await expect(voice.transcribe('media-1')).rejects.toEqual(
      new VoiceProcessingError('STT_LOW_CONFIDENCE'),
    );
  });

  it('reports missing STT credentials before downloading media', async () => {
    const { voice, meta } = setup();
    await expect(voice.transcribe('media-1')).rejects.toEqual(
      new VoiceProcessingError('STT_NOT_CONFIGURED'),
    );
    expect(meta.downloadInboundAudio).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422, 429, 500])(
    'keeps sanitized ElevenLabs diagnostics for HTTP %i failures',
    async (status) => {
      const { voice } = setup({ ELEVENLABS_API_KEY: 'test-key' });
      jest.spyOn(axios, 'post').mockRejectedValue({
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        message: `Request failed with status code ${status}`,
        request: { method: 'POST' },
        response: {
          status,
          data: {
            detail: {
              code: `provider-${status}`,
              message: `Diagnóstico ${status}`,
              type: 'invalid_request',
            },
            xiApiKey: 'must-not-be-logged',
          },
          headers: { 'x-request-id': `request-${status}` },
        },
      });

      const error = await voice
        .transcribe('media-1')
        .catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          code: 'STT_PROVIDER_FAILED',
          diagnostics: {
            provider: 'elevenlabs',
            modelId: 'scribe_v2',
            mimeType: 'audio/ogg',
            audioBytes: 5,
            providerHttpStatus: status,
            providerErrorCode: `provider-${status}`,
            providerMessage: `Diagnóstico ${status}`,
            transportCode: 'ERR_BAD_REQUEST',
            transportMessage: `Request failed with status code ${status}`,
            requestId: `request-${status}`,
            failureKind: 'HTTP',
          },
        }),
      );
      expect(JSON.stringify(error)).not.toContain('must-not-be-logged');
      expect(JSON.stringify(error)).not.toContain('test-key');
    },
  );

  it('keeps a safe transport diagnosis when ElevenLabs does not respond', async () => {
    const { voice } = setup({ ELEVENLABS_API_KEY: 'test-key' });
    jest.spyOn(axios, 'post').mockRejectedValue({
      isAxiosError: true,
      code: 'ETIMEDOUT',
      message:
        'timeout of 30000ms exceeded https://api.elevenlabs.io/v1/speech-to-text?token=transport-secret',
      request: { method: 'POST' },
    });

    const error = await voice
      .transcribe('media-1')
      .catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining({
        code: 'STT_PROVIDER_FAILED',
        diagnostics: {
          provider: 'elevenlabs',
          modelId: 'scribe_v2',
          mimeType: 'audio/ogg',
          audioBytes: 5,
          providerHttpStatus: null,
          providerErrorCode: null,
          providerMessage: null,
          transportCode: 'ETIMEDOUT',
          transportMessage: 'timeout of 30000ms exceeded [url redacted]',
          requestId: null,
          failureKind: 'TRANSPORT',
        },
      }),
    );
  });

  it('prioritizes structured provider details over a generic unsafe error message', async () => {
    const { voice } = setup({ ELEVENLABS_API_KEY: 'test-key' });
    jest.spyOn(axios, 'post').mockRejectedValue({
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      message: 'Request failed with status code 422',
      request: { method: 'POST' },
      response: {
        status: 422,
        data: {
          message:
            'Solicitud inválida https://provider.example/error?signature=unsafe-signature',
          detail: [
            {
              code: 'invalid_audio',
              message: 'Formato de audio no admitido.',
              type: 'validation_error',
            },
          ],
        },
        headers: { 'x-request-id': 'request-422' },
      },
    });

    const error = await rejectedVoiceError(voice.transcribe('media-1'));

    expect(error.diagnostics?.providerErrorCode).toBe('invalid_audio');
    expect(error.diagnostics?.providerMessage).toBe(
      'Formato de audio no admitido.',
    );
    expect(JSON.stringify(error)).not.toContain('unsafe-signature');
  });

  it('redacts secret-shaped values from internal error messages', async () => {
    const { voice } = setup({ ELEVENLABS_API_KEY: 'test-key' });
    jest
      .spyOn(axios, 'post')
      .mockRejectedValue(
        new Error('Internal failure {"api_key":"internal-secret"}'),
      );

    const error = await rejectedVoiceError(voice.transcribe('media-1'));

    expect(error.diagnostics).toEqual(
      expect.objectContaining({
        failureKind: 'INTERNAL',
        provider: 'elevenlabs',
        modelId: 'scribe_v2',
      }),
    );
    expect(error.diagnostics?.transportMessage).toContain('[redacted]');
    expect(JSON.stringify(error)).not.toContain('internal-secret');
  });

  it('reads the duration of streamed OGG packets without seeking', async () => {
    const { voice } = setup();
    jest.restoreAllMocks();
    const run = jest
      .spyOn(voice as unknown as VoiceInternals, 'runBinary')
      .mockResolvedValue(
        Buffer.from(
          '-0.006500,0.020000\n0.973500,0.020000\n0.993500,0.006500,\n',
        ),
      );
    await expect(
      (voice as unknown as VoiceInternals).audioDuration(Buffer.from('OggS')),
    ).resolves.toBe(1);
    expect(run).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['packet=pts_time,duration_time', 'pipe:0']),
      Buffer.from('OggS'),
      2 * 1024 * 1024,
      10000,
    );
  });

  it('falls back to a secondary TTS provider and preserves the approved text', async () => {
    const { voice } = setup({
      HERMES_TTS_PROVIDER: 'elevenlabs',
      HERMES_TTS_FALLBACK_PROVIDER: 'openai',
    });
    const speech = jest
      .spyOn(voice as unknown as VoiceInternals, 'speechFrom')
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(Buffer.from('mp3'));
    const convert = jest
      .spyOn(voice as unknown as VoiceInternals, 'runBinary')
      .mockResolvedValue(Buffer.from('OggSopus'));
    await expect(voice.synthesize('USD 360 autorizados')).resolves.toEqual(
      Buffer.from('OggSopus'),
    );
    expect(speech.mock.calls).toEqual([
      ['elevenlabs', 'USD 360 autorizados'],
      ['openai', 'USD 360 autorizados'],
    ]);
    expect(convert).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['libopus', 'ogg']),
      Buffer.from('mp3'),
      16 * 1024 * 1024,
      30000,
    );
  });
});

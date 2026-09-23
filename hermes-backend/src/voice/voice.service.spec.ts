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

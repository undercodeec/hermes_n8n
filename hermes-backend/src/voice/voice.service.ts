import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetaService } from '../meta/meta.service';

export type VoiceTranscript = {
  text: string;
  language?: string;
  confidence?: number;
  sourceType: 'AUDIO';
};

export class VoiceProcessingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'VoiceProcessingError';
  }
}

@Injectable()
export class VoiceService {
  constructor(
    private readonly config: ConfigService,
    private readonly meta: MetaService,
  ) {}

  async transcribe(mediaId: string): Promise<VoiceTranscript> {
    const provider = this.config.get<string>(
      'HERMES_STT_PROVIDER',
      'elevenlabs',
    );
    if (provider !== 'elevenlabs' && provider !== 'openai')
      throw new VoiceProcessingError('STT_PROVIDER_UNSUPPORTED');
    const key = this.config.get<string>(
      provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY',
      '',
    );
    if (!key) throw new VoiceProcessingError('STT_NOT_CONFIGURED');
    const maxBytes = this.positiveInteger(
      'HERMES_AUDIO_MAX_BYTES',
      16 * 1024 * 1024,
    );
    const { bytes, mimeType } = await this.meta.downloadInboundAudio(
      mediaId,
      maxBytes,
    );
    const duration = await this.audioDuration(bytes);
    if (duration > this.positiveInteger('HERMES_AUDIO_MAX_SECONDS', 120))
      throw new VoiceProcessingError('AUDIO_TOO_LONG');
    const form = new FormData();
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.append('file', new Blob([data], { type: mimeType }), 'inbound-audio');
    const timeout = this.positiveInteger('HERMES_STT_TIMEOUT_MS', 30000);
    let response: {
      text?: unknown;
      language_code?: unknown;
      language?: unknown;
      confidence?: unknown;
    };
    if (provider === 'elevenlabs') {
      form.append(
        'model_id',
        this.config.get<string>('HERMES_STT_MODEL_ID', 'scribe_v2'),
      );
      try {
        const result = await axios.post<typeof response>(
          'https://api.elevenlabs.io/v1/speech-to-text',
          form,
          {
            headers: { 'xi-api-key': key },
            timeout,
            maxBodyLength: maxBytes + 100_000,
            maxContentLength: 100_000,
            maxRedirects: 0,
          },
        );
        response = result.data;
      } catch {
        throw new VoiceProcessingError('STT_PROVIDER_FAILED');
      }
    } else if (provider === 'openai') {
      form.append(
        'model',
        this.config.get<string>(
          'HERMES_STT_MODEL_ID',
          'gpt-4o-mini-transcribe',
        ),
      );
      try {
        const result = await axios.post<typeof response>(
          'https://api.openai.com/v1/audio/transcriptions',
          form,
          {
            headers: { Authorization: `Bearer ${key}` },
            timeout,
            maxBodyLength: maxBytes + 100_000,
            maxContentLength: 100_000,
            maxRedirects: 0,
          },
        );
        response = result.data;
      } catch {
        throw new VoiceProcessingError('STT_PROVIDER_FAILED');
      }
    } else {
      throw new VoiceProcessingError('STT_PROVIDER_UNSUPPORTED');
    }
    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (!text || text.length > 4000)
      throw new VoiceProcessingError('STT_EMPTY_OR_TOO_LONG');
    const confidence =
      typeof response.confidence === 'number' ? response.confidence : undefined;
    if (confidence !== undefined && confidence < 0.65)
      throw new VoiceProcessingError('STT_LOW_CONFIDENCE');
    return {
      text,
      language:
        typeof response.language_code === 'string'
          ? response.language_code
          : typeof response.language === 'string'
            ? response.language
            : undefined,
      confidence,
      sourceType: 'AUDIO',
    };
  }

  async synthesize(text: string): Promise<Buffer> {
    if (
      !text.trim() ||
      text.length > this.positiveInteger('HERMES_TTS_MAX_CHARS', 1200)
    )
      throw new VoiceProcessingError('TTS_TEXT_TOO_LONG');
    const preferred = this.config.get<string>(
      'HERMES_TTS_PROVIDER',
      'elevenlabs',
    );
    const fallback = this.config.get<string>(
      'HERMES_TTS_FALLBACK_PROVIDER',
      'openai',
    );
    let mp3: Buffer;
    try {
      mp3 = await this.speechFrom(preferred, text);
    } catch {
      if (!fallback || fallback === preferred)
        throw new VoiceProcessingError('TTS_UNAVAILABLE');
      try {
        mp3 = await this.speechFrom(fallback, text);
      } catch {
        throw new VoiceProcessingError('TTS_UNAVAILABLE');
      }
    }
    const ogg = await this.runBinary(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-f',
        'ogg',
        'pipe:1',
      ],
      mp3,
      16 * 1024 * 1024,
      30000,
    );
    if (!ogg.subarray(0, 4).equals(Buffer.from('OggS')))
      throw new VoiceProcessingError('TTS_INVALID_OGG');
    return ogg;
  }

  private async speechFrom(provider: string, text: string): Promise<Buffer> {
    const timeout = this.positiveInteger('HERMES_TTS_TIMEOUT_MS', 30000);
    if (provider === 'elevenlabs') {
      const key = this.config.get<string>('ELEVENLABS_API_KEY', '');
      const voiceId = this.config.get<string>('HERMES_TTS_VOICE_ID', '');
      if (!key || !voiceId)
        throw new VoiceProcessingError('TTS_NOT_CONFIGURED');
      const response = await axios.post<ArrayBuffer>(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          text,
          model_id: this.config.get<string>(
            'HERMES_TTS_MODEL_ID',
            'eleven_multilingual_v2',
          ),
        },
        {
          params: { output_format: 'mp3_44100_128' },
          headers: { 'xi-api-key': key },
          responseType: 'arraybuffer',
          timeout,
          maxContentLength: 16 * 1024 * 1024,
          maxRedirects: 0,
        },
      );
      return Buffer.from(response.data);
    }
    if (provider === 'openai') {
      const key = this.config.get<string>('OPENAI_API_KEY', '');
      if (!key) throw new VoiceProcessingError('TTS_NOT_CONFIGURED');
      const response = await axios.post<ArrayBuffer>(
        'https://api.openai.com/v1/audio/speech',
        {
          model: this.config.get<string>(
            'HERMES_TTS_FALLBACK_MODEL_ID',
            'gpt-4o-mini-tts',
          ),
          voice: this.config.get<string>(
            'HERMES_TTS_FALLBACK_VOICE_ID',
            'alloy',
          ),
          input: text,
          response_format: 'mp3',
        },
        {
          headers: { Authorization: `Bearer ${key}` },
          responseType: 'arraybuffer',
          timeout,
          maxContentLength: 16 * 1024 * 1024,
          maxRedirects: 0,
        },
      );
      return Buffer.from(response.data);
    }
    throw new VoiceProcessingError('TTS_PROVIDER_UNSUPPORTED');
  }

  private async audioDuration(bytes: Buffer): Promise<number> {
    const result = await this.runBinary(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'packet=pts_time,duration_time',
        '-of',
        'csv=p=0',
        'pipe:0',
      ],
      bytes,
      2 * 1024 * 1024,
      10000,
    );
    const duration = result
      .toString('utf8')
      .split(/\r?\n/u)
      .reduce((latest, line) => {
        const [startText, spanText] = line.split(',');
        const start = Number(startText);
        const span = Number(spanText);
        return Number.isFinite(start) && Number.isFinite(span)
          ? Math.max(latest, start + span)
          : latest;
      }, 0);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new VoiceProcessingError('AUDIO_DURATION_UNKNOWN');
    return duration;
  }

  private runBinary(
    command: string,
    args: string[],
    input: Buffer,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', () =>
        reject(new VoiceProcessingError('AUDIO_TOOL_UNAVAILABLE')),
      );
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) child.kill();
        else chunks.push(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || size > maxBytes)
          reject(new VoiceProcessingError('AUDIO_CONVERSION_FAILED'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
}

import { spawn } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MetaService } from '../meta/meta.service';

export type VoiceTranscript = {
  text: string;
  language?: string;
  confidence?: number;
  sourceType: 'AUDIO';
};

export type VoiceFailureDiagnostics = {
  provider: string | null;
  modelId: string | null;
  mimeType: string | null;
  audioBytes: number | null;
  providerHttpStatus: number | null;
  providerErrorCode: string | null;
  providerMessage: string | null;
  transportCode: string | null;
  transportMessage: string | null;
  requestId: string | null;
  failureKind: 'HTTP' | 'TRANSPORT' | 'INTERNAL';
};

type VoiceFailureLogDiagnostics = {
  provider: 'elevenlabs' | 'openai' | null;
  modelId: string | null;
  mimeType: string | null;
  audioBytes: number | null;
  providerHttpStatus: number | null;
  providerErrorCode: string | null;
  providerMessage: string | null;
  transportCode: string | null;
  transportMessage: string | null;
  requestId: string | null;
  failureKind: VoiceFailureDiagnostics['failureKind'] | null;
};

type ElevenLabsVoiceSettings = {
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
  speed: number;
};

const DEFAULT_ELEVENLABS_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.48,
  similarityBoost: 0.82,
  style: 0.05,
  speakerBoost: true,
  speed: 0.96,
};

export function voiceFailureLogDiagnostics(
  diagnostics?: VoiceFailureDiagnostics,
): VoiceFailureLogDiagnostics {
  return {
    provider:
      diagnostics?.provider === 'elevenlabs' ||
      diagnostics?.provider === 'openai'
        ? diagnostics.provider
        : null,
    modelId: safeIdentifier(diagnostics?.modelId, 100),
    mimeType: safeMimeType(diagnostics?.mimeType),
    audioBytes:
      Number.isSafeInteger(diagnostics?.audioBytes) &&
      (diagnostics?.audioBytes ?? -1) >= 0 &&
      (diagnostics?.audioBytes ?? Infinity) <= 16 * 1024 * 1024
        ? (diagnostics?.audioBytes ?? null)
        : null,
    providerHttpStatus:
      Number.isSafeInteger(diagnostics?.providerHttpStatus) &&
      (diagnostics?.providerHttpStatus ?? 0) >= 100 &&
      (diagnostics?.providerHttpStatus ?? 600) <= 599
        ? (diagnostics?.providerHttpStatus ?? null)
        : null,
    providerErrorCode: sanitizeVoiceDiagnosticText(
      diagnostics?.providerErrorCode,
    ),
    providerMessage: sanitizeVoiceDiagnosticText(diagnostics?.providerMessage),
    transportCode: safeIdentifier(diagnostics?.transportCode, 80),
    transportMessage: sanitizeVoiceDiagnosticText(
      diagnostics?.transportMessage,
    ),
    requestId: safeIdentifier(diagnostics?.requestId, 160),
    failureKind:
      diagnostics?.failureKind === 'HTTP' ||
      diagnostics?.failureKind === 'TRANSPORT' ||
      diagnostics?.failureKind === 'INTERNAL'
        ? diagnostics.failureKind
        : null,
  };
}

export function sanitizeVoiceDiagnosticText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[url redacted]')
    .replace(
      /((?:["']?)(?:xi[-_]?api[-_]?key|authorization|api[-_]?key|access[-_]?token|token|x-amz-signature|signature|sig)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu,
      '$1[redacted]',
    )
    .replace(/bearer\s+\S+/giu, 'Bearer [redacted]')
    .trim();
  return text ? text.slice(0, 240) : null;
}

function safeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[A-Za-z0-9._-]+$/u.test(text) && text.length <= maxLength
    ? text
    : null;
}

function safeMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mimeType && /^audio\/[a-z0-9.+-]+$/u.test(mimeType) ? mimeType : null;
}

export class VoiceProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly diagnostics?: VoiceFailureDiagnostics,
  ) {
    super(code);
    this.name = 'VoiceProcessingError';
  }
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private readonly elevenLabsVoiceSettings: ElevenLabsVoiceSettings;

  constructor(
    private readonly config: ConfigService,
    private readonly meta: MetaService,
  ) {
    this.elevenLabsVoiceSettings = this.getElevenLabsVoiceSettings();
  }

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
      const modelId = this.config.get<string>(
        'HERMES_STT_MODEL_ID',
        'scribe_v2',
      );
      form.append('model_id', modelId);
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
      } catch (error) {
        throw this.providerFailure(error, {
          provider,
          modelId,
          mimeType,
          audioBytes: bytes.length,
        });
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
          voice_settings: {
            stability: this.elevenLabsVoiceSettings.stability,
            similarity_boost: this.elevenLabsVoiceSettings.similarityBoost,
            style: this.elevenLabsVoiceSettings.style,
            use_speaker_boost: this.elevenLabsVoiceSettings.speakerBoost,
            speed: this.elevenLabsVoiceSettings.speed,
          },
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

  private providerFailure(
    error: unknown,
    input: Pick<
      VoiceFailureDiagnostics,
      'provider' | 'modelId' | 'mimeType' | 'audioBytes'
    >,
  ): VoiceProcessingError {
    const diagnostics: VoiceFailureDiagnostics = {
      ...input,
      providerHttpStatus: null,
      providerErrorCode: null,
      providerMessage: null,
      transportCode: null,
      transportMessage: null,
      requestId: null,
      failureKind: 'INTERNAL',
    };
    if (axios.isAxiosError(error)) {
      diagnostics.transportCode = this.safeDiagnosticText(error.code);
      diagnostics.transportMessage = this.safeDiagnosticText(error.message);
      if (error.response) {
        diagnostics.failureKind = 'HTTP';
        diagnostics.providerHttpStatus = error.response.status;
        const providerDetail = this.providerErrorDetail(error.response.data);
        diagnostics.providerErrorCode = providerDetail.code;
        diagnostics.providerMessage = providerDetail.message;
        diagnostics.requestId = this.requestId(error.response.headers);
      } else if (error.request) {
        diagnostics.failureKind = 'TRANSPORT';
      }
    } else if (error instanceof Error) {
      diagnostics.transportMessage = this.safeDiagnosticText(error.message);
    }
    return new VoiceProcessingError('STT_PROVIDER_FAILED', diagnostics);
  }

  private providerErrorDetail(data: unknown): {
    code: string | null;
    message: string | null;
  } {
    if (!this.isRecord(data)) return { code: null, message: null };
    const detail = data.detail;
    const candidates = [
      this.isRecord(detail) ? detail : undefined,
      ...(Array.isArray(detail)
        ? detail.filter((entry): entry is Record<string, unknown> =>
            this.isRecord(entry),
          )
        : []),
      this.isRecord(data.error) ? data.error : undefined,
      data,
    ].filter((candidate): candidate is Record<string, unknown> => !!candidate);
    return {
      code: this.firstDiagnosticField(candidates, ['code', 'type', 'status']),
      message: this.firstDiagnosticField(candidates, ['message', 'msg']),
    };
  }

  private requestId(headers: unknown): string | null {
    const names = [
      'request-id',
      'x-request-id',
      'x-correlation-id',
      'x-trace-id',
    ];
    if (!headers || typeof headers !== 'object') return null;
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') {
      for (const name of names) {
        const value: unknown = get.call(headers, name);
        const requestId = this.safeDiagnosticText(value);
        if (requestId) return requestId;
      }
    }
    const record = headers as Record<string, unknown>;
    for (const name of names) {
      const requestId = this.safeDiagnosticText(record[name]);
      if (requestId) return requestId;
    }
    return null;
  }

  private firstDiagnosticField(
    candidates: Record<string, unknown>[],
    names: string[],
  ): string | null {
    for (const candidate of candidates) {
      for (const name of names) {
        const value = this.safeDiagnosticText(candidate[name]);
        if (value) return value;
      }
    }
    return null;
  }

  private safeDiagnosticText(value: unknown): string | null {
    return sanitizeVoiceDiagnosticText(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

  private getElevenLabsVoiceSettings(): ElevenLabsVoiceSettings {
    return {
      stability: this.numberSetting(
        'HERMES_TTS_STABILITY',
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
        0,
        1,
      ),
      similarityBoost: this.numberSetting(
        'HERMES_TTS_SIMILARITY_BOOST',
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
        0,
        1,
      ),
      style: this.numberSetting(
        'HERMES_TTS_STYLE',
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
        0,
        1,
      ),
      speakerBoost: this.booleanSetting(
        'HERMES_TTS_SPEAKER_BOOST',
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.speakerBoost,
      ),
      speed: this.numberSetting(
        'HERMES_TTS_SPEED',
        DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
        0.7,
        1.2,
      ),
    };
  }

  private numberSetting(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<unknown>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim()
          ? Number(raw.trim())
          : Number.NaN;
    if (Number.isFinite(value) && value >= minimum && value <= maximum)
      return value;
    this.warnInvalidTtsSetting(key);
    return fallback;
  }

  private booleanSetting(key: string, fallback: boolean): boolean {
    const raw = this.config.get<unknown>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      const value = raw.trim().toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    this.warnInvalidTtsSetting(key);
    return fallback;
  }

  private warnInvalidTtsSetting(key: string): void {
    this.logger.warn(`Invalid ${key}; using the safe default.`);
  }
}

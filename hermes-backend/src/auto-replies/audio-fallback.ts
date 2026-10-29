import type { VoiceFailureDiagnostics } from '../voice/voice.service';

type AudioFailureEvidence = Partial<
  Pick<
    VoiceFailureDiagnostics,
    'providerHttpStatus' | 'providerErrorCode' | 'transportCode'
  >
>;

export type AudioFailureCategory =
  | 'META_DOWNLOAD'
  | 'FILE_UNAVAILABLE'
  | 'UNSUPPORTED_FORMAT'
  | 'AUTHENTICATION'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'STT_SERVICE'
  | 'EMPTY_TRANSCRIPT'
  | 'UNKNOWN';

const AUDIO_FAILURE_BODY =
  'Recibí su nota de voz, pero esta vez no pude escucharla correctamente.\n\n¿Podría escribirme por aquí lo que necesita? Con gusto le ayudo.';

function safeFirstName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 100 || /\p{N}/u.test(name)) return null;
  if (
    /^(?:cliente|usuario|contacto|whatsapp|unknown|sin nombre|no name)\b/iu.test(
      name,
    )
  )
    return null;
  const first = name.split(/\s+/u)[0];
  return first.length <= 32 && /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(first)
    ? first
    : null;
}

export function audioFailureNotice(contactName: unknown): string {
  const firstName = safeFirstName(contactName);
  return `${firstName ? `Hola, ${firstName}.` : 'Hola.'} 😊\n\n${AUDIO_FAILURE_BODY}`;
}

export function audioFailureCategory(
  code: string,
  diagnostics?: AudioFailureEvidence,
): AudioFailureCategory {
  const status = diagnostics?.providerHttpStatus;
  const transport = diagnostics?.transportCode?.toUpperCase();
  const providerCode = diagnostics?.providerErrorCode?.toLowerCase();
  if (transport === 'ETIMEDOUT' || transport === 'ECONNABORTED')
    return 'TIMEOUT';
  if (
    status === 402 ||
    providerCode === 'insufficient_quota' ||
    providerCode === 'quota_exceeded' ||
    providerCode === 'insufficient_credits'
  )
    return 'QUOTA';
  if (status === 401 || status === 403 || code === 'STT_NOT_CONFIGURED')
    return 'AUTHENTICATION';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 404 || status === 410 || code === 'META_MEDIA_UNAVAILABLE')
    return 'FILE_UNAVAILABLE';
  if (
    code === 'AUDIO_FORMAT_UNSUPPORTED' ||
    providerCode === 'invalid_audio' ||
    providerCode === 'unsupported_format'
  )
    return 'UNSUPPORTED_FORMAT';
  if (code === 'META_MEDIA_DOWNLOAD_FAILED') return 'META_DOWNLOAD';
  if (code === 'STT_EMPTY') return 'EMPTY_TRANSCRIPT';
  if (code === 'STT_PROVIDER_FAILED') return 'STT_SERVICE';
  return 'UNKNOWN';
}

export function audioFailureRecoverable(
  category: AudioFailureCategory,
  diagnostics?: AudioFailureEvidence,
): boolean {
  if (category === 'RATE_LIMIT' || category === 'TIMEOUT') return true;
  if (category === 'META_DOWNLOAD' || category === 'STT_SERVICE')
    return (diagnostics?.providerHttpStatus ?? 0) >= 500;
  return false;
}

import { audioFailureCategory, audioFailureNotice } from './audio-fallback';

describe('audio fallback', () => {
  const body =
    'Recibí su nota de voz, pero esta vez no pude escucharla correctamente.\n\n¿Podría escribirme por aquí lo que necesita? Con gusto le ayudo.';

  it.each([
    ['Carlos Pérez', `Hola, Carlos. 😊\n\n${body}`],
    ['María-José Paredes', `Hola, María-José. 😊\n\n${body}`],
    ['593991234567', `Hola. 😊\n\n${body}`],
    ['Cliente 593991234567', `Hola. 😊\n\n${body}`],
    ['<script>alert(1)</script>', `Hola. 😊\n\n${body}`],
    ['', `Hola. 😊\n\n${body}`],
    [null, `Hola. 😊\n\n${body}`],
  ])('uses a safe greeting for %p', (name, expected) => {
    expect(audioFailureNotice(name)).toBe(expected);
  });

  it.each([
    ['META_MEDIA_UNAVAILABLE', undefined, 'FILE_UNAVAILABLE'],
    [
      'META_MEDIA_DOWNLOAD_FAILED',
      { providerHttpStatus: 500 },
      'META_DOWNLOAD',
    ],
    ['META_MEDIA_DOWNLOAD_FAILED', { transportCode: 'ETIMEDOUT' }, 'TIMEOUT'],
    ['AUDIO_FORMAT_UNSUPPORTED', undefined, 'UNSUPPORTED_FORMAT'],
    ['STT_NOT_CONFIGURED', undefined, 'AUTHENTICATION'],
    ['STT_PROVIDER_FAILED', { providerHttpStatus: 401 }, 'AUTHENTICATION'],
    ['STT_PROVIDER_FAILED', { providerHttpStatus: 402 }, 'QUOTA'],
    ['STT_PROVIDER_FAILED', { providerHttpStatus: 429 }, 'RATE_LIMIT'],
    ['STT_PROVIDER_FAILED', { transportCode: 'ECONNABORTED' }, 'TIMEOUT'],
    ['STT_PROVIDER_FAILED', { providerHttpStatus: 500 }, 'STT_SERVICE'],
    ['STT_EMPTY', undefined, 'EMPTY_TRANSCRIPT'],
    ['STT_TRANSCRIPT_TOO_LONG', undefined, 'UNKNOWN'],
    ['STT_LOW_CONFIDENCE', undefined, 'UNKNOWN'],
    ['AUDIO_PROCESSING_FAILED', undefined, 'UNKNOWN'],
  ] as const)('classifies %s', (code, diagnostics, category) => {
    expect(audioFailureCategory(code, diagnostics)).toBe(category);
  });
});

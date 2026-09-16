import { ConfigService } from '@nestjs/config';
import { ConversationGuardService } from './conversation-guard.service';

describe('ConversationGuardService', () => {
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'SUPPORT_PHONE_E164') return '+593979046329';
      return fallback;
    }),
  } as unknown as ConfigService;

  it('routes a technical issue only when the customer explicitly attributes the project to the brand', async () => {
    const guard = new ConversationGuardService(config);

    await expect(
      guard.inspect('contact-1', 'La página que ustedes desarrollaron no carga y muestra un error.'),
    ).resolves.toEqual(
      expect.objectContaining({ action: 'SUPPORT' }),
    );
    expect(
      (guard as any).isSupportRequest('mi sitio web no carga y muestra un error'),
    ).toBe(false);
  });

  it('rejects an unsafe generated response before it reaches WhatsApp', () => {
    const guard = new ConversationGuardService(config);
    expect(guard.isSafeGeneratedResponse('Claro, podemos ayudarte con ese servicio.')).toBe(true);
    expect(guard.isSafeGeneratedResponse('Te enviaré contenido porno.')).toBe(false);
  });

  it('allows a normal commercial message when the Redis counters are below their limits', async () => {
    const guard = new ConversationGuardService(config);
    const transaction = {
      incr: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]),
    };
    jest.spyOn(guard as any, 'redis').mockResolvedValue({
      multi: jest.fn().mockReturnValue(transaction),
      get: jest.fn().mockResolvedValue(null),
    });

    await expect(
      guard.inspect('contact-1', 'Hola, quisiera conocer sus servicios.'),
    ).resolves.toEqual({ action: 'ALLOW' });
  });
});

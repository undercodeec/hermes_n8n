import { redactPaymentMessageForAi } from './payment-message-redaction';

describe('redactPaymentMessageForAi', () => {
  it('quita por completo las instrucciones bancarias del contexto de IA', () => {
    expect(
      redactPaymentMessageForAi('Cuenta: 123456789012', {
        action: 'TRANSFER_INSTRUCTIONS',
      }),
    ).toBe('[Datos bancarios de transferencia enviados al cliente]');
  });
  it('oculta números largos en el texto del cliente', () => {
    expect(
      redactPaymentMessageForAi(
        'Transferí a Cuenta: 123456789012 y mi teléfono es 0991234567',
      ),
    ).not.toMatch(/123456789012|0991234567/);
  });
});

import { TransferIntentPolicy } from './transfer-intent.policy';

describe('TransferIntentPolicy', () => {
  const policy = new TransferIntentPolicy();
  const ready = {
    service: 'Hermes',
    amount: 1200,
    leadOpen: true,
    hasApprovedTransfer: false,
    hasActiveAccount: true,
  };

  it.each([
    'Pásame los datos para realizar la transferencia.',
    '¿A qué cuenta les pago el anticipo?',
    'Voy a transferir hoy, dame los datos bancarios.',
  ])('acepta una solicitud de pago con contexto: %s', (text) => {
    expect(policy.analyze(text, ready).approved).toBe(true);
  });

  it.each([
    '¿Aceptan transferencia?',
    '¿Cuál es el precio?',
    'No quiero transferir.',
    'Ya transferí.',
    'Pásame tus datos bancarios.',
  ])('rechaza consultas o negaciones: %s', (text) => {
    expect(policy.analyze(text, ready).approved).toBe(false);
  });

  it('requiere oferta y cuenta vigente', () => {
    expect(
      policy.analyze('Pásame los datos para transferir.', {
        ...ready,
        amount: null,
      }).approved,
    ).toBe(false);
    expect(
      policy.analyze('Pásame los datos para transferir.', {
        ...ready,
        hasActiveAccount: false,
      }).approved,
    ).toBe(false);
  });
});

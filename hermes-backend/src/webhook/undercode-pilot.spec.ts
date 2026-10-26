import {
  classifyPilotOrigin,
  isTextualCommercialOptOut,
} from './undercode-pilot';

describe('UnderCodeEC pilot inbound policy', () => {
  it('classifies a Meta ad referral without requiring its optional fields', () => {
    expect(
      classifyPilotOrigin({ source_type: 'ad', source_id: '123' }),
    ).toEqual({
      origin: 'meta_ad',
      adSourceId: '123',
    });
    expect(classifyPilotOrigin()).toEqual({ origin: 'organic' });
  });

  it('does not classify an organic page post as a paid ad', () => {
    expect(
      classifyPilotOrigin({ source_type: 'post', source_id: '456' }),
    ).toEqual({
      origin: 'organic',
    });
  });

  it.each([
    'No quiero recibir publicidad',
    'Dénme de baja de promociones',
    'No me envíen mensajes comerciales',
    'Quiero darme de baja de sus campañas',
    'No quiero que me contacten más',
    'No recibir mensajes',
    'BAJA',
    'STOP',
  ])('recognizes a clear commercial opt-out: %s', (message) => {
    expect(isTextualCommercialOptOut(message)).toBe(true);
  });

  it.each([
    'No quiero soporte técnico, gracias',
    'Necesito dar de baja mi servicio contratado',
    '¿Cómo dejo de recibir errores?',
    'No recibir mensajes de error del sistema',
  ])(
    'keeps service requests separate from marketing opt-out: %s',
    (message) => {
      expect(isTextualCommercialOptOut(message)).toBe(false);
    },
  );
});

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
      evidence: 'meta_referral_ad',
      adSourceId: '123',
    });
    expect(classifyPilotOrigin()).toEqual({
      origin: 'unknown',
      evidence: 'insufficient',
    });
  });

  it('does not classify an organic page post as a paid ad', () => {
    expect(
      classifyPilotOrigin({ source_type: 'post', source_id: '456' }),
    ).toEqual({
      origin: 'organic',
      evidence: 'meta_referral_post',
    });
  });

  it('requires explicit evidence for organic or paid origin', () => {
    expect(classifyPilotOrigin({ source_id: '456' })).toEqual({
      origin: 'unknown',
      evidence: 'insufficient',
    });
    expect(classifyPilotOrigin({ source_type: 'unrecognized' })).toEqual({
      origin: 'unknown',
      evidence: 'insufficient',
    });
    expect(
      classifyPilotOrigin({ source_type: 'post', ctwa_clid: 'click-1' }),
    ).toEqual({
      origin: 'meta_ad',
      evidence: 'meta_ctwa_clid',
      ctwaClidPresent: true,
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

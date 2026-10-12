import {
  advancesToUnansweredTopic,
  asksForKnownUserCount,
  usesLatestCorrectedUserCount,
} from './phase0-fact-assertions';

describe('synthetic fact regression assertions', () => {
  it.each([
    '¿Cuántos usuarios usarán el sistema?',
    '¿Cuántas personas tendrán acceso?',
    '¿Para cuántos accesos sería?',
    '¿Qué cantidad de cuentas necesitan?',
  ])('detects a semantic re-ask of a known user count: %s', (text) => {
    expect(asksForKnownUserCount(text)).toBe(true);
  });

  it('does not confuse a new permissions question with repeating the count', () => {
    expect(
      asksForKnownUserCount('Para las 12 personas, ¿qué permisos necesitan?'),
    ).toBe(false);
    expect(asksForKnownUserCount('¿Qué proceso usarán primero?')).toBe(false);
    expect(
      asksForKnownUserCount(
        'Los 12 usuarios están confirmados. ¿Cuántos productos cargarán?',
      ),
    ).toBe(false);
  });

  it('requires the latest count and permits explicitly acknowledging the correction', () => {
    expect(
      usesLatestCorrectedUserCount('Trabajaremos con 15 personas.', 8, 15),
    ).toBe(true);
    expect(
      usesLatestCorrectedUserCount('Actualizo de 8 a 15 usuarios.', 8, 15),
    ).toBe(true);
    expect(
      usesLatestCorrectedUserCount('Trabajaremos con 8 personas.', 8, 15),
    ).toBe(false);
    expect(
      usesLatestCorrectedUserCount('Serán 8 ahora y quizá 15 después.', 8, 15),
    ).toBe(false);
    expect(
      usesLatestCorrectedUserCount('Continuemos con la propuesta.', 8, 15),
    ).toBe(false);
  });

  it('checks topic advancement as a property, not exact wording', () => {
    expect(
      advancesToUnansweredTopic('¿Qué integración conviene priorizar?', [
        'integration',
      ]),
    ).toBe(true);
    expect(
      advancesToUnansweredTopic('Podemos coordinar el siguiente paso.', [
        'next_step',
      ]),
    ).toBe(true);
    expect(
      advancesToUnansweredTopic('Gracias por explicar su necesidad.', [
        'integration',
        'workflow',
      ]),
    ).toBe(false);
    expect(
      advancesToUnansweredTopic('No sé qué integración necesita.', [
        'integration',
      ]),
    ).toBe(false);
  });
});

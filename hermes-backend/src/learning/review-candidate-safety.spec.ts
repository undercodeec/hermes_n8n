import { parseReviewOutput } from './review-output.validator';
import { sanitizeReviewInput } from './review-privacy';

const base = {
  issueCode: 'REPETITION',
  summary: 'La respuesta repitió una pregunta',
  counterexample: null,
  confidence: 0.8,
  candidate: {
    kind: 'STYLE',
    trigger: 'Cuando el cliente corrige un dato',
    guidance: 'Usar el dato más reciente',
    evidenceMessageIds: ['m1'],
  },
};

function parse(guidance: string) {
  return parseReviewOutput(
    { ...base, candidate: { ...base.candidate, guidance } },
    new Set(['m1']),
  );
}

describe('F2 reviewer safety boundary', () => {
  it.each([
    [
      'UUID',
      'Para la conversación 550e8400-e29b-41d4-a716-446655440000, recordar...',
    ],
    ['wamid', 'Usar wamid.HBgMNTkzOTk5OTk5OTk5FQIA para futuras respuestas'],
    ['email', 'Contactar a cliente@example.com'],
    ['teléfono', 'Llamar al +593 99 123 4567'],
    ['cliente específico', 'Recordar que Juan Pérez necesita 15 usuarios.'],
    ['nombre aislado', 'Recordar que María necesita soporte.'],
    ['nombre con acento final', 'Recordar que José necesita soporte.'],
    ['nombre al inicio', 'María necesita 15 usuarios.'],
  ])('rechaza %s en guidance', (_label, guidance) => {
    expect(() => parse(guidance)).toThrow(/PRIVACY_VALIDATION_FAILED/);
  });

  it('inspecciona todos los campos textuales del output', () => {
    expect(() =>
      parseReviewOutput(
        { ...base, summary: 'El cliente Juan Pérez respondió' },
        new Set(['m1']),
      ),
    ).toThrow(/PRIVACY_VALIDATION_FAILED/);
    expect(() =>
      parseReviewOutput(
        {
          ...base,
          candidate: { ...base.candidate, trigger: 'wamid.HBg123456' },
        },
        new Set(['m1']),
      ),
    ).toThrow(/PRIVACY_VALIDATION_FAILED/);
    expect(() =>
      parseReviewOutput(
        {
          ...base,
          candidate: { ...base.candidate, market: 'cliente@example.com' },
        },
        new Set(['m1']),
      ),
    ).toThrow(/PRIVACY_VALIDATION_FAILED/);
  });

  it.each([
    'Ofrecer 20% de descuento si paga por transferencia.',
    'Aceptar pago 50% al inicio y 50% al final.',
    'El plan cuesta USD 360.',
    'Aceptamos pago por transferencia bancaria.',
    'Entregamos el proyecto en 15 días.',
    'Ofrecemos garantía de 12 meses.',
    'Ofrecemos garantía de por vida.',
    'Aplicamos una bonificación especial.',
    'Consultar la fuente y ofrecer un descuento especial.',
  ])('rechaza condición comercial concreta: %s', (guidance) => {
    expect(() => parse(guidance)).toThrow(/COMMERCIAL_VALIDATION_FAILED/);
  });

  it.each([
    'Cuando el cliente corrija un dato, usar el valor más reciente.',
    'Cuando el cliente ya respondió una pregunta, avanzar con el siguiente dato faltante.',
    'No comunicar precios o condiciones de pago que no provengan de la autoridad comercial vigente.',
    'Consultar la fuente comercial vigente antes de mencionar precio, descuento o forma de pago.',
  ])('acepta conocimiento general: %s', (guidance) => {
    expect(parse(guidance).candidate?.guidance).toBe(guidance);
  });

  it('redacta identificadores y nombres explícitos antes del modelo', () => {
    const input =
      'Soy Juan Pérez. Mi correo es cliente@example.com, teléfono +593 99 123 4567; wamid.HBg123456; 550e8400-e29b-41d4-a716-446655440000';
    const result = sanitizeReviewInput(input);
    expect(result).not.toMatch(/Juan|cliente@|593|wamid\.|550e8400/);
    expect(result).toContain('[NOMBRE]');
    expect(sanitizeReviewInput('María necesita 15 usuarios.')).not.toContain(
      'María',
    );
  });
});

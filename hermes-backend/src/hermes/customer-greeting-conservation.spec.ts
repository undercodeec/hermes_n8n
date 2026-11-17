import { polishCustomerGreeting, resolveCustomerSalutation } from './customer-salutation';

describe('conservative greeting', () => {
  const run = (reply: string, customerMessage = 'Necesito información', name = 'Alex') =>
    polishCustomerGreeting({ reply, customerMessage, firstReply: true, greetNormally: true, salutation: resolveCustomerSalutation(name) });

  it.each([
    '¡Hola! María, nuestra asesora, le enviará el contrato.',
    'Buenos días. https://example.test/a?x=1&y=2',
    'Hola, Carlos. Estimada María, revisará el contrato.',
    'Hola, Bienvenido a Empresa Ejemplo.',
    'Hola, Carlos. María enviará el contrato. Él lo revisará.',
    'Hola, estimada Carlos. Ella coordinará la visita.\n\nhttps://example.test/a?x=1&y=2',
    '¿Qué tal? José, el asesor, enviará el contrato.',
    'Saludos, MRS. María, nuestra asesora, llamó.',
  ])('leaves the complete existing greeting untouched: %s', (reply) => {
    expect(run(reply)).toBe(reply);
    expect(run(run(reply))).toBe(reply);
  });

  it('uses a neutral missing greeting even with an explicit preference, without touching the body', () => {
    const body = 'Carlos, nuestro asesor, enviará el contrato.\n\nhttps://example.test/a';
    const salutation = resolveCustomerSalutation('Ana', 'estimado');
    const input = { reply: body, customerMessage: 'Prefiero que me diga estimado.', firstReply: true, greetNormally: true, salutation };
    expect(polishCustomerGreeting(input)).toBe(`Hola, con gusto. ${body}`);
    const existing = 'Hola, estimada María. Ella enviará el contrato.';
    expect(polishCustomerGreeting({ ...input, reply: existing })).toBe(existing);
  });

  it.each(['podemos ayudarle.\n\nMaría enviará el enlace https://example.test/a?x=1&y=2', '  Texto con espacios\n'])('only prepends a greeting without changing the body', (reply) => {
    expect(run(reply)).toBe(`Hola, con gusto. ${reply}`);
    expect(run(run(reply))).toBe(`Hola, con gusto. ${reply}`);
  });

  it('uses a neutral greeting for an organization', () => {
    expect(run('Tenemos opciones.', 'Información', 'Tienda Ejemplo')).toBe('Hola, con gusto. Tenemos opciones.');
  });

  it('preserves a complete addressed header and all remaining parts after refusal', () => {
    const parts = ['Buenas tardes, estimado Carlos.\n\nle escribo: https://example.test/a?x=1&y=2', 'María, la asesora, enviará el contrato.'];
    const salutation = resolveCustomerSalutation('Ana', null);
    const first = polishCustomerGreeting({ reply: parts[0], customerMessage: 'No me diga estimada.', firstReply: true, salutation });
    expect([first, ...parts.slice(1)]).toEqual([parts[0], parts[1]]);
    expect(polishCustomerGreeting({ reply: first, customerMessage: 'No me diga estimada.', firstReply: true, salutation })).toBe(first);
  });

  it.each(['Hola, estimada María, la asesora llegará.', 'Hola, María. Ella llegará.', 'Hola, estimada inversión. La proyección mejora.', 'Hola, estimada María López. Continuamos.'])('does not interpret an ambiguous address: %s', (reply) => {
    expect(run(reply, 'Información', 'Ana')).toBe(reply);
  });

  it.each(['STOP', 'No me contacte', 'Es una emergencia'])('does not alter sensitive turns: %s', (message) => {
    expect(run('Entendido. No volveremos a escribir.', message)).toBe('Entendido. No volveremos a escribir.');
  });
});

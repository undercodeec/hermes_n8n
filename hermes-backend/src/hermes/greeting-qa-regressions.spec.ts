import { polishCustomerGreeting, resolveCustomerSalutation } from './customer-salutation';
import { HermesService } from './hermes.service';

describe('greeting QA regressions', () => {
  it.each(['Batman', 'La Pantera', 'Ventas', 'Ana'])('never inserts contact aliases or names in a missing greeting: %s', (name) => {
    const input = { reply: 'Le comparto información.\n\nhttps://example.test/a', customerMessage: 'Hola', firstReply: true, salutation: resolveCustomerSalutation(name) };
    const expected = `Hola, con gusto. ${input.reply}`;
    expect(polishCustomerGreeting(input)).toBe(expected);
    expect(polishCustomerGreeting({ ...input, reply: expected })).toBe(expected);
  });
  it('preserves a greeting when its name may be the antecedent of the next sentence', () => {
    const reply = 'Hola, estimada María. Ella enviará el enlace.';
    expect(polishCustomerGreeting({ reply, customerMessage: 'Hola', firstReply: true, salutation: resolveCustomerSalutation('Ana'), greetNormally: true })).toBe(reply);
  });

  it.each(['No quiero recibir más mensajes', 'Por favor eliminen mis datos'])('does not decorate a sensitive request: %s', (customerMessage) => {
    expect(polishCustomerGreeting({ reply: 'Entendido.', customerMessage, firstReply: true, salutation: resolveCustomerSalutation('Ana'), greetNormally: true })).toBe('Entendido.');
  });

  it('does not classify the business alias Ventas as a personal name', () => {
    expect(resolveCustomerSalutation('Ventas').firstName).toBeUndefined();
  });
  it.each([
    ['MRS', 'Hello, MRS. Body\n\nhttps://example.test/a', 'Hello, MRS. Body\n\nhttps://example.test/a'],
    ['Barbería Rita', 'Hola, estimada Barbería Rita. Body\n\nhttps://example.test/a', 'Hola, estimada Barbería Rita. Body\n\nhttps://example.test/a'],
  ])('preserves even an invalid contact header and its body: %s', (contactName, reply, expected) => {
    const input = { reply, contactName, customerMessage: 'Información', firstReply: true, salutation: resolveCustomerSalutation(contactName) };
    expect(polishCustomerGreeting(input)).toBe(expected);
    expect(polishCustomerGreeting({ ...input, reply: expected })).toBe(expected);
  });

  it('does not consume ambiguous or sensitive text', () => {
    const input = { contactName: 'Barbería Rita', customerMessage: 'Información', firstReply: true, salutation: resolveCustomerSalutation('Barbería Rita') };
    const reply = 'Hola, estimada Barbería Rita, la asesora llegará.';
    expect(polishCustomerGreeting({ ...input, reply })).toBe(reply);
    const sensitive = 'Hola, estimada Barbería Rita. No volveremos a escribir.';
    expect(polishCustomerGreeting({ ...input, reply: sensitive })).toBe(sensitive);
  });

  it('does not remove a corporate welcome or collapse its body in style cleanup', () => {
    const service = Object.create(HermesService.prototype) as HermesService;
    const reply = 'Hola. Bienvenido a Undercodeec.\n\nMaría enviará https://example.test/a';
    const result = (service as any).applySoftStyleCleanup(reply);
    expect(result.content).toBe(reply);
  });
});

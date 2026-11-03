import {
  explicitSalutationPreference,
  polishCustomerGreeting,
  resolveCustomerSalutation,
} from './customer-salutation';

describe('customer salutation', () => {
  test.each([
    ['Carlos Pérez', 'MASCULINE', 'Carlos', 'estimado'],
    ['Juan Gómez', 'MASCULINE', 'Juan', 'estimado'],
    ['María López', 'FEMININE', 'María', 'estimada'],
    ['Valentina Torres', 'FEMININE', 'Valentina', 'estimada'],
    ['José Luis Pérez', 'MASCULINE', 'José', 'estimado'],
    ['María José López', 'FEMININE', 'María', 'estimada'],
    ['Alex', 'UNKNOWN', 'Alex', undefined],
    ['Andrea', 'UNKNOWN', 'Andrea', undefined],
    ['Barbería Imperial', 'ORGANIZATION', undefined, undefined],
    ['Peluquería de Ana', 'ORGANIZATION', undefined, undefined],
    ['Taller Carlos', 'ORGANIZATION', undefined, undefined],
    ['Estética Bella', 'ORGANIZATION', undefined, undefined],
    ['Empresa XYZ', 'ORGANIZATION', undefined, undefined],
    ['Undercodeec', 'UNKNOWN', undefined, undefined],
    ['MRS', 'UNKNOWN', undefined, undefined],
    ['MR', 'UNKNOWN', undefined, undefined],
    ['SR', 'UNKNOWN', undefined, undefined],
    ['SRA', 'UNKNOWN', undefined, undefined],
    ['CLIENTE', 'UNKNOWN', undefined, undefined],
    ['UNKNOWN', 'UNKNOWN', undefined, undefined],
    ['593991234567', 'UNKNOWN', undefined, undefined],
    ['', 'UNKNOWN', undefined, undefined],
    ['Carlos 😀', 'UNKNOWN', undefined, undefined],
    ['Carlos<script>', 'UNKNOWN', undefined, undefined],
  ] as const)(
    '%s resolves conservatively',
    (name, kind, firstName, treatment) => {
      expect(resolveCustomerSalutation(name)).toMatchObject({
        kind,
        ...(firstName ? { firstName } : {}),
        ...(treatment ? { treatment } : {}),
      });
      if (!firstName)
        expect(resolveCustomerSalutation(name).firstName).toBeUndefined();
      if (!treatment)
        expect(resolveCustomerSalutation(name).treatment).toBeUndefined();
    },
  );

  it('honors an explicit request even when the name suggests another formula', () => {
    const preference = explicitSalutationPreference([
      'Hola',
      'Prefiero que me diga estimada, por favor.',
    ]);
    expect(resolveCustomerSalutation('Carlos Pérez', preference)).toMatchObject(
      {
        kind: 'FEMININE',
        treatment: 'estimada',
        source: 'EXPLICIT',
      },
    );
    expect(resolveCustomerSalutation('María López', 'estimado')).toMatchObject({
      kind: 'MASCULINE',
      treatment: 'estimado',
      source: 'EXPLICIT',
    });
    expect(
      explicitSalutationPreference(['No prefiero que me diga estimada.']),
    ).toBeUndefined();
  });

  it('preserves the commercial answer and removes duplicated or unsupported addresses', () => {
    const polish = (name: string, reply: string) =>
      polishCustomerGreeting({
        reply,
        customerMessage: 'Hola, quiero información de una página web.',
        firstReply: true,
        contactName: name,
        salutation: resolveCustomerSalutation(name),
      });
    expect(
      polish(
        'Carlos Pérez',
        'Hola, Carlos. Estimado Carlos. Con gusto le explico nuestras opciones.',
      ),
    ).toBe('Hola, estimado Carlos. Con gusto le explico nuestras opciones.');
    expect(
      polish(
        'María López',
        'Buenos días, estimada María. ¿En qué podemos ayudarle?',
      ),
    ).toBe('Buenos días, estimada María. ¿En qué podemos ayudarle?');
    expect(
      polish('Alex', 'Hola, estimado Alex. Le explico nuestras opciones.'),
    ).toBe('Hola, Alex. Le explico nuestras opciones.');
    expect(
      polish(
        'Barbería Imperial',
        'Hola, estimada Barbería Imperial. Le explico nuestras opciones.',
      ),
    ).toBe('Hola. Le explico nuestras opciones.');
    expect(
      polish(
        'Barbería Imperial',
        'Hola, Barbería Imperial. Le explico nuestras opciones.',
      ),
    ).toBe('Hola. Le explico nuestras opciones.');
    expect(
      polish('Carlos Pérez', 'Con gusto le explico nuestras opciones.'),
    ).toBe('Hola, estimado Carlos. Con gusto le explico nuestras opciones.');
  });

  it('does not repeat a formal address on later turns', () => {
    const salutation = resolveCustomerSalutation('Carlos Pérez');
    expect(
      polishCustomerGreeting({
        reply: 'Estimado Carlos. El precio depende del alcance.',
        customerMessage: '¿Cuánto cuesta?',
        firstReply: false,
        salutation,
      }),
    ).toBe('El precio depende del alcance.');
    expect(
      polishCustomerGreeting({
        reply: 'El precio depende del alcance.',
        customerMessage: '¿Cuánto cuesta?',
        firstReply: false,
        salutation,
      }),
    ).toBe('El precio depende del alcance.');
    expect(
      polishCustomerGreeting({
        reply: 'Hola, estimado Carlos. Le explico el plazo.',
        customerMessage: 'Hola otra vez',
        firstReply: false,
        salutation,
      }),
    ).toBe('Hola. Le explico el plazo.');
  });
});

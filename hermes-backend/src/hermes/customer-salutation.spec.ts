import {
  explicitSalutationPreference,
  polishCustomerGreeting,
  resolveCustomerSalutation,
} from './customer-salutation';

describe('sensitive grouped turns', () => {
  it.each(['STOP', 'Hay una emergencia'])('does not decorate a normal-looking first part when another part is sensitive: %s', (sensitive) => {
    expect(polishCustomerGreeting({
      reply: 'Su solicitud fue recibida.',
      customerMessage: 'Hola',
      safetyMessage: `Hola\n${sensitive}`,
      firstReply: true,
      greetNormally: true,
      salutation: resolveCustomerSalutation('Rita'),
    })).toBe('Su solicitud fue recibida.');
  });
});

describe('courtesy salutation (not a gender identity classification)', () => {
  it.each([
    ['Rita Muñoz', 'UNKNOWN', 'Rita', undefined],
    ['Carlos Pérez', 'UNKNOWN', 'Carlos', undefined],
    ['Ana María', 'UNKNOWN', 'Ana', undefined],
    ['Carlos Andrés', 'UNKNOWN', 'Carlos', undefined],
    ['Ana Marketing', 'ORGANIZATION', undefined, undefined],
    ['Carlos Tech', 'ORGANIZATION', undefined, undefined],
    ['María López', 'UNKNOWN', 'María', undefined],
    ['José Luis', 'UNKNOWN', 'José', undefined],
    ['Alex', 'UNKNOWN', 'Alex', undefined],
    ['Andrea', 'UNKNOWN', 'Andrea', undefined],
    ['Barbería de Rita', 'ORGANIZATION', undefined, undefined],
    ['Carlos Empresa', 'ORGANIZATION', undefined, undefined],
    ['Carlos & Co.', 'UNKNOWN', undefined, undefined],
    ['Rita Studio', 'ORGANIZATION', undefined, undefined],
    ['Rita Boutique', 'ORGANIZATION', undefined, undefined],
    ['Boutique Rita', 'ORGANIZATION', undefined, undefined],
    ['Carlos123', 'UNKNOWN', undefined, undefined],
    ['@rita', 'UNKNOWN', undefined, undefined],
    ['Carlos 😀', 'UNKNOWN', undefined, undefined],
    ['Carlos<script>', 'UNKNOWN', undefined, undefined],
    ['cliente', 'UNKNOWN', undefined, undefined],
    ['Undercodeec', 'UNKNOWN', undefined, undefined],
    ['', 'UNKNOWN', undefined, undefined],
    [null, 'UNKNOWN', undefined, undefined],
  ] as const)('%s: conservative naming', (name, kind, firstName, treatment) => {
    const actual = resolveCustomerSalutation(name);
    expect(actual.kind).toBe(kind);
    expect(actual.firstName).toBe(firstName);
    expect(actual.treatment).toBe(treatment);
  });

  it('honors the latest direct request or refusal without reading quotations or third parties', () => {
    const initial = 'Prefiero que me diga estimada.';
    for (const refusal of [
      'No me diga estimada.',
      'Deje de llamarme estimada.',
      'Prefiero que no me diga estimada.',
      'No prefiero que me diga estimada.',
    ]) {
      expect(explicitSalutationPreference([initial, refusal])).toBeNull();
      expect(explicitSalutationPreference([refusal, initial])).toBe('estimada');
    }
    expect(
      explicitSalutationPreference([`${initial} No me diga estimada.`]),
    ).toBeNull();
    expect(
      explicitSalutationPreference(['Hola\n\nPrefiero que me diga estimada.']),
    ).toBe('estimada');
    expect(
      explicitSalutationPreference(['Hola\n\nNo me diga estimada.', initial]),
    ).toBe('estimada');
    expect(
      explicitSalutationPreference([initial, 'Hola\n\nNo me diga estimada.']),
    ).toBeNull();
    expect(
      explicitSalutationPreference([
        '"Hola\n\nPrefiero que me diga estimada."',
      ]),
    ).toBeUndefined();
    expect(
      explicitSalutationPreference([
        'Rita dice:\n\nPrefiero que me diga estimada.',
      ]),
    ).toBeUndefined();
    expect(
      explicitSalutationPreference([
        'Rita dice: "Prefiero que me diga estimada."',
      ]),
    ).toBeUndefined();
    expect(
      explicitSalutationPreference([
        'Si alguien pide: Prefiero que me diga estimada.',
      ]),
    ).toBeUndefined();
  });

  it('honors informal refusals over historic preferences and name inference', () => {
    const preference = 'Prefiero que me diga estimada.';
    for (const refusal of [
      'No me llames estimada',
      'No me digas estimada, por favor.',
      'Prefiero que no me trates de estimada.',
      'No quiero que me llames estimada.',
    ]) {
      const resolved = explicitSalutationPreference([preference, refusal]);
      expect(resolved).toBeNull();
      expect(resolveCustomerSalutation('Rita', resolved)).toEqual({ kind: 'UNKNOWN', firstName: 'Rita', source: 'EXPLICIT' });
      expect(polishCustomerGreeting({ reply: 'Hola, estimada Rita. Le cuento.', customerMessage: refusal, firstReply: true, salutation: resolveCustomerSalutation('Rita', resolved) })).toBe('Hola, estimada Rita. Le cuento.');
      expect(explicitSalutationPreference([refusal, preference])).toBe('estimada');
    }
    expect(explicitSalutationPreference([preference, 'Ella dijo: "No me llames estimada"'])).toBe('estimada');
    expect(explicitSalutationPreference([preference, '[Mensaje 1, TEXT] Hola\n[Mensaje 2, TEXT] No me llames estimada'])).toBeNull();
  });

  it.each([
    'No quiero que me diga estimada, gracias.',
    'No me diga estimado, muchas gracias.',
    'No quiero que me llame estimada, por favor.',
  ])('does not infer a gendered treatment after a direct refusal: %s', (refusal) => {
    const preference = explicitSalutationPreference(['Prefiero que me diga estimada.', refusal]);
    expect(preference).toBeNull();
    const salutation = resolveCustomerSalutation('Ana', preference);
    expect(salutation).toEqual({ kind: 'UNKNOWN', firstName: 'Ana', source: 'EXPLICIT' });
    expect(polishCustomerGreeting({ reply: 'Hola, estimada Ana. Le ayudo.', customerMessage: refusal, firstReply: true, salutation })).toBe('Hola, estimada Ana. Le ayudo.');
    expect(explicitSalutationPreference(['Ella dijo: "No quiero que me diga estimada, gracias."'])).toBeUndefined();
  });

  it('uses only a direct affirmative preference, not a guess or a negation', () => {
    expect(
      explicitSalutationPreference(['Hola', 'Prefiero que me diga estimada.']),
    ).toBe('estimada');
    expect(explicitSalutationPreference(['Llámeme estimado, por favor.'])).toBe(
      'estimado',
    );
    expect(
      explicitSalutationPreference(['Prefiero que me llamen estimada.']),
    ).toBe('estimada');
    expect(
      explicitSalutationPreference(['Prefiero que me traten estimado.']),
    ).toBe('estimado');
    expect(
      explicitSalutationPreference([
        'Prefiero que me diga estimada.',
        'Prefiero que me diga estimado.',
      ]),
    ).toBe('estimado');
    expect(
      explicitSalutationPreference(['No prefiero que me diga estimada.']),
    ).toBeNull();
    expect(
      explicitSalutationPreference(['Prefiero que no me diga estimada.']),
    ).toBeNull();
    expect(
      explicitSalutationPreference(['Si me llamas estimado, sería raro.']),
    ).toBeUndefined();
    expect(
      explicitSalutationPreference(['estimada es un ejemplo de palabra']),
    ).toBeUndefined();
    expect(
      explicitSalutationPreference([
        'Prefiero que me diga estimada.',
        'No prefiero que me diga estimada.',
      ]),
    ).toBeNull();
    expect(
      explicitSalutationPreference(['El texto dice "prefiero ser estimada".']),
    ).toBeUndefined();
    expect(resolveCustomerSalutation('Carlos Pérez', 'estimada')).toMatchObject(
      {
        treatment: 'estimada',
        source: 'EXPLICIT',
        firstName: 'Carlos',
      },
    );
    expect(
      resolveCustomerSalutation('Barbería Rita', 'estimada'),
    ).toMatchObject({
      kind: 'ORGANIZATION',
      source: 'ORGANIZATION',
    });
    expect(resolveCustomerSalutation(null, 'estimada')).toMatchObject({
      treatment: 'estimada',
      source: 'EXPLICIT',
    });
    for (const refusal of [
      'No me diga estimada.',
      'Deje de llamarme estimada.',
    ]) {
      expect(
        resolveCustomerSalutation(
          'Rita Muñoz',
          explicitSalutationPreference([
            'Prefiero que me diga estimada.',
            refusal,
          ]),
        ),
      ).toEqual({ kind: 'UNKNOWN', firstName: 'Rita', source: 'EXPLICIT' });
    }
    expect(resolveCustomerSalutation('Rita Boutique', null)).toEqual({
      kind: 'ORGANIZATION',
      source: 'ORGANIZATION',
    });
    expect(
      polishCustomerGreeting({
        reply: 'Hola, estimada Rita. Le cuento.',
        customerMessage: 'No me diga estimada.',
        firstReply: true,
        salutation: resolveCustomerSalutation('Rita Muñoz', null),
        contactName: 'Rita Muñoz',
      }),
    ).toBe('Hola, estimada Rita. Le cuento.');
  });

  it('recognizes direct preferences on each prefixed line of a grouped turn', () => {
    expect(
      explicitSalutationPreference([
        '[Mensaje 1, TEXT] Prefiero que me diga estimada.\n[Mensaje 2, TEXT] No me diga estimada.',
      ]),
    ).toBeNull();
    expect(
      explicitSalutationPreference([
        '[Mensaje 1, TEXT] No me diga estimada.\n[Mensaje 2, TEXT] Prefiero que me diga estimado.',
      ]),
    ).toBe('estimado');
    expect(
      explicitSalutationPreference([
        '[Mensaje 1, TEXT] Rita dice: "No me diga estimada."\n[Mensaje 2, TEXT] Prefiero que me diga estimada.',
      ]),
    ).toBe('estimada');
    expect(
      explicitSalutationPreference([
        '[Mensaje 1, TEXT] Prefiero que me diga estimada.\n[Mensaje 2, TEXT] Rita dice: "No me diga estimada."',
      ]),
    ).toBe('estimada');
    expect(
      explicitSalutationPreference([
        '[Mensaje 1, TEXT] Rita dice:\nNo me diga estimada.',
      ]),
    ).toBeUndefined();
  });

  const polish = (name: string, reply: string, firstReply = true) =>
    polishCustomerGreeting({
      reply,
      customerMessage: firstReply ? 'Hola, necesito información.' : 'Necesito información.',
      firstReply,
      salutation: resolveCustomerSalutation(name),
      contactName: name,
    });

  it.each([
    ['Rita Muñoz', 'Hola, Rita. Estimada Rita. Le cuento.', true, 'Hola, Rita. Estimada Rita. Le cuento.'],
    ['Carlos Pérez', 'Estimado Carlos. Le cuento.', true, 'Estimado Carlos. Le cuento.'],
    ['Alex', 'Hola, estimado Alex. Le cuento.', true, 'Hola, estimado Alex. Le cuento.'],
    ['Barbería Rita', 'Hola, estimada Barbería Rita. Le cuento.', true, 'Hola, estimada Barbería Rita. Le cuento.'],
    ['Barbería Rita', 'Hola, Barbería Rita. Le cuento.', true, 'Hola, Barbería Rita. Le cuento.'],
    ['Carlos Pérez', 'Hola, estimado Carlos. Le cuento.', false, 'Hola, estimado Carlos. Le cuento.'],
    ['Carlos Pérez', 'Estimado Carlos. Le cuento.', false, 'Estimado Carlos. Le cuento.'],
    ['Rita Muñoz', 'Hola. Le cuento.', false, 'Hola. Le cuento.'],
    ['Carlos Pérez', 'Buenas tardes, estimada Rita. Le cuento.', false, 'Buenas tardes, estimada Rita. Le cuento.'],
    ['Rita Muñoz', '¡Hola, estimada Rita! Le cuento.', true, '¡Hola, estimada Rita! Le cuento.'],
    ['Rita Muñoz', 'Hola, Carlos. Le cuento.', true, 'Hola, Carlos. Le cuento.'],
    ['Rita Muñoz', 'Hola Carlos, le cuento.', true, 'Hola Carlos, le cuento.'],
    ['Rita Muñoz', 'Hola, Carlos. Carlos aprobó la visita.', true, 'Hola, Carlos. Carlos aprobó la visita.'],
    ['Rita Muñoz', 'Hola, Carlos. Le cuento.', false, 'Hola, Carlos. Le cuento.'],
    ['Ana Marketing', 'Hola, estimada Ana. Le cuento.', true, 'Hola, estimada Ana. Le cuento.'],
    ['Rita Boutique', 'Hola, Rita. Le cuento.', true, 'Hola, Rita. Le cuento.'],
    ['Rita Muñoz', 'Estimada inversión: buena decisión.', true, 'Estimada inversión: buena decisión.'],
    ['Rita Muñoz', 'Hola. Estimada inversión: buena decisión.', true, 'Hola. Estimada inversión: buena decisión.'],
  ] as const)('reviews greeting independently: %s / %s / first=%s', (name, reply, firstReply, expected) => {
    expect(polish(name, reply, firstReply)).toBe(expected);
  });

  it('preserves bare names when they may be body text', () => {
    expect(polish('Rita Muñoz', 'Hola Carlos le cuento.')).toBe(
      'Hola Carlos le cuento.',
    );
    expect(polish('Rita Muñoz', 'Hola Carlos le explico.')).toBe(
      'Hola Carlos le explico.',
    );
    expect(polish('Rita Muñoz', 'Hola Carlos podemos revisar esto.')).toBe(
      'Hola Carlos podemos revisar esto.',
    );
    expect(polish('Rita Muñoz', 'Hola Carlos trabaja en ventas.')).toBe(
      'Hola Carlos trabaja en ventas.',
    );
    expect(polish('Rita Muñoz', 'Hola Alex le cuento.')).toBe(
      'Hola Alex le cuento.',
    );
    expect(polish('Rita Muñoz', 'Hola, Rita. Carlos le cuento.')).toBe(
      'Hola, Rita. Carlos le cuento.',
    );
    expect(polish('Rita Muñoz', 'Hola Carlos le cuento.', false)).toBe(
      'Hola Carlos le cuento.',
    );
    const body =
      'le cuento: https://example.test/carlos\n\nCarlos trabaja en ventas.';
    expect(polish('Rita Muñoz', `Hola Carlos ${body}`)).toBe(
      `Hola Carlos ${body}`,
    );
  });

  it('preserves existing greetings and their bodies, including case and URLs', () => {
    expect(polish('Rita Muñoz', 'Hola, Carlos. le cuento.')).toBe(
      'Hola, Carlos. le cuento.',
    );
    expect(polish('Rita Muñoz', 'Hola, Carlos. https://example.test/le')).toBe(
      'Hola, Carlos. https://example.test/le',
    );
    expect(polish('Rita Muñoz', 'Hola, Carlos. API disponible.')).toBe(
      'Hola, Carlos. API disponible.',
    );
    expect(polish('Rita Muñoz', 'Hola, Carlos. "le cuento".')).toBe(
      'Hola, Carlos. "le cuento".',
    );
    expect(polish('Rita Muñoz', 'Hola. le cuento.', false)).toBe(
      'Hola. le cuento.',
    );
    expect(polish('Rita Muñoz', 'Hola, Carlos. le cuento.', false)).toBe(
      'Hola, Carlos. le cuento.',
    );
  });

  it.each([
    ['Hola, Carlos. María, la asesora, lo contactará.', 'Hola, Carlos. María, la asesora, lo contactará.'],
    ['Hola, Carlos. José, el asesor, llamó.', 'Hola, Carlos. José, el asesor, llamó.'],
    ['Hola, Ana. Ana, la asesora, llamó.', 'Hola, Ana. Ana, la asesora, llamó.'],
    ['Hola, Ana, la asesora, llamó.', 'Hola, Ana, la asesora, llamó.'],
    ['Hola, Carlos, el asesor, llamó.', 'Hola, Carlos, el asesor, llamó.'],
    ['Hola. María. Ella revisará el contrato.', 'Hola. María. Ella revisará el contrato.'],
    ['Hola. Estimada María, la asesora, llamó.', 'Hola. Estimada María, la asesora, llamó.'],
    ['Hola, Carlos. María: revisará el contrato.', 'Hola, Carlos. María: revisará el contrato.'],
    ['Hola, Carlos. Estimada María, la asesora revisará el contrato.', 'Hola, Carlos. Estimada María, la asesora revisará el contrato.'],
    ['Hola, Ana, ¿puede revisar el contrato?', 'Hola, Ana, ¿puede revisar el contrato?'],
    ['Hola, Ana: ¡qué buena noticia!', 'Hola, Ana: ¡qué buena noticia!'],
    ['Hola, Carlos. ¿puede revisar https://ejemplo.test/ana?x=1&y=2?', 'Hola, Carlos. ¿puede revisar https://ejemplo.test/ana?x=1&y=2?'],
    ['Hola, Carlos. https://ejemplo.test/maria?x=1&y=2', 'Hola, Carlos. https://ejemplo.test/maria?x=1&y=2'],
  ])('preserves existing greeting and third-party content: %s', (reply, expected) => {
    expect(polish('Ana', reply)).toBe(expected);
    expect(polish('Ana', expected)).toBe(expected);
  });

  it.each([
    'Maria, nuestra asesora, le enviara el contrato.',
    'María, mi colega, enviará el contrato.',
    'Carlos, tu asesor, llamó.',
    'Ana, nuestra nueva asesora, llamó.',
    'Rita, excellente conseillère, vous contactera.',
    'Maria, our adviser, will send the contract.',
    'José, su asesor de ventas, dejó https://ejemplo.test/contrato?a=1&b=2.',
    'Ana: nuestra asesora enviará el contrato.',
    'Carlos le contará a María los detalles.',
  ])('preserves ambiguous body in initial greetings: %s', (body) => {
    const reply = `Hola, ${body}`;
    expect(polish('Ana', reply)).toBe(reply);
  });

  it('preserves openings and bare names', () => {
    expect(polish('Rita Muñoz', 'Hola, por favor envíeme el enlace.')).toBe('Hola, por favor envíeme el enlace.');
    expect(polish('Rita Muñoz', 'Hola, Rita le cuento.')).toBe('Hola, Rita le cuento.');
    expect(polish('Rita Muñoz', 'Hola, Rita trabaja en ventas.')).toBe('Hola, Rita trabaja en ventas.');
    expect(polish('Rita Muñoz', 'Hola, https://example.test/a?x=1&y=2')).toBe('Hola, https://example.test/a?x=1&y=2');
    expect(polish('Rita Muñoz', 'Hola, "por favor" es una cita.')).toBe('Hola, "por favor" es una cita.');
  });

  it('is idempotent and preserves links and multipart body verbatim', () => {
    const body =
      'Le paso la información: https://example.test/a?x=1&y=2\n\nParte 2: *precio* $10.';
    const once = polish('Rita Muñoz', `Hola, Rita. ${body}`);
    expect(once).toBe(`Hola, Rita. ${body}`);
    expect(polish('Rita Muñoz', once)).toBe(once);
    expect(polish('Rita Muñoz', `Hola, estimada Rita.\n\n${body}`)).toBe(
      `Hola, estimada Rita.\n\n${body}`,
    );
    const linkOnly = 'https://example.test/a?x=1&y=2';
    expect(polish('Rita Muñoz', linkOnly)).toBe(`Hola, con gusto. ${linkOnly}`);
    expect(polish('Rita Muñoz', 'STOP: no responder.')).toBe(
      'STOP: no responder.',
    );
    expect(
      polish('Rita Muñoz', 'Confirmamos su baja. No volveremos a escribirle.'),
    ).toBe('Confirmamos su baja. No volveremos a escribirle.');
    expect(polish('Rita Muñoz', 'Se deriva a un humano.', false)).toBe(
      'Se deriva a un humano.',
    );
    expect(
      polish('Rita Muñoz', 'Hola, Rita. Le ayudo. Saludos cordiales.'),
    ).toBe('Hola, Rita. Le ayudo. Saludos cordiales.');
  });

  it('corresponds to a greeting when a normal greeting is not requested', () => {
    const run = (customerMessage: string, reply: string, firstReply = false, name = 'Alex') =>
      polishCustomerGreeting({ customerMessage, reply, firstReply, salutation: resolveCustomerSalutation(name), contactName: name });
    expect(run('Hola, necesito información', 'En este caso podemos ayudarle.', true)).toBe('Hola, con gusto. En este caso podemos ayudarle.');
    expect(run('Buenos días, volví', 'Podemos continuar.')).toBe('Hola, con gusto. Podemos continuar.');
    expect(run('¿Y el precio?', 'Podemos continuar.')).toBe('Podemos continuar.');
    expect(run('Hola', 'Hola, buenos días. En eso podemos ayudarle.', false, 'Tienda Rita')).toBe('Hola, buenos días. En eso podemos ayudarle.');
    expect(run('Hola', 'Hola. En eso podemos ayudarle.', false, 'Tienda Rita')).toBe('Hola. En eso podemos ayudarle.');
    expect(run('Hola', 'Hola, con gusto. En eso podemos ayudarle.', false, 'Tienda Rita')).toBe('Hola, con gusto. En eso podemos ayudarle.');
    const once = run('Hola', 'Podemos continuar.', true, 'Rita');
    expect(run('Hola', once, true, 'Rita')).toBe(once);
    expect(run('Hola, STOP', 'Confirmamos su baja.')).toBe('Confirmamos su baja.');
    expect(run('Hola', 'https://example.test/a')).toBe('Hola, con gusto. https://example.test/a');
  });

  it('adds the neutral greeting on later normal turns without changing the body', () => {
    const run = (reply: string) => polishCustomerGreeting({
      customerMessage: '¿Y los detalles?', reply, firstReply: false,
      greetNormally: true, salutation: resolveCustomerSalutation('Ana'), contactName: 'Ana',
    });
    expect(run('Con gusto le comparto los detalles.')).toBe('Hola, con gusto. Con gusto le comparto los detalles.');
    expect(run('podemos continuar con su proyecto.')).toBe('Hola, con gusto. podemos continuar con su proyecto.');
    expect(run('Hola, con gusto. Podemos continuar.')).toBe('Hola, con gusto. Podemos continuar.');
    expect(run('"podemos" es una cita.')).toBe('Hola, con gusto. "podemos" es una cita.');
  });
});

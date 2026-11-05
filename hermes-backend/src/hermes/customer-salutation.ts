/** A courtesy formula for a message, never a statement about a person's identity. */
export type CustomerSalutationKind =
  | 'MASCULINE'
  | 'FEMININE'
  | 'UNKNOWN'
  | 'ORGANIZATION';

export type CustomerSalutation = {
  kind: CustomerSalutationKind;
  firstName?: string;
  treatment?: 'estimado' | 'estimada';
  source: 'EXPLICIT' | 'NAME' | 'ORGANIZATION' | 'UNKNOWN';
};

// Deliberately small: an unlisted or cross-market ambiguous name stays neutral.
const masculine = new Set([
  'carlos',
  'juan',
  'jose',
  'josé',
  'luis',
  'pedro',
  'miguel',
  'manuel',
  'antonio',
  'diego',
  'andres',
  'andrés',
  'francisco',
]);
const feminine = new Set([
  'maria',
  'maría',
  'valentina',
  'ana',
  'lucia',
  'lucía',
  'carmen',
  'isabel',
  'sofia',
  'sofía',
  'paula',
  'laura',
  'elena',
]);
const invalid =
  /^(?:mr|mrs|sr|sra|cliente|contacto|unknown|desconocido|usuario|undercodeec)$/iu;
const organization =
  /\b(?:barber[ií]a|peluquer[ií]a|sal[oó]n|est[eé]tica|spa|restaurante|tienda|taller|distribuidora|comercial|agencia|consultora|cl[ií]nica|estudio|servicios|empresa|compa[nñ][ií]a|c[ií]a\.?\s*ltda\.?|s\.?\s*l\.?|s\.?\s*a\.?\s*s\.?)\b/iu;
const personalName =
  /^[\p{L}\p{M}][\p{L}\p{M}'-]{0,39}(?:\s+[\p{L}\p{M}][\p{L}\p{M}'-]{0,39}){0,4}$/u;

/** Only direct requests for a form of address count as an explicit preference. */
export function explicitSalutationPreference(
  messages: string[],
): 'estimado' | 'estimada' | undefined {
  for (const message of [...messages].reverse()) {
    const match = message.match(
      /\b(?:prefiero|prefier[oa]|ll[aá]meme|d[ií]game|tr[aá]teme|dir[ií]jase\s+a\s+m[ií])\b[^.!?\n]{0,65}\b(estimad[oa])\b/iu,
    );
    if (
      match &&
      !/\bno\b/iu.test(match[0]) &&
      !/\bno\s*$/iu.test(
        message.slice(Math.max(0, (match.index ?? 0) - 8), match.index),
      )
    )
      return match[1].toLocaleLowerCase('es') as 'estimado' | 'estimada';
  }
  return undefined;
}

export function resolveCustomerSalutation(
  contactName: string | null | undefined,
  explicitPreference?: 'estimado' | 'estimada',
): CustomerSalutation {
  const name = contactName?.trim().replace(/\s+/gu, ' ') ?? '';
  const isOrganization = organization.test(name);
  const valid =
    name.length <= 100 &&
    personalName.test(name) &&
    !name.split(' ').some((part) => invalid.test(part)) &&
    !/\d/u.test(name);
  const firstName = valid && !isOrganization ? name.split(' ')[0] : undefined;
  if (explicitPreference) {
    return {
      kind: explicitPreference === 'estimado' ? 'MASCULINE' : 'FEMININE',
      ...(firstName ? { firstName } : {}),
      treatment: explicitPreference,
      source: 'EXPLICIT',
    };
  }
  if (isOrganization) return { kind: 'ORGANIZATION', source: 'ORGANIZATION' };
  if (!firstName) return { kind: 'UNKNOWN', source: 'UNKNOWN' };
  const normalized = firstName.toLocaleLowerCase('es');
  if (masculine.has(normalized))
    return {
      kind: 'MASCULINE',
      firstName,
      treatment: 'estimado',
      source: 'NAME',
    };
  if (feminine.has(normalized))
    return {
      kind: 'FEMININE',
      firstName,
      treatment: 'estimada',
      source: 'NAME',
    };
  return { kind: 'UNKNOWN', firstName, source: 'UNKNOWN' };
}

const opening =
  /^(?:¡\s*)?(Hola|Buenas(?:\s+(?:tardes|noches))?|Buenos\s+d[ií]as|Buen\s+d[ií]a)\b/iu;
const formalAddress = /^estimad[oa](?:\s+[\p{L}\p{M}'-]+){0,3}\s*[.,!:;]\s*/iu;

/** Repairs only the leading address, preserving the commercial content after it. */
export function polishCustomerGreeting(input: {
  reply: string;
  customerMessage: string;
  firstReply: boolean;
  salutation: CustomerSalutation;
  contactName?: string;
}): string {
  const reply = input.reply.trim();
  if (!reply) return reply;
  const startsWithGreeting = opening.test(reply);
  const startsWithFormal = formalAddress.test(reply);
  const customerGreeted = opening.test(input.customerMessage.trim());
  if (
    !startsWithGreeting &&
    !startsWithFormal &&
    !(input.firstReply && customerGreeted)
  )
    return reply;

  // Later turns may correspond to a new greeting, but never repeat a formal title.
  const greeting = startsWithGreeting ? reply.match(opening)![1] : 'Hola';
  let rest = startsWithGreeting ? reply.replace(opening, '') : reply;
  rest = rest.replace(/^[\s,.!¡:;]+/u, '');
  const addressName = input.salutation.firstName;
  const escapedName = addressName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawName = input.contactName?.trim();
  const escapedRawName = rawName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < 3; i++) {
    const previous = rest;
    rest = rest.replace(formalAddress, '');
    if (escapedName)
      rest = rest.replace(
        new RegExp(`^${escapedName}\\s*[.,!:;]\\s*`, 'iu'),
        '',
      );
    if (escapedRawName && escapedRawName !== escapedName)
      rest = rest.replace(
        new RegExp(`^${escapedRawName}\\s*[.,!:;]\\s*`, 'iu'),
        '',
      );
    rest = rest.replace(
      /^(?:mr|mrs|sr|sra|cliente|unknown)\s*[.,!:;]\s*/iu,
      '',
    );
    rest = rest.replace(opening, '').replace(/^[\s,.!¡:;]+/u, '');
    if (rest === previous) break;
  }
  rest = rest.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase('es'));
  // Do not put a greeting in a technical or operational response with no opening.
  if (!input.firstReply && startsWithFormal && !startsWithGreeting) return rest;
  const address = input.firstReply
    ? input.salutation.treatment
      ? `, ${input.salutation.treatment}${addressName ? ` ${addressName}` : ''}`
      : addressName
        ? `, ${addressName}`
        : ''
    : '';
  return `${greeting}${address}. ${rest}`.trim();
}

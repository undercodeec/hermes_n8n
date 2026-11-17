/** Courtesy wording only: a name is not evidence of a person's gender identity. */
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

const organization =
  /\b(?:barber[ií]a|peluquer[ií]a|sal[oó]n|est[eé]tica|spa|restaurante|tienda|boutique|shop|store|taller|distribuidora|comercial|agencia|consultora|cl[ií]nica|estudio|studio|servicios|empresa|compa[nñ][ií]a|marketing|tech|digital|media|solutions|consulting|agency|ltda|s\.?\s*a\.?\s*s\.?|s\.?\s*a\.?|s\.?\s*l\.?)\b/iu;
const placeholder =
  /^(?:mr|mrs|sr|sra|señor|señora|cliente|contacto|usuario|unknown|desconocido|undercodeec|admin|soporte|ventas|test|prueba)$/iu;
const nameShape =
  /^[\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)?(?: [\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)?){0,3}$/u;

/** undefined = no request; null = explicit refusal (never infer from a name). */
export type ExplicitSalutationPreference =
  | 'estimado'
  | 'estimada'
  | null
  | undefined;

/** Reads only direct requests for a form of address. Latest request wins. */
export function explicitSalutationPreference(
  messages: string[],
): ExplicitSalutationPreference {
  for (const message of [...messages].reverse()) {
    // Grouped turns prefix *each* line, not just the first. Treat each marked
    // turn independently while preserving unmarked multiline quotations/context.
    const turns: string[] = [];
    for (const line of message.split(/\r?\n/u)) {
      const marker = /^\[Mensaje \d+, [A-Z_]+\][ \t]+/u.exec(line);
      if (marker || !turns.length)
        turns.push(line.slice(marker?.[0].length ?? 0));
      else turns[turns.length - 1] += `\n${line}`;
    }
    for (const turn of turns.reverse()) {
      // Do not attribute quoted or third-party text to this customer.
      if (/["“”«»]/u.test(turn)) continue;
      const clauses = turn.split(/\r?\n+|(?<=[.!?])\s+(?=\p{Lu})/u);
      for (let i = clauses.length - 1; i >= 0; i--) {
        const raw = clauses[i];
        if (i > 0 && /:\s*$/u.test(clauses[i - 1])) continue;
        const clause = raw
          .trim()
          .replace(
            /^(?:(?:hola|buenos d[ií]as|buenas(?: tardes| noches)?|por favor)[,!.:; ]+)+/iu,
            '',
          )
          .trim();
        // A refusal is a decision too: never fall back to an earlier opt-in.
        if (
          /^(?:no (?:prefiero|quiero) que me (?:diga[n]?|digas|llame[n]?|llames|trate[n]?|trates)|no me (?:diga[n]?|digas|llame[n]?|llames|trate[n]?|trates)(?: de)?|prefiero que no me (?:diga[n]?|digas|llame[n]?|llames|trate[n]?|trates)(?: de)?|deje(?:n)? de (?:llamarme|decirme|tratarme)(?: de)?)\s+estimad[oa](?:,?\s+(?:por favor|(?:muchas\s+)?gracias))?[.!?]?$/iu.test(
            clause,
          )
        )
          return null;
        const request =
          /^(?:prefiero (?:que (?:me|se) (?:llames?|llamen|digas?|diga[n]?|trates?|trate[n]?)|ser|el trato de)|ll[aá]meme|d[ií]game|tr[aá]teme|dir[ií]jase a m[ií])\s+(?:de\s+)?(estimad[oa])(?:,?\s+por favor)?[.!?]?$/iu.exec(
            clause,
          );
        if (request)
          return request[1].toLocaleLowerCase('es') as 'estimado' | 'estimada';
      }
    }
  }
  return undefined;
}

export function resolveCustomerSalutation(
  contactName: string | null | undefined,
  explicitPreference?: ExplicitSalutationPreference,
): CustomerSalutation {
  const name = contactName?.trim().replace(/\s+/gu, ' ') ?? '';
  if (organization.test(name))
    return { kind: 'ORGANIZATION', source: 'ORGANIZATION' };
  // A string containing a URL, handle, number, punctuation, or a title is not
  // reliably a person's name. Keep it out of the generated greeting as well.
  if (
    name.length > 80 ||
    !nameShape.test(name) ||
    name.split(' ').some((part) => placeholder.test(part)) ||
    name
      .split(' ')
      .slice(1)
      .some((part) => !/^\p{Lu}/u.test(part))
  ) {
    return explicitPreference
      ? {
          kind: explicitPreference === 'estimado' ? 'MASCULINE' : 'FEMININE',
          treatment: explicitPreference,
          source: 'EXPLICIT',
        }
      : { kind: 'UNKNOWN', source: 'UNKNOWN' };
  }
  const firstName = name.split(' ')[0];
  if (explicitPreference === null)
    return { kind: 'UNKNOWN', firstName, source: 'EXPLICIT' };
  if (explicitPreference)
    return {
      kind: explicitPreference === 'estimado' ? 'MASCULINE' : 'FEMININE',
      firstName,
      treatment: explicitPreference,
      source: 'EXPLICIT',
    };
  return { kind: 'UNKNOWN', firstName, source: 'UNKNOWN' };
}

const opening =
  /^[¡¿\s]*(?:hola|hello|hi|hey|saludos|qu[eé]\s+tal|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|buen\s+d[ií]a|estimad[oa])(?=[\s,.!:;¡!¿?]|$)/iu;

export function isSensitiveGreetingTurn(customerMessage: string, reply: string): boolean {
  return /\b(?:stop|baja|no (?:me |nos )?(?:escriba\w*|contacte\w*|respond\w*)|no (?:quiero|deseo) recibir m[aá]s mensajes|elimin(?:e|en|ar) (?:mis|nuestros) datos|no volveremos a escribir|emergencia|urgencia|peligro|suicid\w*|amenaza\w*|incidente de seguridad)\b/iu.test(`${customerMessage}\n${reply}`);
}

/** Preserve existing greetings verbatim; only prefix a missing greeting. */
export function polishCustomerGreeting(input: {
  reply: string;
  customerMessage: string;
  firstReply: boolean;
  salutation: CustomerSalutation;
  contactName?: string;
  greetNormally?: boolean;
  safetyMessage?: string;
}): string {
  const { reply } = input;
  if (!reply || isSensitiveGreetingTurn(input.safetyMessage ?? input.customerMessage, reply)) return reply;
  if (opening.test(reply)) return reply;
  const customerOpening = input.customerMessage.replace(/^\[Mensaje \d+, [A-Z_]+\][ \t]*/u, '').trimStart();
  if (!input.greetNormally && !opening.test(customerOpening)) return reply;
  return `Hola, con gusto. ${reply}`;
}

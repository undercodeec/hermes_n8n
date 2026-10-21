const identifiers: Array<[string, RegExp]> = [
  [
    'UUID_PATTERN',
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  ],
  ['WAMID_PATTERN', /\bwamid\.[a-z0-9._=-]+/i],
  ['EMAIL_PATTERN', /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i],
  ['PHONE_PATTERN', /(?:^|[^\w])\+?\d[\d\s().-]{7,}\d\b/],
  ['PRIVATE_FIXTURE_MARKER', /\bPRIV_[A-Z]_[A-Z0-9_]+_[0-9A-F]{4,}\b/i],
  [
    'IDENTIFICATION_PATTERN',
    /\b(?:c[eé]dula|ruc|identificaci[oó]n|documento)\b.{0,20}\b\d{8,13}\b/i,
  ],
  [
    'ADDRESS_PATTERN',
    /\b(?:direcci[oó]n|domicilio|calle|avenida|av\.)\s*[:#-]?\s*(?:[\p{L}]+\s*){1,4}\d{1,5}\b/iu,
  ],
  [
    'SOURCE_QUOTE_PATTERN',
    /\b(?:cliente|contacto|mensaje|transcripci[oó]n)\b.{0,25}\b(?:dijo|escribi[oó]|literal|textual|afirm[oó])\s*[:«"']/iu,
  ],
  [
    'PRIVATE_NEED_PATTERN',
    /\b(?:necesidad|requisito|preferencia|situaci[oó]n)\s+(?:particular|espec[ií]fic[ao]|privad[ao])\s+(?:del|de la)\s+(?:cliente|contacto|lead)\b/iu,
  ],
  [
    'INTERNAL_ID_PATTERN',
    /\b(?:lead|conversation|message|feedback|review|user)[\s_:#-]+(?:[0-9a-f]{8,}|[a-z0-9_-]{12,})\b/i,
  ],
];

const personalReference = [
  /\b(?:[Rr]esponder a|[Dd]irigirse a|[Aa]tender a|[Cc]liente|[Cc]ontacto|[Uu]suario|[Ss]eñor(?:a)?)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/u,
  /\b(?:[Ee]l|[Ll]a)\s+(?:cliente|contacto|lead|usuario)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?(?=$|[^\p{L}])/u,
  /\b(?:[Rr]ecordar|[Aa]notar|[Ss]aber|[Tt]ener en cuenta)\s+que\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?=$|[^\p{L}])/u,
  /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+(?:necesita|quiere|pidió|solicitó|tiene)\b/u,
  /\b(?!Cliente\b|Hermes\b|Usuario\b|Contacto\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+(?:necesita|quiere|pidió|solicitó|tiene)\b/u,
];

export function privacyFailure(text: string): string | null {
  for (const [code, pattern] of identifiers) {
    if (pattern.test(text)) return code;
  }
  return personalReference.some((pattern) => pattern.test(text))
    ? 'CLIENT_REFERENCE'
    : null;
}

/** Only conversational text is sent to the provider; database IDs are aliased separately. */
export function sanitizeReviewInput(text: string): string {
  let sanitized = text;
  for (const [code, pattern] of identifiers) {
    sanitized = sanitized.replace(
      new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`),
      `[${code}]`,
    );
  }
  sanitized = sanitized
    .replace(
      /\b(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy|[Ss]e llama|[Ll]lamado|[Ll]lamada)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?(?=$|[^\p{L}])/gu,
      '[NOMBRE]',
    )
    .replace(
      /\b(?:[Ee]l|[Ll]a)\s+(?:cliente|contacto|lead|usuario)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?(?=$|[^\p{L}])/gu,
      '[CLIENTE]',
    )
    .replace(
      /\b(?:[Hh]ola|[Gg]racias|[Ee]stimad[oa])\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?(?=$|[^\p{L}])/gu,
      '[SALUDO]',
    );
  for (const pattern of personalReference) {
    sanitized = sanitized.replace(
      new RegExp(pattern.source, 'gu'),
      '[REFERENCIA_CLIENTE]',
    );
  }
  return sanitized.slice(0, 500);
}

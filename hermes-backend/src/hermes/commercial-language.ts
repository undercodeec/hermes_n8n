/** Split only at clause boundaries; conjunctions in amounts and feature lists stay intact. */
export function commercialClauses(text: string): string[] {
  return text
    .split(
      /(?<=[.!?])\s+|;\s*|,?\s+pero\s+|\s+y\s+(?=(?:(?:el|la|los|las|un|una|su|sus|nuestro|nuestra)\s+[^.;!?]{1,60}?\s+(?:se\s+)?(?:paga\w*|abona\w*|requiere\w*|puede\w*|acepta\w*|cobra\w*|sin\s+(?:anticipo|abono))\b|(?:usted(?:es)?|con nosotros|undercodeec|nosotros|puede\w* pagar)\b))/iu,
    )
    .filter(Boolean);
}

export function joinReviewedClauses(
  original: string,
  clauses: string[],
  kept: string[],
): string {
  if (kept.length === clauses.length) return original;
  return kept
    .map((clause) => (/[.!?]$/u.test(clause) ? clause : `${clause}.`))
    .join(' ')
    .trim();
}

/** Benefit coverage is not a delivery promise, even when the user asks for a deadline. */
export function withoutBenefitDurations(text: string): string {
  return text
    .replace(
      /\b(?:soporte|hosting|mantenimiento)\s+(?:(?:por|durante|de)\s+)?\d+\s*(?:horas?|d[ií]as?|semanas?|meses?)\b/giu,
      '',
    )
    .replace(
      /\b\d+\s*(?:horas?|d[ií]as?|semanas?|meses?)\s+(?:de\s+)?(?:soporte|hosting|mantenimiento)\b/giu,
      '',
    );
}

export function deliveryQuantitiesIn(text: string): RegExpMatchArray[] {
  return [
    ...withoutBenefitDurations(text).matchAll(
      /\b(\d+)\s+(horas?|d[ií]as?|semanas?|meses?)\b/giu,
    ),
  ];
}

// Input is one normalized clause. A buyer exception never extends to another subject.
export function describesBuyerPayment(value: string): boolean {
  if (
    /\b(?:undercodeec|usted(?:es)?|nosotros|pagarnos|abonarnos|nos paga|proyecto|sitio|web|pagina|aplicacion|software|desarrollo|servicio contratado|trabajo|implementacion|nuestro servicio|trabajamos|cobramos|aceptamos)\b/.test(
      value,
    )
  )
    return false;
  return (
    /\bcontra entrega\b.{0,25}\b(?:significa|consiste|es)\b/.test(value) ||
    (/\b(?:mis|sus|tus)\s+(?:clientes|compradores)\b|\b(?:clientes? finales?|cliente final|comprador(?:es)?|consumidor(?:es)?|quien compra|cliente del negocio)\b/.test(
      value,
    ) &&
      /\b(?:paga\w*|abona\w*|cobr\w*|anticipo|cuotas?|adelantado)\b/.test(
        value,
      ))
  );
}

export function hasUnauthorizedPaymentTerms(normalized: string): boolean {
  return (
    /\b(?:cuotas?|anticipo|abono|financiacion|50\s*\/\s*50|(?:paga\w*|abona\w*|pago)\s+(?:por adelantado|al\s+(?:recibir|finalizar|terminar)|despues|cuando)|contra entrega|pagarnos|abonarnos|pagos?\s+(?:a|en)\s+plazos?)\b/.test(
      normalized,
    ) && !describesBuyerPayment(normalized)
  );
}

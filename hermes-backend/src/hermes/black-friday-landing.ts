export const BLACK_FRIDAY_LANDING_POLICY_VERSION = 'black-friday-landing-80-v1';

export function rejectsPromotion(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /\b(?:no me interesa|no quiero|rechazo|descarto)\b.{0,35}\b(?:black friday|promocion|oferta)\b/u.test(
    normalized,
  );
}

export function mentionsPersonal80Budget(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  return (
    /\b(?:presupuesto|tengo|dispongo|cuento con)\b.{0,35}\b80\b/.test(
      normalized,
    ) ||
    /\b(?:gastar|invertir)\b.{0,35}\b80\b/.test(normalized) ||
    /\b80\b.{0,35}\bpresupuesto\b/.test(normalized)
  );
}

export function requestsAnotherService(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const service =
    '(?:tienda online|ecommerce|sitio web|pagina web(?: corporativa)?|web corporativa|software a medida|aplicacion movil|landing(?: page)? normal)';
  return (
    new RegExp(
      `\\b(?:quiero|necesito|busco|cotizar|contratar|crear|hacer|me gustaria|pueden hacer|cuanto cuesta|precio de)\\s+(?:(?:una?|el|la|me|que|desarrollar)\\s+){0,3}${service}\\b`,
    ).test(normalized) ||
    new RegExp(
      `\\b(?:quiero|necesito|busco|me gustaria)\\s+informacion\\s+(?:sobre|de)\\s+(?:(?:una?|el|la)\\s+)?${service}\\b`,
    ).test(normalized) ||
    new RegExp(`\\bque incluye\\s+(?:(?:una?|el|la)\\s+)?${service}\\b`).test(
      normalized,
    )
  );
}

export function recognizesBlackFridayLanding(
  message: string,
  recentCustomerMessages: string[] = [],
): boolean {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const current = normalize(message);
  const explicit = (value: string) => {
    const text = normalize(value);
    if (rejectsPromotion(value)) return false;
    if (mentionsPersonal80Budget(value)) return false;
    if (/\bblack friday\b/.test(text)) return true;
    return (
      /\b(?:landing|pagina|web)\b.{0,45}\bochenta\b(?:\s+dolares)?\b/.test(
        text,
      ) ||
      /\b(?:quiero|quisiera|me interesa|busco)\b.{0,30}\b(?:mas )?(?:informacion|detalles|saber mas)\b.{0,25}\b80\b/.test(
        text,
      ) ||
      /\b(?:landing|pagina|web|promocion|promo|oferta)\b.{0,45}\b80\b(?!\s+paginas?\b)/.test(
        text,
      ) ||
      /\b80\b(?:\s+(?:dolares|usd))?.{0,45}\b(?:landing|pagina|web)\b/.test(
        text,
      ) ||
      /\b(?:que me dan|que incluye|que viene)\b.{0,25}\b80\b(?!\s+paginas?\b)/.test(
        text,
      )
    );
  };
  if (rejectsPromotion(message) || requestsAnotherService(message))
    return false;
  if (explicit(message)) return true;
  if (!current) return false;
  for (const previous of [...recentCustomerMessages].reverse()) {
    const previousText = normalize(previous);
    if (rejectsPromotion(previous)) return false;
    if (requestsAnotherService(previousText) && !explicit(previous))
      return false;
    if (explicit(previous)) return true;
  }
  return false;
}

export function isGeneralBlackFridayInquiry(
  message: string,
  recentCustomerMessages: string[] = [],
  verifiedCampaign = false,
): boolean {
  const explicitCurrent = recognizesBlackFridayLanding(message);
  if (
    !explicitCurrent &&
    !verifiedCampaign &&
    !recognizesBlackFridayLanding(message, recentCustomerMessages)
  )
    return false;
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (
    !explicitCurrent &&
    !/\b(?:promocion|oferta|informacion|detalles|beneficios|caracteristicas|prestaciones|saber mas)\b/u.test(
      normalized,
    )
  )
    return false;
  if (
    /\b(?:cuanto|precio|cuesta|costo|vale)\b/u.test(normalized) &&
    !/\b(?:informacion|detalles|beneficios|caracteristicas|prestaciones|completa)\b/u.test(
      normalized,
    )
  )
    return false;
  return !/\b(?:incluye|incluido|que me dan|que viene|dominio|hosting|correos?|seo|soporte|whatsapp|formulario|que es|para que|captar|captacion|leads?|tienda online)\b/.test(
    normalized,
  );
}

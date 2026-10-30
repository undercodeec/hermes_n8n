export const BLACK_FRIDAY_LANDING_POLICY_VERSION = 'black-friday-landing-80-v1';

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
  const switchesService = (value: string) =>
    /\b(?:quiero|necesito|busco|cotizar|contratar|crear|hacer|me gustaria|pueden hacer)\s+(?:(?:una?|el|la|me|que|desarrollar)\s+){0,3}(?:tienda online|ecommerce|sitio web|software a medida|aplicacion movil|landing(?: page)? normal)\b/.test(
      value,
    );
  const explicit = (value: string) => {
    const text = normalize(value);
    if (/\bblack friday\b/.test(text)) return true;
    if (/\b(?:presupuesto|tengo|dispongo|cuento con)\b.{0,35}\b80\b/.test(text))
      return false;
    return (
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
  if (switchesService(current)) return false;
  if (explicit(message)) return true;
  if (!current) return false;
  for (const previous of [...recentCustomerMessages].reverse()) {
    const previousText = normalize(previous);
    if (switchesService(previousText) && !explicit(previous)) return false;
    if (explicit(previous)) return true;
  }
  return false;
}

export function isGeneralBlackFridayInquiry(message: string): boolean {
  if (!recognizesBlackFridayLanding(message)) return false;
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return !/\b(?:incluye|incluido|que me dan|que viene|dominio|hosting|correos?|seo|soporte|whatsapp|formulario|que es|para que|captar|captacion|leads?|tienda online)\b/.test(
    normalized,
  );
}

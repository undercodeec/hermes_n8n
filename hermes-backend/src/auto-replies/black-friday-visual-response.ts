import type { AuthorizedOffer } from '../hermes/commercial-authority.service';
import type { CommercialProfile } from '../hermes/dto/hermes-request.dto';

const icons = ['🎯', '🖥️', '📱', '💬', '📝', '⭐', '🌍', '📧', '🔍', '🛠️'];
const canonicalScope: { pattern: RegExp; label: string }[] = [
  {
    pattern: /^captacion de (?:leads|clientes potenciales)$/u,
    label: 'Captación de clientes potenciales',
  },
  {
    pattern: /^landing page de una sola seccion$/u,
    label: 'Landing Page de una sola sección',
  },
  {
    pattern: /^diseno responsive (?:para|optimizado para) celulares$/u,
    label: 'Diseño responsive, optimizado para celulares',
  },
  {
    pattern: /^boton flotante de whatsapp y llamada directa$/u,
    label: 'Botón flotante de WhatsApp y llamada directa',
  },
  {
    pattern: /^formulario de contacto o captura de prospectos$/u,
    label: 'Formulario de contacto o captura de prospectos',
  },
  {
    pattern: /^(?:apartado|seccion) de beneficios del servicio o producto$/u,
    label: 'Sección de beneficios del servicio o producto',
  },
  {
    pattern: /^dominio \.com y hosting basico por 1 ano$/u,
    label: 'Dominio .com y hosting básico por 1 año',
  },
  { pattern: /^5 correos corporativos$/u, label: '5 correos corporativos' },
  { pattern: /^seo tecnico base$/u, label: 'SEO técnico base' },
];

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

export function asksForBlackFridayDetails(message: string): boolean {
  const text = normalize(message);
  if (
    /\b(?:hosting|soporte|dominio|correos?|seo|formulario|whatsapp)\b/u.test(
      text,
    ) &&
    !/\b(?:todas?|complet[oa]s?|prestaciones|caracteristicas)\b/u.test(text)
  )
    return false;
  return /\b(?:que incluye|que trae|que viene|cuales son (?:las )?(?:prestaciones|caracteristicas)|todas? las prestaciones|detalle completo)\b/u.test(
    text,
  );
}

export function blackFridayScopeItems(
  offer: AuthorizedOffer,
): string[] | undefined {
  const items = offer.scope
    .split(';')
    .map((item) => item.trim().replace(/[.;\s]+$/u, ''));
  return items.length === 10 && items.every(Boolean) ? items : undefined;
}

function supportLabel(item: string): string {
  const text = normalize(item);
  if (
    /^(?:12 meses|1 ano|un ano) de soporte(?: tecnico)? posterior a la entrega$/u.test(
      text,
    )
  )
    return '*1 año de soporte técnico posterior a la entrega*';
  if (
    /^(?:1 mes|un mes) de soporte(?: tecnico)? posterior a la entrega$/u.test(
      text,
    )
  )
    return '*1 mes de soporte posterior a la entrega*';
  return `*${item}*`;
}

function followupQuestion(
  profile: CommercialProfile | undefined,
  recentMessages: { role: string; content: string }[],
): string | undefined {
  const business = profile?.sector || profile?.company || profile?.service;
  if (
    business &&
    !/^(?:landing|landing.page|sitio web|pagina web)$/iu.test(business.trim())
  )
    return recentMessages.some(
      (message) =>
        message.role === 'assistant' &&
        /le gustar[ií]a destacar sus servicios de/iu.test(message.content),
    )
      ? undefined
      : `¿Le gustaría destacar sus servicios de ${business.trim()} o facilitar las consultas por WhatsApp?`;
  const alreadyAsked = recentMessages.some(
    (message) =>
      message.role === 'assistant' &&
      /¿(?:a qu[eé] se dedica|cu[aá]l es su negocio|qu[eé] hace su negocio)/iu.test(
        message.content,
      ),
  );
  return alreadyAsked ? undefined : '¿A qué se dedica su negocio?';
}

export function blackFridayDetailParts(input: {
  offer: AuthorizedOffer;
  profile?: CommercialProfile;
  recentMessages: { role: string; content: string }[];
  priceAnswer?: string;
  maxParts: number;
}): string[] | undefined {
  const items = blackFridayScopeItems(input.offer);
  if (!items) return undefined;
  const list = items
    .map((item, index) => {
      const label =
        index === 9
          ? supportLabel(item)
          : canonicalScope[index].pattern.test(normalize(item))
            ? canonicalScope[index].label
            : item;
      return `${icons[index]} ${label}`;
    })
    .join('\n');
  const intro =
    input.priceAnswer?.trim() ||
    'Claro. Estas son las prestaciones de la promoción Black Friday:';
  const question = followupQuestion(input.profile, input.recentMessages);
  const parts =
    input.maxParts >= 3 && question
      ? [intro, list, question]
      : input.maxParts >= 2
        ? [intro, question ? `${list}\n\n${question}` : list]
        : [`${intro}\n\n${list}${question ? `\n\n${question}` : ''}`];
  return parts.every((part) => part.length <= 1000) ? parts : undefined;
}

export function blackFridaySpecificAnswer(
  message: string,
  offer: AuthorizedOffer,
): string | undefined {
  const text = normalize(message);
  const items = blackFridayScopeItems(offer);
  if (!items || asksForBlackFridayDetails(message)) return undefined;
  if (
    /\bsoporte\b/u.test(text) &&
    /\b(?:cuanto|incluye|duracion|meses|ano)\b/u.test(text)
  )
    return `La promoción incluye ${items[9].toLocaleLowerCase('es')}.`;
  if (
    /\bhosting\b/u.test(text) &&
    /\b(?:incluye|cuanto|tiene|trae)\b/u.test(text)
  )
    return `Sí. La promoción incluye ${items[6].toLocaleLowerCase('es')}.`;
  return undefined;
}

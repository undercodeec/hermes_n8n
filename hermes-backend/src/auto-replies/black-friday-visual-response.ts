import type { AuthorizedOffer } from '../hermes/commercial-authority.service';
import type { CommercialProfile } from '../hermes/dto/hermes-request.dto';
import type { CustomerSalutation } from '../hermes/customer-salutation';

// Initial Ecuador bands, deliberately independent of the server's time zone.
export const BLACK_FRIDAY_GREETING_TIME_ZONE = 'America/Guayaquil';

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
  return /\b(?:que incluye|que trae|que viene|cuales son (?:las |los )?(?:prestaciones|caracteristicas|beneficios)|(?:me )?comparte (?:las |los )?(?:prestaciones|caracteristicas|beneficios)|todas? las prestaciones|detalle completo)\b/u.test(
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
    /^(?:12 meses|1 ano|un ano) de soporte(?: tecnico)? posterior(?:es)? a la entrega$/u.test(
      text,
    )
  )
    return '*1 año de soporte técnico posterior a la entrega*';
  if (
    /^(?:1 mes|un mes) de soporte(?: tecnico)? posterior(?:es)? a la entrega$/u.test(
      text,
    )
  )
    return '*1 mes de soporte posterior a la entrega*';
  return `*${item}*`;
}

function followupQuestion(
  profile: CommercialProfile | undefined,
  recentMessages: { role: string; content: string }[],
  customerMessage = '',
): string | undefined {
  const askedProject = recentMessages.some(
    (message) =>
      message.role === 'assistant' &&
      /¿(?:a que se dedica|cual es su negocio|que hace su negocio|que tipo de proyecto)/iu.test(
        normalize(message.content),
      ),
  );
  const askedSpecific = recentMessages.some(
    (message) =>
      message.role === 'assistant' &&
      /¿(?:le gustaria destacar sus servicios de|que objetivo desea priorizar)/iu.test(
        normalize(message.content),
      ),
  );
  const business = profile?.sector || profile?.company || profile?.service;
  if (
    business &&
    !/^(?:landing|landing.page|sitio web|pagina web)$/iu.test(business.trim())
  )
    return askedSpecific
      ? undefined
      : `¿Le gustaría destacar sus servicios de ${business.trim()} o facilitar las consultas por WhatsApp?`;
  if (
    /\b(?:para mi|para nuestro|mi negocio es|mi empresa es|me dedico a)\s+[a-z]{3,}/u.test(
      normalize(customerMessage),
    )
  )
    return askedSpecific
      ? undefined
      : '¿Qué objetivo desea priorizar con la landing page?';
  return askedProject
    ? undefined
    : 'Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?';
}

function localGreeting(
  now: Date,
  timeZone: string,
  salutation?: CustomerSalutation,
  firstReply = true,
  customerMessage = '',
): string {
  if (
    !firstReply &&
    !/^(?:hola|buenos dias|buenas tardes|buenas noches|buen dia|buenas)\b/u.test(
      normalize(customerMessage.trim()),
    )
  )
    return '';
  let hour: number;
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .find((item) => item.type === 'hour');
    hour = Number(part?.value);
  } catch {
    return localGreeting(
      now,
      BLACK_FRIDAY_GREETING_TIME_ZONE,
      salutation,
      firstReply,
      customerMessage,
    );
  }
  const opening =
    hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const address =
    firstReply && salutation?.treatment
      ? `, ${salutation.treatment}${salutation.firstName ? ` ${salutation.firstName}` : ''}`
      : firstReply && salutation?.firstName
        ? `, ${salutation.firstName}`
        : '';
  return `${opening}${address}.`;
}

export function blackFridayDetailParts(input: {
  offer: AuthorizedOffer;
  profile?: CommercialProfile;
  recentMessages: { role: string; content: string }[];
  maxParts: number;
  now?: Date;
  timeZone?: string;
  salutation?: CustomerSalutation;
  firstReply?: boolean;
  customerMessage?: string;
}): string[] | undefined {
  const items = blackFridayScopeItems(input.offer);
  if (!items || !input.offer.amount || input.maxParts < 1) return undefined;
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
  const price = `${input.offer.currency === 'EUR' ? 'EUR €' : 'USD $'}${input.offer.currency === 'EUR' ? input.offer.amount : input.offer.amount.replace(/\.00$/u, '')}`;
  const greeting = localGreeting(
    input.now ?? new Date(),
    input.timeZone ?? BLACK_FRIDAY_GREETING_TIME_ZONE,
    input.salutation,
    input.firstReply,
    input.customerMessage,
  );
  const opening = greeting ? `${greeting} ` : '';
  const description = greeting ? 'la información' : 'los detalles';
  const intro = `${opening}Con gusto le comparto ${description} de nuestra promoción *Black Friday por ${price}*.`;
  const question = followupQuestion(
    input.profile,
    input.recentMessages,
    input.customerMessage,
  );
  const information = `${intro}\n\n${list}`;
  const parts =
    input.maxParts >= 2 && question ? [information, question] : [information];
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

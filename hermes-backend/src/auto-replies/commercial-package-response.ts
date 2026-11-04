import { CommercialTaxMode } from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from '../hermes/commercial-authority.service';
import { normalizeCommonSpanishTypos } from '../hermes/spanish-text-normalizer';

function normalize(value: string): string {
  return normalizeCommonSpanishTypos(
    value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, ''),
  );
}

const categoryNames: Record<string, RegExp> = {
  WEBSITE:
    /\b(?:sitio web|sitios web|pagina web|paginas web|pagina de internet|web corporativa)\b/u,
  ONLINE_STORE: /\b(?:tienda online|tiendas online|ecommerce)\b/u,
  LANDING_PAGE: /\b(?:landing|pagina de aterrizaje)\b/u,
};

function supportClause(value: string): boolean {
  return /\bsoporte\b/u.test(normalize(value));
}

function scopeItems(
  offer: AuthorizedOffer,
  offers: AuthorizedOffer[],
  visited = new Set<string>(),
): string[] {
  if (visited.has(offer.id)) return [];
  visited.add(offer.id);
  const own = offer.scope
    .split(/[;,]/u)
    .map((item) => item.trim().replace(/[.\s]+$/u, ''))
    .filter(Boolean);
  const parentName = normalize(offer.scope).match(
    /\b(?:incluye(?: todo lo de| el| la)?|todo lo (?:incluido en|de))\s+(plan de lanzamiento|plan de crecimiento|tienda de lanzamiento|tienda de crecimiento|landing basica)\b/u,
  )?.[1];
  const parent = parentName
    ? offers.find((item) => normalize(item.name) === parentName)
    : undefined;
  const inherited = parent ? scopeItems(parent, offers, visited) : [];
  const ownSupport = own.some(supportClause);
  return [
    ...inherited.filter((item) => !ownSupport || !supportClause(item)),
    ...own.filter(
      (item) =>
        !/^(?:incluye|todo lo (?:incluido|anterior|de))\b/u.test(
          normalize(item),
        ),
    ),
  ];
}

function priceLine(offer: AuthorizedOffer): string {
  if (offer.priceType === 'QUOTE_REQUIRED' || !offer.amount)
    return '*Precio sujeto a valoración*';
  const amount = Number(offer.amount).toLocaleString('es-EC', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const currency = offer.currency === 'USD' ? 'USD $' : 'EUR €';
  const tax =
    offer.taxMode === CommercialTaxMode.INCLUDED && offer.taxLabel
      ? ` — ${offer.taxLabel} incluido`
      : offer.taxMode === CommercialTaxMode.EXCLUDED && offer.taxLabel
        ? ` — más ${offer.taxLabel}`
        : '';
  return `*${offer.priceType === 'FROM' ? 'Desde ' : ''}${currency}${amount}${tax}*`;
}

export function packageCard(
  offer: AuthorizedOffer,
  offers: AuthorizedOffer[],
  full: boolean,
): string {
  const icon =
    offer.serviceCode === 'ONLINE_STORE'
      ? '🛒'
      : offer.serviceCode === 'LANDING_PAGE'
        ? '📄'
        : '🌐';
  const items = scopeItems(offer, offers);
  const details = full
    ? items
    : [...items.slice(0, 2), ...items.filter(supportClause).slice(-1)].filter(
        (item, index, list) => list.indexOf(item) === index,
      );
  const lines = details.map(
    (item) =>
      `${supportClause(item) ? '🧑‍💻' : '✅'} ${supportClause(item) ? `*${item}*` : item}.`,
  );
  return [
    `${icon} *${offer.name.toLocaleUpperCase('es')}*`,
    priceLine(offer),
    ...lines,
  ].join('\n');
}

/** Only CRM offers can reach this formatter; it never supplies a tariff or feature. */
export function commercialPackageParts(input: {
  message: string;
  snapshot: CommercialSnapshot;
  priceRequested: boolean;
  maxParts: number;
}): string[] | undefined {
  const query = normalize(input.message);
  const offers = input.snapshot.offers.filter((offer) => !offer.promotion);
  const mentionedService = Object.entries(categoryNames).find(([, pattern]) =>
    pattern.test(query),
  )?.[0];
  const namedOffers = offers.filter((offer) =>
    query.includes(normalize(offer.name)),
  );
  if (
    namedOffers.length === 1 &&
    /\b(?:plan de|tienda de) lanzamiento y crecimiento\b/u.test(query)
  ) {
    const growth = offers.find(
      (offer) =>
        offer.serviceCode === namedOffers[0].serviceCode &&
        /\bcrecimiento\b/u.test(normalize(offer.name)),
    );
    if (growth) namedOffers.push(growth);
  }
  const comparisonRequested =
    /\b(?:que|cuales|cuantos|muestr(?:e|eme|ame)|mostrar|ver|ofrecen|tienen|comparar|comparacion)\b.{0,65}\b(?:planes?|paquetes?|opciones?)\b/u.test(
      query,
    ) ||
    /\b(?:planes?|paquetes?|opciones?)\b.{0,65}\b(?:ofrecen|tienen|hay|disponibles)\b/u.test(
      query,
    ) ||
    (/\b(?:sus|todos|todas|tres|3)\s+(?:planes?|paquetes?|opciones?)\b/u.test(
      query,
    ) &&
      /\b(?:muestr(?:e|eme|ame)|mostrar|ver|comparar|cuales|que)\b/u.test(
        query,
      ));
  const serviceCode =
    mentionedService ??
    (comparisonRequested ? input.snapshot.relevantServiceCodes[0] : undefined);
  const category = serviceCode
    ? offers.filter((offer) => offer.serviceCode === serviceCode)
    : [];
  const allPlans =
    Boolean(serviceCode) &&
    comparisonRequested &&
    !(namedOffers.length === 2 && /\bcomparar\b/u.test(query));
  const named = namedOffers[0];
  const complete =
    /\b(?:que incluye|todo lo que incluye|prestaciones|caracteristicas|detalle completo)\b/u.test(
      query,
    );
  let selected: AuthorizedOffer[] = [];
  if (namedOffers.length === 2 && /\bcomparar\b/u.test(query))
    selected = namedOffers;
  else if (allPlans && category.length === 3) selected = category;
  else if (named && complete) selected = [named];
  else if (input.priceRequested && input.snapshot.additionalScope?.length) {
    const applicable = offers
      .filter(
        (offer) => offer.serviceCode === input.snapshot.relevantServiceCodes[0],
      )
      .sort(
        (left, right) =>
          Number(left.amount ?? Infinity) - Number(right.amount ?? Infinity),
      );
    if (applicable.length >= 2) {
      const recommended = applicable.findIndex(
        (offer) => offer.id === input.snapshot.recommendedOfferId,
      );
      const start = Math.max(
        0,
        Math.min(recommended - 1, applicable.length - 2),
      );
      selected = applicable.slice(start, start + 2);
    }
  }
  if (!selected.length) return undefined;
  selected.sort((left, right) => Number(left.amount) - Number(right.amount));
  const cards = selected.map((offer) => packageCard(offer, offers, complete));
  if (input.snapshot.additionalScope?.length) {
    cards[cards.length - 1] +=
      `\n\nEstos importes son referencias de los planes base. ${input.snapshot.additionalScope.join(' y ')} requiere valoración adicional. ¿Desea que un asesor comercial prepare una cotización personalizada?`;
  }
  if (cards.some((card) => card.length > 1000)) return undefined;
  if (cards.length <= input.maxParts) return cards;
  const joined = cards.join('\n\n');
  return joined.length <= 1000 ? [joined] : undefined;
}

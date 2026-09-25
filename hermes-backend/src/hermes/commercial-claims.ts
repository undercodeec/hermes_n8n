import { CommercialPriceType, CommercialTaxMode } from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from './commercial-authority.service';
import { requestedSolutionKinds } from './commercial-catalog';

const MONEY =
  /(?:\b(?:USD|EUR|dólares?|euros?)\s*[$€]?\s*\d[\d.,]*|[$€]\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:USD|EUR|dólares?|euros?)(?!\w)|\b\d[\d.,]*\s*€)/giu;

function normalized(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function moneyAmount(value: string): string | undefined {
  const digits = value.match(/\d[\d.,]*/u)?.[0];
  if (!digits) return undefined;
  let decimal = digits;
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSeparator = lastDot > lastComma ? '.' : ',';
    decimal = digits
      .replaceAll(decimalSeparator === '.' ? ',' : '.', '')
      .replace(decimalSeparator, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const index = Math.max(lastDot, lastComma);
    decimal =
      digits.length - index - 1 === 2
        ? digits.replace(',', '.')
        : digits.replace(/[.,]/g, '');
  }
  const valueNumber = Number(decimal);
  return Number.isFinite(valueNumber) ? valueNumber.toFixed(2) : undefined;
}

function moneyCurrency(value: string): 'USD' | 'EUR' | undefined {
  if (/(?:€|\bEUR\b|\beuros?\b)/iu.test(value)) return 'EUR';
  if (/(?:\$|\bUSD\b|\bdólares?\b)/iu.test(value)) return 'USD';
  return undefined;
}

function referencedOffer(
  sentence: string,
  priceIndex: number,
  offers: AuthorizedOffer[],
): AuthorizedOffer | undefined {
  const preceding = normalized(sentence.slice(0, priceIndex));
  const named = offers
    .map((offer) => ({
      offer,
      index: preceding.lastIndexOf(normalized(offer.name)),
    }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => right.index - left.index)[0];
  if (named) return named.offer;
  if (offers.length !== 1) return undefined;
  if (
    /\btienda\b/.test(normalized(sentence)) &&
    offers[0].serviceCode !== 'ONLINE_STORE'
  )
    return undefined;
  const mentionedServices = requestedSolutionKinds(sentence, false);
  return mentionedServices.length === 0 ||
    mentionedServices.includes(
      offers[0].serviceCode as (typeof mentionedServices)[number],
    )
    ? offers[0]
    : undefined;
}

export function reviewCommercialClaims(
  response: string,
  snapshot: CommercialSnapshot,
): { response: string; reasons: string[] } {
  const reasons: string[] = [];
  const sentences = response.split(/(?<=[.!?])\s+/u).filter(Boolean);
  const kept = sentences.filter((sentence) => {
    const tokens = [...sentence.matchAll(MONEY)];
    for (const token of tokens) {
      const renewalContext = sentence.slice(
        Math.max(0, token.index - 120),
        token.index,
      );
      const renewal =
        /\b(?:renovaci[oó]n|renovar|segundo a[nñ]o)\b/iu.test(renewalContext) &&
        /\b(?:hosting|dominio)\b/iu.test(renewalContext);
      const renewalOffer = snapshot.offers.find(
        (offer) => offer.id === snapshot.recommendedOfferId,
      );
      const offer = referencedOffer(sentence, token.index, snapshot.offers);
      const amount = moneyAmount(token[0]);
      const currency = moneyCurrency(token[0]);
      if (
        renewal &&
        renewalOffer?.renewalUsdPerYear &&
        amount === renewalOffer.renewalUsdPerYear.toFixed(2) &&
        currency === 'USD'
      ) {
        continue;
      }
      const preceding = normalized(sentence.slice(0, token.index));
      const offerIndex = offer
        ? preceding.lastIndexOf(normalized(offer.name))
        : -1;
      const before = preceding.slice(
        Math.max(0, offerIndex >= 0 ? offerIndex - 20 : token.index - 80),
      );
      const saysFrom = /\bdesde\b/.test(before);
      if (
        !offer ||
        !amount ||
        !currency ||
        offer.priceType === CommercialPriceType.QUOTE_REQUIRED ||
        offer.amount !== amount ||
        offer.currency !== currency ||
        (offer.priceType === CommercialPriceType.FROM && !saysFrom) ||
        (offer.priceType === CommercialPriceType.FIXED && saysFrom)
      ) {
        reasons.push('PRICE_NOT_AUTHORIZED');
        return false;
      }
    }
    const plain = normalized(sentence);
    const namedOffers = snapshot.offers.filter((offer) =>
      plain.includes(normalized(offer.name)),
    );
    const taxOffers = namedOffers.length ? namedOffers : snapshot.offers;
    const taxPercent = plain.match(/\biva\s+(?:del?\s+)?(\d+(?:[.,]\d+)?)\s*%/);
    if (
      taxPercent &&
      (!taxOffers.length ||
        taxOffers.some(
          (offer) =>
            offer.taxRatePercent === undefined ||
            Number(offer.taxRatePercent) !==
              Number(taxPercent[1].replace(',', '.')),
        ))
    ) {
      reasons.push('TAX_CLAIM_NOT_AUTHORIZED');
      return false;
    }
    if (
      /\biva\s+incluid[oa]\b/.test(plain) &&
      (!taxOffers.length ||
        taxOffers.some((offer) => offer.taxMode !== CommercialTaxMode.INCLUDED))
    ) {
      reasons.push('TAX_CLAIM_NOT_AUTHORIZED');
      return false;
    }
    if (
      /\b(?:sin|mas)\s+iva\b/.test(plain) &&
      (!taxOffers.length ||
        taxOffers.some((offer) => offer.taxMode !== CommercialTaxMode.EXCLUDED))
    ) {
      reasons.push('TAX_CLAIM_NOT_AUTHORIZED');
      return false;
    }
    if (
      /\biva\s+no\s+incluid[oa]\b/.test(plain) &&
      (!taxOffers.length ||
        taxOffers.some((offer) => offer.taxMode !== CommercialTaxMode.EXCLUDED))
    ) {
      reasons.push('TAX_CLAIM_NOT_AUTHORIZED');
      return false;
    }
    if (
      /\b(?:promocion|oferta especial|descuento)\b/.test(plain) &&
      (!taxOffers.length || taxOffers.some((offer) => !offer.promotion))
    ) {
      reasons.push('PROMOTION_NOT_AUTHORIZED');
      return false;
    }
    return true;
  });
  return {
    response:
      kept.join(' ').trim() ||
      (snapshot.needsMarketClarification
        ? '¿El proyecto sería para Ecuador o España?'
        : 'Ese importe o condición requiere confirmación del equipo.'),
    reasons,
  };
}

export function answerExplicitPriceIfMissing(
  response: string,
  snapshot: CommercialSnapshot,
  explicitPriceQuestion: boolean,
): string {
  if (!explicitPriceQuestion) return response;
  if (snapshot.needsMarketClarification)
    return '¿El proyecto sería para Ecuador o España?';
  if ([...response.matchAll(MONEY)].length > 0) return response;
  const offer =
    snapshot.offers.find((item) => item.id === snapshot.recommendedOfferId) ??
    (snapshot.offers.length === 1 ? snapshot.offers[0] : undefined);
  if (!offer) return response;
  if (offer.priceType === CommercialPriceType.QUOTE_REQUIRED) {
    return /\b(?:valoracion|cotizacion|presupuesto|evaluacion)\b/.test(
      normalized(response),
    )
      ? response
      : `${offer.name}: requiere valoración según el alcance.${response ? ` ${response}` : ''}`;
  }
  const amount =
    offer.currency === 'EUR' ? `€${offer.amount}` : `USD $${offer.amount}`;
  const intro = offer.priceType === CommercialPriceType.FROM ? 'desde ' : '';
  const tax =
    offer.taxMode === CommercialTaxMode.INCLUDED
      ? `, ${offer.taxLabel ?? 'impuestos'} incluidos`
      : offer.taxMode === CommercialTaxMode.EXCLUDED
        ? `, más ${offer.taxLabel ?? 'impuestos'}`
        : '';
  const genericDeferral =
    /\b(?:valor|precio|importe)\b.{0,90}\b(?:depende|confirmar|confirma|valoraci[oó]n)\b/iu.test(
      response,
    );
  const additional = snapshot.additionalScope?.length
    ? ` ${snapshot.additionalScope.join(' y ')} requiere valoración aparte; ese adicional no tiene un precio confirmado.`
    : '';
  return `${offer.name}: ${intro}${amount}${tax}.${additional}${response && !genericDeferral ? ` ${response}` : ''}`.trim();
}

import { CommercialPriceType, CommercialTaxMode } from '@prisma/client';
import type {
  AuthorizedOffer,
  CommercialSnapshot,
} from './commercial-authority.service';
import { requestedSolutionKinds } from './commercial-catalog';
import { monetaryValuesIn } from './monetary-values';
import {
  commercialClauses,
  joinReviewedClauses,
  hasUnauthorizedPaymentTerms,
} from './commercial-language';

function normalized(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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
  const sentences = commercialClauses(response);
  const kept = sentences.filter((sentence, sentenceIndex) => {
    const tokens = monetaryValuesIn(sentence);
    if (hasUnauthorizedPaymentTerms(normalized(sentence))) {
      reasons.push('UNAUTHORIZED_PAYMENT_TERMS');
      return false;
    }
    for (let index = 0; index + 1 < tokens.length; index++) {
      const left = tokens[index];
      const right = tokens[index + 1];
      const beforePrices = normalized(
        sentence.slice(
          index ? tokens[index - 1].index + tokens[index - 1].raw.length : 0,
          left.index,
        ),
      );
      const betweenPrices = normalized(
        sentence.slice(left.index + left.raw.length, right.index),
      );
      const range =
        (/\bentre\b/.test(beforePrices) && /\by\b/.test(betweenPrices)) ||
        (/\bde\b/.test(beforePrices) && /^\s*a\b/u.test(betweenPrices)) ||
        /^\s*(?:a\s|hasta\b|[-–—])/u.test(betweenPrices);
      if (range) {
        reasons.push('PRICE_NOT_AUTHORIZED');
        return false;
      }
    }
    for (const [tokenIndex, token] of tokens.entries()) {
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
      const { amount, currency } = token;
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
        Math.max(
          tokenIndex
            ? tokens[tokenIndex - 1].index + tokens[tokenIndex - 1].raw.length
            : 0,
          offerIndex >= 0 ? offerIndex - 20 : token.index - 80,
        ),
      );
      const saysFrom = /\b(?:desde|a partir de)\b/.test(before);
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
    if (
      snapshot.additionalScope?.length &&
      (tokens.length ||
        sentences
          .slice(Math.max(0, sentenceIndex - 2), sentenceIndex)
          .some((previous) => monetaryValuesIn(previous).length)) &&
      /\b(?:proyecto completo|precio (?:total|completo)|total del proyecto|todo incluid[oa]s?|incluye todo|cubiert[oa] todo el proyecto)\b/.test(
        plain,
      )
    ) {
      reasons.push('INCLUSION_NOT_AUTHORIZED');
      return false;
    }
    // A base amount never authorizes custom scheduling or the scope flagged as additional.
    const customScheduling =
      /\b(?:agendamiento|agendar|reservas? con calendario)\b/.test(plain);
    const extraWords = (snapshot.additionalScope ?? []).flatMap(
      (scope) =>
        normalized(scope).match(
          /\b(?:agendamiento|reservas?|pedidos?|calendario)\b/g,
        ) ?? [],
    );
    const inclusionText = plain
      .replace(
        /\b(?:iva|impuestos?)\s+(?:no\s+)?incluid[oa]s?\b|\b(?:no\s+)?incluye\s+(?:(?:el|los)\s+)?(?:iva|impuestos?)\b/g,
        '',
      )
      .replace(
        /\b(?:no (?:esta |estan |se )?incluid[oa]s?|no incluye|no cubre)\b/g,
        '',
      );
    const claimsInclusion =
      /\b(?:incluye|incluidos?|incluidas?|cubre|contiene|viene con)\b/.test(
        inclusionText,
      );
    if (
      claimsInclusion &&
      (extraWords.some((word) => plain.includes(word)) ||
        (customScheduling &&
          !snapshot.offers.some((offer) =>
            /\b(?:agendamiento|reservas? con calendario)\b/.test(
              normalized(offer.scope),
            ),
          )))
    ) {
      reasons.push('INCLUSION_NOT_AUTHORIZED');
      return false;
    }
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
    const taxSubject = '(?:iva|impuestos?)';
    const excludedTax = new RegExp(
      `\\b(?:no incluye\\s+(?:(?:el|los)\\s+)?${taxSubject}|${taxSubject}\\s+(?:no\\s+incluid[oa]s?|excluid[oa]s?))\\b|(?:\\b(?:sin|mas)\\s+|\\+\\s*)(?:(?:el|los)\\s+)?${taxSubject}\\b`,
      'g',
    );
    const saysExcluded = excludedTax.test(plain);
    const includedTaxText = plain.replace(excludedTax, '');
    const saysIncluded = new RegExp(
      `\\b(?:${taxSubject}\\s+incluid[oa]s?|incluye\\s+(?:(?:el|los)\\s+)?${taxSubject})\\b`,
    ).test(includedTaxText);
    if (
      saysIncluded &&
      (!taxOffers.length ||
        taxOffers.some((offer) => offer.taxMode !== CommercialTaxMode.INCLUDED))
    ) {
      reasons.push('TAX_CLAIM_NOT_AUTHORIZED');
      return false;
    }
    if (
      saysExcluded &&
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
      joinReviewedClauses(response, sentences, kept) ||
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
  if (hasAuthorizedMonetaryValue(response, snapshot)) return response;
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

export function hasAuthorizedMonetaryValue(
  response: string,
  snapshot: CommercialSnapshot,
): boolean {
  return monetaryValuesIn(
    reviewCommercialClaims(response, snapshot).response,
  ).some((value) => value.amount !== undefined);
}

/** Reconcile the actual reply after substitutions and executed operations. */
export function reconcileCommercialIntent(
  intent: string | undefined,
  response: string,
  priceRequested: boolean,
  quoteCreated = false,
): string | undefined {
  if (quoteCreated) return 'cotizacion';
  if (!priceRequested && intent !== 'consulta_precio') return intent;
  if (['error', 'solicitud_humano', 'agendar_cita'].includes(intent ?? ''))
    return intent;
  const addressesPrice =
    monetaryValuesIn(response).length > 0 ||
    /\b(?:precio|importe|valor|cotizacion|presupuesto|ecuador o espana)\b/.test(
      normalized(response),
    );
  return addressesPrice ? 'consulta_precio' : 'info_general';
}

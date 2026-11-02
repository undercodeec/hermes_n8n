import { Injectable } from '@nestjs/common';
import { CommercialMarket } from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CommercialProfile } from './dto/hermes-request.dto';

export type MarketInferenceSource =
  | 'EXPLICIT_PROJECT'
  | 'VERIFIED_META_AD'
  | 'EXPLICIT_CUSTOMER_MARKET'
  | 'EXPLICIT_CUSTOMER_CURRENCY'
  | 'CRM_CONFIRMED'
  | 'PHONE_COUNTRY_CODE'
  | 'HISTORY'
  | 'UNKNOWN';

export type MarketResolution = {
  market?: CommercialMarket;
  source: MarketInferenceSource;
  phoneCountry?: CommercialMarket;
  projectCountry?: CommercialMarket;
  requestedCurrency?: 'EUR' | 'USD' | 'AMBIGUOUS';
};

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

export function phoneCountryFromWaId(
  waId?: string,
): CommercialMarket | undefined {
  if (!waId) return undefined;
  const compact = waId.trim().replace(/[\s()-]/gu, '');
  if (!/^\+?[1-9]\d{7,14}$/u.test(compact)) return undefined;
  const phone = parsePhoneNumberFromString(
    compact.startsWith('+') ? compact : `+${compact}`,
  );
  if (!phone?.isValid()) return undefined;
  return phone.country === 'ES'
    ? CommercialMarket.ES
    : phone.country === 'EC'
      ? CommercialMarket.EC
      : undefined;
}

function mentionedMarket(text: string): CommercialMarket | undefined {
  const value = normalize(text);
  const ec =
    /\becuador\b/u.test(value) &&
    !/\bno\s+(?:en|para|soy de)\s+ecuador\b/u.test(value);
  const es =
    /\bespana\b/u.test(value) &&
    !/\bno\s+(?:en|para|soy de)\s+espana\b/u.test(value);
  return ec === es ? undefined : ec ? CommercialMarket.EC : CommercialMarket.ES;
}

export function explicitProjectMarket(
  text: string,
): CommercialMarket | undefined {
  const normalized = normalize(text);
  if (/\b(?:ecuador|espana)\s+(?:o|y)\s+(?:ecuador|espana)\b/u.test(normalized))
    return undefined;
  const match = normalized.match(
    /\b(?:proyecto|sitio web|pagina web|web|tienda online|servicio|landing|pagina de aterrizaje)\b.{0,40}\b(?:para|destinad[oa] a|en)\s+(ecuador|espana)\b/u,
  )?.[1];
  return match === 'ecuador'
    ? CommercialMarket.EC
    : match === 'espana'
      ? CommercialMarket.ES
      : undefined;
}

export function mentionedCurrency(
  text: string,
): 'EUR' | 'USD' | 'AMBIGUOUS' | undefined {
  const eur = /€|\b(?:EUR|euros?)\b/iu.test(text);
  const usd = /\$|\b(?:USD|d[oó]lares?)\b/iu.test(text);
  return eur && usd ? 'AMBIGUOUS' : eur ? 'EUR' : usd ? 'USD' : undefined;
}

@Injectable()
export class CommercialMarketResolver {
  resolve(input: {
    customerMessage: string;
    profile?: CommercialProfile;
    recentCustomerMessages?: string[];
    verifiedAdMarket?: CommercialMarket;
    waId?: string;
  }): MarketResolution {
    const phoneCountry = phoneCountryFromWaId(input.waId);
    const currentProject = explicitProjectMarket(input.customerMessage);
    const priorProject = [...(input.recentCustomerMessages ?? [])]
      .reverse()
      .map(explicitProjectMarket)
      .find(Boolean);
    const requestedCurrency = mentionedCurrency(input.customerMessage);
    const currentCountries = normalize(input.customerMessage);
    const ambiguousCurrentProject =
      /\b(?:ecuador|espana)\s+(?:o|y)\s+(?:ecuador|espana)\b/u.test(
        currentCountries,
      );
    const result = (
      market: CommercialMarket | undefined,
      source: MarketInferenceSource,
    ): MarketResolution => ({
      ...(market ? { market } : {}),
      source,
      ...(phoneCountry ? { phoneCountry } : {}),
      ...(source === 'EXPLICIT_PROJECT' && currentProject
        ? { projectCountry: currentProject }
        : source === 'CRM_CONFIRMED' && priorProject === market
          ? { projectCountry: priorProject }
          : {}),
      ...(requestedCurrency ? { requestedCurrency } : {}),
    });
    if (ambiguousCurrentProject) return result(undefined, 'UNKNOWN');
    if (currentProject) return result(currentProject, 'EXPLICIT_PROJECT');
    if (input.verifiedAdMarket)
      return result(input.verifiedAdMarket, 'VERIFIED_META_AD');
    const currentMarket = mentionedMarket(input.customerMessage);
    if (currentMarket) return result(currentMarket, 'EXPLICIT_CUSTOMER_MARKET');
    const normalized = normalize(input.customerMessage);
    if (/\becuador\b/u.test(normalized) && /\bespana\b/u.test(normalized))
      return result(undefined, 'UNKNOWN');
    if (requestedCurrency === 'EUR')
      return result(CommercialMarket.ES, 'EXPLICIT_CUSTOMER_CURRENCY');
    if (requestedCurrency === 'USD')
      return result(CommercialMarket.EC, 'EXPLICIT_CUSTOMER_CURRENCY');
    if (requestedCurrency === 'AMBIGUOUS') return result(undefined, 'UNKNOWN');
    if (priorProject) return result(priorProject, 'CRM_CONFIRMED');
    if (input.profile?.market === 'EC' || input.profile?.market === 'ES') {
      return result(input.profile.market, 'CRM_CONFIRMED');
    }
    if (phoneCountry) return result(phoneCountry, 'PHONE_COUNTRY_CODE');
    for (const message of [...(input.recentCustomerMessages ?? [])].reverse()) {
      const historical = mentionedMarket(message);
      if (historical) return result(historical, 'HISTORY');
    }
    return result(undefined, 'UNKNOWN');
  }
}

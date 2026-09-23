import { Injectable, Logger } from '@nestjs/common';
import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestedSolutionKinds } from './commercial-catalog';
import type { CommercialProfile } from './dto/hermes-request.dto';

export type AuthorizedOffer = {
  id: string;
  name: string;
  serviceCode: string;
  market: CommercialMarket;
  priceType: CommercialPriceType;
  amount?: string;
  currency: 'USD' | 'EUR';
  taxMode: CommercialTaxMode;
  taxLabel?: string;
  taxRatePercent?: string;
  scope: string;
  restrictions?: string;
  policyVersion: string;
  promotion: boolean;
  validUntil?: string;
};

export type CommercialSnapshot = {
  market?: CommercialMarket;
  marketSource: 'CURRENT' | 'PROFILE' | 'HISTORY' | 'UNKNOWN';
  relevantServiceCodes: string[];
  offers: AuthorizedOffer[];
  needsMarketClarification: boolean;
};

const MARKET_CURRENCY: Record<CommercialMarket, 'USD' | 'EUR'> = {
  EC: 'USD',
  ES: 'EUR',
};

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function mentionedMarket(text: string): CommercialMarket | undefined {
  const normalized = normalize(text);
  const ec =
    /\becuador\b/.test(normalized) &&
    !/\bno\s+(?:en|para|soy de)\s+ecuador\b/.test(normalized);
  const es =
    /\bespana\b/.test(normalized) &&
    !/\bno\s+(?:en|para|soy de)\s+espana\b/.test(normalized);
  return ec === es ? undefined : ec ? CommercialMarket.EC : CommercialMarket.ES;
}

export function resolveCommercialMarket(input: {
  customerMessage: string;
  profile?: CommercialProfile;
  recentCustomerMessages?: string[];
}): { market?: CommercialMarket; source: CommercialSnapshot['marketSource'] } {
  const normalizedCurrent = normalize(input.customerMessage);
  const explicitProjectMarket = normalizedCurrent.match(
    /\b(?:proyecto|sitio web|pagina web|tienda online|servicio)\b.{0,40}\bpara\s+(ecuador|espana)\b/,
  )?.[1];
  if (explicitProjectMarket) {
    return {
      market:
        explicitProjectMarket === 'ecuador'
          ? CommercialMarket.EC
          : CommercialMarket.ES,
      source: 'CURRENT',
    };
  }
  const current = mentionedMarket(input.customerMessage);
  if (current) return { market: current, source: 'CURRENT' };
  if (
    /\becuador\b/.test(normalizedCurrent) &&
    /\bespana\b/.test(normalizedCurrent)
  )
    return { source: 'UNKNOWN' };
  if (input.profile?.market === 'EC' || input.profile?.market === 'ES') {
    return { market: input.profile.market, source: 'PROFILE' };
  }
  for (const message of [...(input.recentCustomerMessages ?? [])].reverse()) {
    const historical = mentionedMarket(message);
    if (historical) return { market: historical, source: 'HISTORY' };
  }
  return { source: 'UNKNOWN' };
}

type ProductWithPrices = Prisma.ProductGetPayload<{
  select: {
    id: true;
    name: true;
    serviceCode: true;
    priceLists: {
      select: {
        id: true;
        name: true;
        price: true;
        currency: true;
        market: true;
        priceType: true;
        taxMode: true;
        taxLabel: true;
        taxRatePercent: true;
        scope: true;
        restrictions: true;
        policyVersion: true;
        isPromotion: true;
        supersedesPriceListId: true;
        validUntil: true;
      };
    };
  };
}>;

@Injectable()
export class CommercialAuthorityService {
  private readonly logger = new Logger(CommercialAuthorityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async snapshot(input: {
    customerMessage: string;
    profile?: CommercialProfile;
    productOfInterest?: string;
    recentCustomerMessages?: string[];
    priceRequested: boolean;
    now?: Date;
  }): Promise<CommercialSnapshot> {
    const resolution = resolveCommercialMarket(input);
    const priorContext = [
      input.productOfInterest,
      input.profile?.service,
      input.profile?.need,
      input.profile?.businessNeeds,
    ]
      .filter(Boolean)
      .join(' ');
    const currentServiceCodes = requestedSolutionKinds(
      input.customerMessage,
      false,
    );
    const recentServiceCodes =
      [...(input.recentCustomerMessages ?? [])]
        .reverse()
        .map((message) => requestedSolutionKinds(message, false))
        .find((codes) => codes.length > 0) ?? [];
    const relevantServiceCodes = currentServiceCodes.length
      ? currentServiceCodes
      : requestedSolutionKinds(priorContext, false).length
        ? requestedSolutionKinds(priorContext, false)
        : recentServiceCodes;
    const result: CommercialSnapshot = {
      market: resolution.market,
      marketSource: resolution.source,
      relevantServiceCodes,
      offers: [],
      needsMarketClarification:
        input.priceRequested &&
        !resolution.market &&
        relevantServiceCodes.length > 0,
    };
    if (!resolution.market || !relevantServiceCodes.length) return result;
    const now = input.now ?? new Date();
    try {
      const products = await this.prisma.product.findMany({
        where: {
          isActive: true,
          serviceCode: { in: relevantServiceCodes },
        },
        select: {
          id: true,
          name: true,
          serviceCode: true,
          priceLists: {
            where: {
              isActive: true,
              market: resolution.market,
              validFrom: { lte: now },
              OR: [{ validUntil: null }, { validUntil: { gte: now } }],
            },
            select: {
              id: true,
              name: true,
              price: true,
              currency: true,
              market: true,
              priceType: true,
              taxMode: true,
              taxLabel: true,
              taxRatePercent: true,
              scope: true,
              restrictions: true,
              policyVersion: true,
              isPromotion: true,
              supersedesPriceListId: true,
              validUntil: true,
            },
          },
        },
        take: 20,
      });
      result.offers = products.flatMap((product) =>
        this.currentOffer(product, resolution.market!),
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `Commercial authority unavailable: ${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
      return result;
    }
  }

  private currentOffer(
    product: ProductWithPrices,
    market: CommercialMarket,
  ): AuthorizedOffer[] {
    if (!product.serviceCode) return [];
    const eligible = product.priceLists.filter((price) =>
      Boolean(
        price.market === market &&
        price.priceType &&
        price.taxMode &&
        price.scope?.trim() &&
        price.policyVersion?.trim() &&
        price.currency === MARKET_CURRENCY[market] &&
        (price.taxMode === CommercialTaxMode.NOT_APPLICABLE ||
          price.taxLabel?.trim()) &&
        (price.priceType === CommercialPriceType.QUOTE_REQUIRED
          ? price.price === null
          : price.price !== null && price.price.gt(0)),
      ),
    );
    const base = eligible.filter((price) => !price.isPromotion);
    const promotion = eligible.filter((price) => price.isPromotion);
    let selected: (typeof eligible)[number] | undefined;
    if (
      promotion.length === 1 &&
      base.length === 1 &&
      promotion[0].supersedesPriceListId === base[0].id
    ) {
      selected = promotion[0];
    } else if (promotion.length === 0 && base.length === 1) {
      selected = base[0];
    }
    if (!selected) return [];
    return [
      {
        id: selected.id,
        name: product.name,
        serviceCode: product.serviceCode,
        market,
        priceType: selected.priceType!,
        ...(selected.price ? { amount: selected.price.toFixed(2) } : {}),
        currency: MARKET_CURRENCY[market],
        taxMode: selected.taxMode!,
        ...(selected.taxLabel ? { taxLabel: selected.taxLabel } : {}),
        ...(selected.taxRatePercent
          ? { taxRatePercent: selected.taxRatePercent.toFixed(2) }
          : {}),
        scope: selected.scope!.trim(),
        ...(selected.restrictions
          ? { restrictions: selected.restrictions }
          : {}),
        policyVersion: selected.policyVersion!.trim(),
        promotion: selected.isPromotion,
        ...(selected.validUntil
          ? { validUntil: selected.validUntil.toISOString() }
          : {}),
      },
    ];
  }
}

export function commercialSnapshotKnowledge(
  snapshot: CommercialSnapshot,
): string[] {
  if (snapshot.needsMarketClarification) {
    return [
      'El precio depende del mercado y aún no se conoce el país aplicable. Si el cliente pregunta el precio, pida una sola aclaración breve: ¿El proyecto sería para Ecuador o España?',
    ];
  }
  if (!snapshot.market) return [];
  if (!snapshot.offers.length) {
    return [
      `No hay tarifas comerciales aprobadas y vigentes para los servicios consultados en ${snapshot.market}. No comunique importes.`,
    ];
  }
  return snapshot.offers.map((offer) =>
    JSON.stringify({
      source: 'CRM_APPROVED_PRICE_LIST',
      ...offer,
    }),
  );
}

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
  /** Undefined when one global policy applies in every market. */
  market?: CommercialMarket;
  marketScope: 'GLOBAL' | 'MARKET';
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
  renewalUsdPerYear?: number;
  estimatedBusinessDays?: number;
};

export type CommercialSnapshot = {
  market?: CommercialMarket;
  marketSource: 'CURRENT' | 'PROFILE' | 'HISTORY' | 'UNKNOWN';
  relevantServiceCodes: string[];
  offers: AuthorizedOffer[];
  needsMarketClarification: boolean;
  recommendedOfferId?: string;
  additionalScope?: string[];
  policies?: string[];
  renewalRequested?: boolean;
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
    metadata: true;
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
    const explicitCurrentService =
      /\b(?:landing|p[aá]gina de aterrizaje|sitio web|p[aá]gina web|tienda online|ecommerce|comercio electr[oó]nico|app m[oó]vil|software a medida)\b/i.test(
        input.customerMessage,
      );
    const recentServiceCodes =
      [...(input.recentCustomerMessages ?? [])]
        .reverse()
        .map((message) => requestedSolutionKinds(message, false))
        .find((codes) => codes.length > 0) ?? [];
    const relevantServiceCodes =
      currentServiceCodes.length && explicitCurrentService
        ? currentServiceCodes
        : requestedSolutionKinds(priorContext, false).length
          ? requestedSolutionKinds(priorContext, false)
          : currentServiceCodes.length
            ? currentServiceCodes
            : recentServiceCodes;
    const currentText = normalize(input.customerMessage);
    const preferredCode = /\b(?:sitio web|pagina web|web corporativa)\b/.test(
      currentText,
    )
      ? 'WEBSITE'
      : /\b(?:tienda online|ecommerce)\b/.test(currentText)
        ? 'ONLINE_STORE'
        : /\b(?:landing|pagina de aterrizaje)\b/.test(currentText)
          ? 'LANDING_PAGE'
          : undefined;
    if (preferredCode && relevantServiceCodes.includes(preferredCode)) {
      relevantServiceCodes.sort(
        (left, right) =>
          Number(right === preferredCode) - Number(left === preferredCode),
      );
    }
    const result: CommercialSnapshot = {
      market: resolution.market,
      marketSource: resolution.source,
      relevantServiceCodes,
      offers: [],
      needsMarketClarification: false,
      renewalRequested:
        /\b(?:renovacion|renovar|hosting|dominio|gastos|costos? anuales?|segundo ano|despues del primer ano|que valores tendria que asumir|cuanto tendria que pagar)\b/.test(
          normalize(input.customerMessage),
        ),
    };
    if (
      /\b(?:plazo|tiempo de entrega|cuanto tarda|cuanto demora|dias laborables|para cuando|fecha de entrega)\b/.test(
        normalize(input.customerMessage),
      )
    ) {
      try {
        const deliveryPolicy = await this.prisma.knowledgeDocument.findUnique({
          where: { id: 'commercial-delivery-policy-v1' },
          select: { content: true, isActive: true },
        });
        if (deliveryPolicy?.isActive)
          result.policies = [deliveryPolicy.content];
      } catch (error) {
        this.logger.warn(
          `Commercial delivery policy unavailable: ${error instanceof Error ? error.name : 'UNKNOWN'}`,
        );
      }
    }
    if (!relevantServiceCodes.length) return result;
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
          metadata: true,
          priceLists: {
            where: {
              isActive: true,
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
        this.currentOffer(product, resolution.market),
      );
      const scopeText = normalize(
        [
          ...(input.recentCustomerMessages ?? []),
          input.profile?.need,
          input.customerMessage,
        ]
          .filter(Boolean)
          .join(' '),
      );
      const advanced =
        /\b(?:automatizacion|ia|facturacion electronica|internacional|sistemas empresariales|animaciones inmersivas)\b/.test(
          scopeText,
        );
      const growth =
        /\b(?:inventario en tiempo real|carritos abandonados|filtros avanzados|posicionamiento local|analytics|search console|ocho paginas)\b/.test(
          scopeText,
        );
      const offers = result.offers.filter(
        (offer) => offer.serviceCode === relevantServiceCodes[0],
      );
      const ordered = [...offers].sort(
        (left, right) =>
          Number(left.amount ?? Infinity) - Number(right.amount ?? Infinity),
      );
      const named = ordered.find((offer) =>
        normalize(scopeText).includes(normalize(offer.name)),
      );
      result.recommendedOfferId = (
        named ?? ordered[advanced ? 2 : growth ? 1 : 0]
      )?.id;
      result.additionalScope = [
        /\b(?:reservas? (?:con|en) calendario|disponibilidad automatica|calendario (?:de )?reservas?)\b/.test(
          scopeText,
        )
          ? 'Reservas con calendario o disponibilidad automática'
          : /\breserv(?:a|ar|as)\b/.test(scopeText)
            ? 'Reservas automatizadas si necesita calendario y disponibilidad'
            : '',
        /\b(?:sistema de pedidos|pedidos automatizados|gestion de pedidos)\b/.test(
          scopeText,
        )
          ? 'Sistema de gestión de pedidos'
          : relevantServiceCodes[0] !== 'ONLINE_STORE' &&
              /\bpedidos?\b/.test(scopeText)
            ? 'Pedidos automatizados si necesita gestión interna o pagos en línea'
            : '',
      ].filter(Boolean);
      result.needsMarketClarification =
        input.priceRequested &&
        !resolution.market &&
        !result.offers.length &&
        products.some((product) =>
          product.priceLists.some(
            (price) => price.market !== null && this.isEligible(price),
          ),
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
    market?: CommercialMarket,
  ): AuthorizedOffer[] {
    if (!product.serviceCode) return [];
    const eligible = product.priceLists.filter((price) =>
      this.isEligible(price),
    );
    const marketSpecific = market
      ? eligible.filter((price) => price.market === market)
      : [];
    const applicable = marketSpecific.length
      ? marketSpecific
      : eligible.filter((price) => price.market === null);
    const base = applicable.filter((price) => !price.isPromotion);
    const promotion = applicable.filter((price) => price.isPromotion);
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
    const metadata =
      product.metadata &&
      typeof product.metadata === 'object' &&
      !Array.isArray(product.metadata)
        ? (product.metadata as Record<string, unknown>)
        : {};
    const terms =
      metadata.commercialTerms &&
      typeof metadata.commercialTerms === 'object' &&
      !Array.isArray(metadata.commercialTerms)
        ? (metadata.commercialTerms as Record<string, unknown>)
        : {};
    return [
      {
        id: selected.id,
        name: product.name,
        serviceCode: product.serviceCode,
        ...(selected.market ? { market: selected.market } : {}),
        marketScope: selected.market ? 'MARKET' : 'GLOBAL',
        priceType: selected.priceType!,
        ...(selected.price ? { amount: selected.price.toFixed(2) } : {}),
        currency: selected.currency as 'USD' | 'EUR',
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
        ...(terms.renewalUsdPerYear === 40 || terms.renewalUsdPerYear === 80
          ? { renewalUsdPerYear: terms.renewalUsdPerYear }
          : {}),
        ...(terms.estimatedBusinessDays === 10 ||
        terms.estimatedBusinessDays === 20
          ? { estimatedBusinessDays: terms.estimatedBusinessDays }
          : {}),
        ...(selected.validUntil
          ? { validUntil: selected.validUntil.toISOString() }
          : {}),
      },
    ];
  }

  private isEligible(price: ProductWithPrices['priceLists'][number]): boolean {
    return Boolean(
      price.priceType &&
      price.taxMode &&
      price.scope?.trim() &&
      price.policyVersion?.trim() &&
      (price.currency === 'USD' || price.currency === 'EUR') &&
      (price.taxMode === CommercialTaxMode.NOT_APPLICABLE ||
        price.taxLabel?.trim()) &&
      (price.priceType === CommercialPriceType.QUOTE_REQUIRED
        ? price.price === null
        : price.price !== null && price.price.gt(0)),
    );
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
  if (!snapshot.offers.length) {
    return [
      ...(snapshot.policies ?? []),
      snapshot.market
        ? `No hay tarifas comerciales aprobadas y vigentes para los servicios consultados en ${snapshot.market}. No comunique importes.`
        : 'No hay tarifas comerciales globales aprobadas y vigentes para los servicios consultados. No comunique importes.',
    ];
  }
  const offerKnowledge = snapshot.offers.map((offer) =>
    JSON.stringify({
      source: 'CRM_APPROVED_PRICE_LIST',
      ...offer,
    }),
  );
  const recommended = snapshot.offers.find(
    (offer) => offer.id === snapshot.recommendedOfferId,
  );
  if (recommended)
    offerKnowledge.push(
      `Plan principal sugerido: ${recommended.name}. Explica las prestaciones relevantes de su scope. No menciones el precio salvo que el cliente lo solicite. ${snapshot.additionalScope?.length ? `Necesidades adicionales por valorar separadamente: ${snapshot.additionalScope.join('; ')}. No presentes todo el proyecto como personalizado.` : ''}`,
    );
  if (recommended?.renewalUsdPerYear && snapshot.renewalRequested)
    offerKnowledge.push(
      `Para ${recommended.name}, el primer año de dominio y hosting está incluido si el alcance del plan lo indica. La renovación conjunta de hosting y dominio desde el segundo año es USD ${recommended.renewalUsdPerYear} anuales. Esta cifra no es mantenimiento de desarrollo ni soporte adicional.`,
    );
  if (recommended?.estimatedBusinessDays && snapshot.policies?.length)
    offerKnowledge.push(
      `Para ${recommended.name}, el plazo estimado es de aproximadamente ${recommended.estimatedBusinessDays} días laborables, sujeto a la entrega oportuna del material del cliente.`,
    );
  return [...offerKnowledge, ...(snapshot.policies ?? [])];
}

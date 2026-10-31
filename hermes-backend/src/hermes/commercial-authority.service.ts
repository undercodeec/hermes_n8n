import { Injectable, Logger } from '@nestjs/common';
import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestedSolutionKinds } from './commercial-catalog';
import {
  BLACK_FRIDAY_LANDING_POLICY_VERSION,
  recognizesBlackFridayLanding,
  requestsAnotherService,
} from './black-friday-landing';
import type { CommercialProfile } from './dto/hermes-request.dto';
import type { VerifiedBlackFridayAd } from './verified-ad-campaign';

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
  taxMode?: CommercialTaxMode;
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
  marketSource: 'CURRENT' | 'VERIFIED_AD' | 'PROFILE' | 'HISTORY' | 'UNKNOWN';
  relevantServiceCodes: string[];
  offers: AuthorizedOffer[];
  needsMarketClarification: boolean;
  needsCampaignTariffConfirmation?: boolean;
  needsAdMarketConflictClarification?: boolean;
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

function explicitProjectMarket(text: string): CommercialMarket | undefined {
  const match = normalize(text).match(
    /\b(?:proyecto|sitio web|pagina web|tienda online|servicio|landing|pagina de aterrizaje)\b.{0,40}\bpara\s+(ecuador|espana)\b/,
  )?.[1];
  return match === 'ecuador'
    ? CommercialMarket.EC
    : match === 'espana'
      ? CommercialMarket.ES
      : undefined;
}

function mentionedCurrency(
  text: string,
): 'USD' | 'EUR' | 'AMBIGUOUS' | undefined {
  const euros = /€|\b(?:EUR|euros?)\b/iu.test(text);
  const dollars = /\$|\b(?:USD|d[oó]lares?)\b/iu.test(text);
  if (euros && dollars) return 'AMBIGUOUS';
  return euros ? 'EUR' : dollars ? 'USD' : undefined;
}

export function resolveCommercialMarket(input: {
  customerMessage: string;
  profile?: CommercialProfile;
  recentCustomerMessages?: string[];
  verifiedAdMarket?: CommercialMarket;
}): { market?: CommercialMarket; source: CommercialSnapshot['marketSource'] } {
  const normalizedCurrent = normalize(input.customerMessage);
  const projectMarket = explicitProjectMarket(input.customerMessage);
  if (projectMarket) return { market: projectMarket, source: 'CURRENT' };
  if (input.verifiedAdMarket)
    return { market: input.verifiedAdMarket, source: 'VERIFIED_AD' };
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
    /** Verified, time-bound ad mapping. Never populated from customer text. */
    verifiedAdPolicyVersion?: typeof BLACK_FRIDAY_LANDING_POLICY_VERSION;
    verifiedAd?: VerifiedBlackFridayAd;
    /** A newer verified referral supersedes older promotional text. */
    ignoreHistoricalPromotion?: boolean;
    now?: Date;
  }): Promise<CommercialSnapshot> {
    const resolution = resolveCommercialMarket({
      ...input,
      verifiedAdMarket: input.verifiedAd?.market,
    });
    const projectMarket = explicitProjectMarket(input.customerMessage);
    const priorContext = [
      input.productOfInterest,
      input.profile?.service,
      input.profile?.need,
      input.profile?.businessNeeds,
    ]
      .filter(Boolean)
      .join(' ');
    const explicitDifferentService = requestsAnotherService(
      input.customerMessage,
    );
    const blackFridayRequested =
      !explicitDifferentService &&
      (recognizesBlackFridayLanding(
        input.customerMessage,
        input.ignoreHistoricalPromotion ? [] : input.recentCustomerMessages,
      ) ||
        input.verifiedAdPolicyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION ||
        input.verifiedAd?.policyVersion ===
          BLACK_FRIDAY_LANDING_POLICY_VERSION);
    const currentCurrency = mentionedCurrency(input.customerMessage);
    const historicalCurrency =
      currentCurrency ||
      resolution.source === 'CURRENT' ||
      Boolean(input.verifiedAd?.market) ||
      input.ignoreHistoricalPromotion
        ? undefined
        : [...(input.recentCustomerMessages ?? [])]
            .reverse()
            .map(mentionedCurrency)
            .find(Boolean);
    const requestedCurrency = currentCurrency ?? historicalCurrency;
    const currentServiceCodes: string[] = blackFridayRequested
      ? ['LANDING_PAGE']
      : requestedSolutionKinds(input.customerMessage, false);
    const explicitCurrentService =
      /\b(?:landing|p[aá]gina de aterrizaje|sitio web|p[aá]gina web|web corporativa|tienda online|ecommerce|comercio electr[oó]nico|app m[oó]vil|software a medida)\b/i.test(
        input.customerMessage,
      );
    const recentServiceCodes =
      [...(input.recentCustomerMessages ?? [])]
        .reverse()
        .map((message) => requestedSolutionKinds(message, false))
        .find((codes) => codes.length > 0) ?? [];
    const relevantServiceCodes = blackFridayRequested
      ? ['LANDING_PAGE']
      : currentServiceCodes.length && explicitCurrentService
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
      needsAdMarketConflictClarification: Boolean(
        blackFridayRequested &&
        input.verifiedAd?.market &&
        projectMarket &&
        projectMarket !== input.verifiedAd.market,
      ),
      renewalRequested:
        /\b(?:renovacion|renovar|hosting|dominio|gastos|costos? anuales?|segundo ano|despues del primer ano|que valores tendria que asumir|cuanto tendria que pagar)\b/.test(
          normalize(input.customerMessage),
        ),
    };
    if (result.needsAdMarketConflictClarification) return result;
    const deliveryRequested =
      /\b(?:plazo|tiempo de entrega|cuanto tarda|cuanto demora|dias laborables|para cuando|fecha de entrega)\b/.test(
        normalize(input.customerMessage),
      );
    if (deliveryRequested && blackFridayRequested) {
      result.policies = [
        'El plazo de entrega de la promoción Black Friday no está confirmado; un asesor puede verificarlo.',
      ];
    } else if (deliveryRequested) {
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
      result.offers = products
        .flatMap((product) =>
          this.currentOffer(
            product,
            resolution.market,
            blackFridayRequested,
            requestedCurrency,
            input.verifiedAd,
          ),
        )
        .filter(
          (offer) =>
            !blackFridayRequested ||
            (offer.promotion &&
              offer.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION),
        );
      const activeCampaignPrices = products.flatMap((product) =>
        product.priceLists.filter(
          (price) =>
            price.isPromotion &&
            price.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION &&
            this.isEligible(price),
        ),
      );
      result.needsCampaignTariffConfirmation =
        blackFridayRequested &&
        !result.offers.length &&
        (activeCampaignPrices.length > 0 || Boolean(input.verifiedAd?.market));
      if (
        blackFridayRequested &&
        !result.offers.length &&
        !activeCampaignPrices.length &&
        !input.verifiedAd?.market
      ) {
        result.policies = [
          ...(result.policies ?? []),
          'La promoción Black Friday de Landing Page no está activa. No confirmes el precio promocional; un asesor puede verificar su vigencia.',
        ];
      }
      const scopeText = normalize(
        [
          ...(input.recentCustomerMessages ?? []),
          input.profile?.need,
          input.customerMessage,
        ]
          .filter(Boolean)
          .join('. '),
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
      result.recommendedOfferId =
        blackFridayRequested && ordered.length > 1
          ? undefined
          : (named ?? ordered[advanced ? 2 : growth ? 1 : 0])?.id;
      const collectionRequest =
        /\b(?:agendar|agendamiento de|programar|coordinar|reservar|solicitar)\s+(?:(?:un|una|el|la|los|las)\s+)?(?:retiros?|recogidas?|recoleccion(?:es)?)\b(?!\s+de\s+efectivo)/;
      const scopeClauses = scopeText.split(
        /[.;!?]|\bpero\b|\by (?=no\b|sin\b|necesito\b|quiero\b)/,
      );
      const latestCollection = scopeClauses
        .filter((clause) =>
          /\b(?:retiros?|recogidas?|recoleccion(?:es)?)\b(?!\s+de\s+efectivo)/.test(
            clause,
          ),
        )
        .at(-1);
      const collectionRequired = Boolean(
        latestCollection &&
        collectionRequest.test(latestCollection) &&
        !/\b(?:no (?:necesito|quiero|requiere|necesita|debe)|sin (?:servicio de )?)\b/.test(
          latestCollection,
        ),
      );
      const independentReservations = scopeClauses
        .filter((clause) => !/\bno (?:necesito|quiero)\b/.test(clause))
        .map((clause) => clause.replace(collectionRequest, ''))
        .join(' ');
      result.additionalScope = [
        collectionRequired
          ? 'Agendamiento personalizado de retiros o recogidas'
          : '',
        /\b(?:reservas? (?:con|en) calendario|disponibilidad automatica|calendario (?:de )?reservas?)\b/.test(
          scopeText,
        )
          ? 'Reservas con calendario o disponibilidad automática'
          : /\breserv(?:a|ar|as)\b/.test(independentReservations)
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
      if (!blackFridayRequested) {
        result.needsMarketClarification =
          input.priceRequested &&
          !resolution.market &&
          !result.offers.length &&
          products.some((product) =>
            product.priceLists.some(
              (price) => price.market !== null && this.isEligible(price),
            ),
          );
      }
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
    blackFridayRequested = false,
    requestedCurrency?: 'USD' | 'EUR' | 'AMBIGUOUS',
    verifiedAd?: VerifiedBlackFridayAd,
  ): AuthorizedOffer[] {
    const serviceCode = product.serviceCode;
    if (!serviceCode) return [];
    const eligible = product.priceLists.filter(
      (price) =>
        this.isEligible(price) &&
        (price.policyVersion !== BLACK_FRIDAY_LANDING_POLICY_VERSION ||
          blackFridayRequested) &&
        (!blackFridayRequested ||
          !price.isPromotion ||
          price.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION),
    );
    const campaignPromotions = eligible.filter(
      (price) =>
        price.isPromotion &&
        price.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION &&
        eligible.some(
          (base) =>
            !base.isPromotion && base.id === price.supersedesPriceListId,
        ),
    );
    const marketCampaign =
      verifiedAd?.market && verifiedAd.currency
        ? campaignPromotions.filter(
            (price) =>
              price.market === verifiedAd.market &&
              price.currency === verifiedAd.currency,
          )
        : [];
    const verifiedCampaign = marketCampaign.length
      ? marketCampaign
      : verifiedAd?.market === CommercialMarket.EC
        ? campaignPromotions.filter(
            (price) => price.market === null && price.currency === 'USD',
          )
        : [];
    const matchedCampaign =
      verifiedAd?.market && verifiedAd.currency
        ? requestedCurrency && requestedCurrency !== verifiedAd.currency
          ? []
          : verifiedCampaign
        : requestedCurrency && requestedCurrency !== 'AMBIGUOUS'
          ? campaignPromotions.filter(
              (price) => price.currency === requestedCurrency,
            )
          : market && requestedCurrency !== 'AMBIGUOUS'
            ? campaignPromotions.filter(
                (price) =>
                  price.market === market ||
                  (market === CommercialMarket.EC &&
                    price.market === null &&
                    price.currency === 'USD'),
              )
            : campaignPromotions;
    const selectedCampaign =
      matchedCampaign.length === 1 ||
      (matchedCampaign.length === 2 &&
        new Set(matchedCampaign.map((price) => price.currency)).size === 2 &&
        (!market || requestedCurrency === 'AMBIGUOUS'))
        ? matchedCampaign
        : [];
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
      !blackFridayRequested &&
      promotion.length === 1 &&
      base.length === 1 &&
      promotion[0].supersedesPriceListId === base[0].id
    ) {
      selected = promotion[0];
    } else if (
      !blackFridayRequested &&
      promotion.length === 0 &&
      base.length === 1
    ) {
      selected = base[0];
    }
    const selectedPrices = blackFridayRequested
      ? selectedCampaign
      : selected
        ? [selected]
        : [];
    if (!selectedPrices.length) return [];
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
    return selectedPrices.map((selected) => ({
      id: selected.id,
      name:
        selected.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION
          ? selected.name
          : product.name,
      serviceCode,
      ...(selected.market ? { market: selected.market } : {}),
      marketScope: selected.market ? 'MARKET' : 'GLOBAL',
      priceType: selected.priceType!,
      ...(selected.price ? { amount: selected.price.toFixed(2) } : {}),
      currency: selected.currency as 'USD' | 'EUR',
      ...(selected.taxMode ? { taxMode: selected.taxMode } : {}),
      ...(selected.taxLabel ? { taxLabel: selected.taxLabel } : {}),
      ...(selected.taxRatePercent
        ? { taxRatePercent: selected.taxRatePercent.toFixed(2) }
        : {}),
      scope: selected.scope!.trim(),
      ...(selected.restrictions ? { restrictions: selected.restrictions } : {}),
      policyVersion: selected.policyVersion!.trim(),
      promotion: selected.isPromotion,
      ...(selected.policyVersion !== BLACK_FRIDAY_LANDING_POLICY_VERSION &&
      (terms.renewalUsdPerYear === 40 || terms.renewalUsdPerYear === 80)
        ? { renewalUsdPerYear: terms.renewalUsdPerYear }
        : {}),
      ...(selected.policyVersion !== BLACK_FRIDAY_LANDING_POLICY_VERSION &&
      (terms.estimatedBusinessDays === 10 || terms.estimatedBusinessDays === 20)
        ? { estimatedBusinessDays: terms.estimatedBusinessDays }
        : {}),
      ...(selected.validUntil
        ? { validUntil: selected.validUntil.toISOString() }
        : {}),
    }));
  }

  private isEligible(price: ProductWithPrices['priceLists'][number]): boolean {
    return Boolean(
      price.priceType &&
      (price.taxMode ||
        (price.isPromotion &&
          price.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION)) &&
      price.scope?.trim() &&
      price.policyVersion?.trim() &&
      (price.currency === 'USD' || price.currency === 'EUR') &&
      (price.taxMode === null ||
        price.taxMode === CommercialTaxMode.NOT_APPLICABLE ||
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
  if (snapshot.needsAdMarketConflictClarification) {
    return [
      'El país del proyecto indicado por el cliente difiere del mercado del anuncio verificado. No cites ninguna tarifa hasta aclararlo. Pregunta brevemente si desea orientación para el país que indicó.',
    ];
  }
  if (snapshot.needsMarketClarification) {
    return [
      'El precio depende del mercado y aún no se conoce el país aplicable. Si el cliente pregunta el precio, pida una sola aclaración breve: ¿El proyecto sería para Ecuador o España?',
    ];
  }
  if (snapshot.needsCampaignTariffConfirmation) {
    return [
      'No hay una tarifa Black Friday aprobada y vigente para la moneda o el país indicado. No cites el precio de otra moneda ni conviertas importes; un asesor debe verificar la tarifa aplicable.',
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
  const campaignOffer = snapshot.offers.find(
    (offer) =>
      offer.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION &&
      offer.promotion,
  );
  if (campaignOffer) {
    if (
      snapshot.offers.length === 2 &&
      snapshot.offers.some(
        (offer) =>
          offer.currency === 'EUR' && offer.market === CommercialMarket.ES,
      ) &&
      snapshot.offers.some(
        (offer) =>
          offer.currency === 'USD' && offer.market === CommercialMarket.EC,
      )
    ) {
      offerKnowledge.push(
        'Se seleccionaron las dos tarifas Black Friday aprobadas. Preséntalas en un solo mensaje breve: EUR para España y USD para Ecuador. No preguntes al cliente en qué país será el proyecto.',
      );
    }
    offerKnowledge.push(
      'La oferta Black Friday seleccionada en CRM es una landing de una sola sección para presentar un negocio, producto o servicio y captar prospectos. El precio y la moneda autorizados constan exclusivamente en el objeto CRM_APPROVED_PRICE_LIST anterior. Si preguntan qué incluye, enumera las diez características confirmadas en scope. Si preguntan solo por una característica, responde solo esa. Adapta la explicación al negocio conocido y pregunta por su actividad cuando sea útil. No es una tienda online. No afirmes impuestos, plazo de entrega, revisiones, pago, fecha de cierre, renovaciones ni resultados garantizados; un asesor puede confirmar condiciones no documentadas.',
    );
    const scope = normalize(campaignOffer.scope);
    const equivalentTerms = [
      /\b5 correos corporativos\b/u.test(scope)
        ? 'incluye cinco correos corporativos'
        : undefined,
      /\bdominio \.com y hosting basico por 1 ano\b/u.test(scope)
        ? 'incluye dominio .com durante un año; incluye hosting básico durante un año'
        : undefined,
      /\bseo tecnico base\b/u.test(scope)
        ? 'incluye configuración SEO técnica básica'
        : undefined,
      /\b1 mes de soporte posterior a la entrega\b/u.test(scope)
        ? 'incluye un mes de soporte posterior a la entrega'
        : undefined,
    ].filter(Boolean);
    if (equivalentTerms.length)
      offerKnowledge.push(
        `Formulaciones equivalentes respaldadas por el scope vigente: ${equivalentTerms.join('; ')}.`,
      );
  }
  const recommended = snapshot.offers.find(
    (offer) => offer.id === snapshot.recommendedOfferId,
  );
  if (recommended)
    offerKnowledge.push(
      `Plan principal sugerido: ${recommended.name}. Explica las prestaciones relevantes de su scope. ${recommended.policyVersion === BLACK_FRIDAY_LANDING_POLICY_VERSION ? 'En una consulta general sobre la promoción, indica el precio aprobado; en una pregunta puntual sin solicitud de precio, responde solo lo solicitado.' : 'No menciones el precio salvo que el cliente lo solicite.'} ${snapshot.additionalScope?.length ? `Necesidades adicionales por valorar separadamente: ${snapshot.additionalScope.join('; ')}. No presentes todo el proyecto como personalizado.` : ''}`,
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

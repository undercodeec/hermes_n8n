export type CommercialSolutionKind =
  | 'LANDING_PAGE'
  | 'WEBSITE'
  | 'ONLINE_STORE';

export const COMMERCIAL_OFFERS = {
  LANDING_BASIC: {
    kind: 'LANDING_PAGE',
    name: 'Landing Básica',
    price: 250,
  },
  LANDING_PRO: { kind: 'LANDING_PAGE', name: 'Landing Pro', price: 600 },
  LANDING_PREMIUM: {
    kind: 'LANDING_PAGE',
    name: 'Landing Premium',
    price: 1500,
  },
  WEBSITE_LAUNCH: {
    kind: 'WEBSITE',
    name: 'Plan de Lanzamiento',
    price: 360,
  },
  WEBSITE_GROWTH: {
    kind: 'WEBSITE',
    name: 'Plan de Crecimiento',
    price: 510,
  },
  WEBSITE_AUTHORITY: {
    kind: 'WEBSITE',
    name: 'Plan de Autoridad',
    price: 1010,
  },
  STORE_LAUNCH: {
    kind: 'ONLINE_STORE',
    name: 'Tienda de Lanzamiento',
    price: 550,
  },
  STORE_GROWTH: {
    kind: 'ONLINE_STORE',
    name: 'Tienda de Crecimiento',
    price: 850,
  },
  STORE_ELITE: {
    kind: 'ONLINE_STORE',
    name: 'Tienda Élite',
    price: 3490,
  },
} as const;

type CommercialOffer = (typeof COMMERCIAL_OFFERS)[keyof typeof COMMERCIAL_OFFERS];

const offerValues = Object.values(COMMERCIAL_OFFERS) as readonly CommercialOffer[];
const BASIC_HOSTING_RENEWAL_PRICE = 40;

function formatPrice(price: number): string {
  return price.toLocaleString('es-EC');
}

const INFRASTRUCTURE_POLICY = `Política de infraestructura web:
- Cuando el plan indique dominio, hosting y SSL por 1 año, esos elementos están incluidos durante el primer año.
- Hosting es el espacio del servidor donde funciona la web; dominio es la dirección, por ejemplo minegocio.com; SSL protege la conexión y muestra HTTPS.
- Después del primer año, la renovación de un hosting básico es USD $40 al año. Si el proyecto necesita más capacidad o infraestructura avanzada, el valor requiere evaluación.
- No atribuyas USD $40 a la renovación del dominio: su valor depende de la extensión y debe confirmarse.
- Cuando un plan incluya cuentas corporativas, explica que permiten direcciones como ventas@minegocio.com.`;

const STORE_DISCOVERY = `Guía de descubrimiento para tienda online:
- Avanza de forma conversacional y pregunta un dato útil por turno; no presentes un cuestionario.
- Antes de tratar una solicitud como tienda online, debe existir confirmación de que los compradores podrán comprar o pagar desde la web. Mostrar productos también puede resolverse con un catálogo sin carrito.
- Solo después de confirmar venta online, prioriza sin repetir datos conocidos: cantidad aproximada de productos; alcance de envíos; necesidad de filtros e inventario; dominio actual e integraciones. Pregunta por cobros únicamente cuando ayude a definir una integración ya confirmada.
- La cantidad de productos es un dato comercial clave. La carga inicial incluida en Tienda de Lanzamiento llega hasta 20 productos. Si necesita más, puedes usar el plan como referencia, pero la carga adicional requiere estimación.
- Recomienda un plan cuando exista información suficiente y explica brevemente por qué encaja. No esperes a recopilar todos los campos si la necesidad ya es clara.
- No cierres automáticamente con otra pregunta ni con una reunión. Pregunta únicamente si falta un dato que cambiaría el plan o la siguiente acción.
- Si el requerimiento cabe en las prestaciones publicadas, puedes comunicar el precio autorizado como precio del plan, IVA incluido.
- Si se aleja del alcance publicado, comunica el precio del plan más cercano solo como referencia o punto de partida, identifica qué requisito requiere valoración y ofrece una reunión para preparar una cotización. No inventes el recargo.
- No fuerces una reunión para una tienda estándar que encaja claramente en un plan.`;

const STORE_CATALOG = `Catálogo oficial del configurador — Tienda Online (USD, IVA incluido):
1. ${COMMERCIAL_OFFERS.STORE_LAUNCH.name} — USD $${formatPrice(COMMERCIAL_OFFERS.STORE_LAUNCH.price)}. Para iniciar ventas online.
   Incluye: catálogo administrable; carga inicial de hasta 20 productos; carrito y pago seguro; dominio .com, hosting y SSL por 1 año; diseño adaptable; configuración de envíos; configuración inicial en Google; 5 correos corporativos; capacitación para gestionar la tienda; 1 mes de soporte técnico.
2. ${COMMERCIAL_OFFERS.STORE_GROWTH.name} — USD $${formatPrice(COMMERCIAL_OFFERS.STORE_GROWTH.price)}. Para escalar ventas.
   Incluye todo lo de Tienda de Lanzamiento, más filtros avanzados, SEO técnico avanzado, recuperación de carritos abandonados, inventario en tiempo real, estrategia de envíos por zonas y condiciones, y 3 meses de soporte técnico.
3. ${COMMERCIAL_OFFERS.STORE_ELITE.name} — USD $${formatPrice(COMMERCIAL_OFFERS.STORE_ELITE.price)}. Arquitectura de alto rendimiento.
   Incluye todo lo de Tienda de Crecimiento, más tecnología ultra rápida, conexión con sistemas empresariales, recomendador con IA, ventas internacionales, automatización de marketing, facturación electrónica, seguridad reforzada, respaldos automáticos y soporte VIP por 6 meses.`;

const WEBSITE_CATALOG = `Catálogo oficial del configurador — Sitio Web (USD, IVA incluido):
1. ${COMMERCIAL_OFFERS.WEBSITE_LAUNCH.name} — USD $${formatPrice(COMMERCIAL_OFFERS.WEBSITE_LAUNCH.price)}. Hasta 5 páginas, diseño profesional adaptable, dominio .com y hosting por 1 año, SSL, hasta 5 correos corporativos, formulario y WhatsApp, configuración inicial en Google y 1 mes de soporte.
2. ${COMMERCIAL_OFFERS.WEBSITE_GROWTH.name} — USD $${formatPrice(COMMERCIAL_OFFERS.WEBSITE_GROWTH.price)}. Todo lo anterior, hasta 8 páginas, textos persuasivos, optimización de velocidad, posicionamiento local, Analytics y Search Console, integraciones y 3 meses de soporte.
3. ${COMMERCIAL_OFFERS.WEBSITE_AUTHORITY.name} — USD $${formatPrice(COMMERCIAL_OFFERS.WEBSITE_AUTHORITY.price)}. Todo lo anterior, diseño totalmente personalizado, automatización con IA, sistemas avanzados a medida, seguridad reforzada, campaña de Google Ads por 1 mes, seguimiento y soporte VIP por 6 meses.`;

const LANDING_CATALOG = `Catálogo oficial del configurador — Landing Page (USD, IVA incluido):
1. ${COMMERCIAL_OFFERS.LANDING_BASIC.name} — USD $${formatPrice(COMMERCIAL_OFFERS.LANDING_BASIC.price)}. Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por 1 año, 5 correos corporativos, SEO técnico base y 1 mes de soporte.
2. ${COMMERCIAL_OFFERS.LANDING_PRO.name} — USD $${formatPrice(COMMERCIAL_OFFERS.LANDING_PRO.price)}. Todo lo de Landing Básica, textos persuasivos, formulario optimizado, recurso promocional, Analytics e integración con WhatsApp y respuestas iniciales.
3. ${COMMERCIAL_OFFERS.LANDING_PREMIUM.name} — USD $${formatPrice(COMMERCIAL_OFFERS.LANDING_PREMIUM.price)}. Todo lo de Landing Básica, palabras clave para Google, campaña de Google Ads por 1 mes y diseño personalizado con animaciones inmersivas.`;

const GENERAL_SUMMARY = `Resumen de planes web autorizados (USD, IVA incluido): Sitio Web desde $${COMMERCIAL_OFFERS.WEBSITE_LAUNCH.price}; Landing Page desde $${COMMERCIAL_OFFERS.LANDING_BASIC.price}; Tienda Online desde $${COMMERCIAL_OFFERS.STORE_LAUNCH.price}. Antes de recomendar uno, identifica cuál de estos proyectos necesita el cliente.`;

const WEB_OPTIONS_GUIDE = `Guía para presentar opciones de presencia web:
- Para un negocio que quiere promocionar servicios, captar contactos o empezar con una presencia sencilla, compara primero en forma breve la Landing Básica de USD $250 y el Plan de Lanzamiento de USD $360.
- Explica la diferencia esencial, no toda la ficha: la landing concentra la información en una sola página; el sitio web permite organizarla en hasta 5 páginas.
- No enumeres todavía dominio, hosting, SSL, correos, SEO, formularios, soporte ni todas las prestaciones. Detállalas únicamente cuando el cliente muestre interés en una opción concreta o pregunte qué incluye.
- Si el cliente pregunta por una alternativa más económica a un sitio web, informa que la Landing Básica cuesta USD $250 y confirma si una sola página cubriría su necesidad.
- Si presentó interés en dos opciones y luego pregunta de forma ambigua «¿qué incluye?», aclara primero cuál de las dos desea conocer.`;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
}

function requestedSolutionKinds(query: string): CommercialSolutionKind[] {
  const normalized = normalize(query);
  if (
    /\b(software a medida|sistema a medida|aplicacion movil|app movil)\b/.test(
      normalized,
    )
  ) {
    return [];
  }
  const kinds = new Set<CommercialSolutionKind>();
  if (
    /\b(tienda online|ecommerce|comercio electronico|carrito|checkout|pasarela|vender online|venta online|comprar online|pagar online)\b/.test(
      normalized,
    )
  ) {
    kinds.add('ONLINE_STORE');
  }
  if (
    /\b(landing|pagina de aterrizaje|captar leads?|campana publicitaria)\b/.test(
      normalized,
    )
  ) {
    kinds.add('LANDING_PAGE');
  }
  if (
    /\b(sitio web|pagina web|web corporativa|presencia web|portal web)\b/.test(
      normalized,
    )
  ) {
    kinds.add('WEBSITE');
  }
  if (
    kinds.size === 0 &&
    /\b(planes?|precios?|tarifas?|paquetes?)\b/.test(normalized)
  ) {
    return ['LANDING_PAGE', 'WEBSITE', 'ONLINE_STORE'];
  }
  return [...kinds];
}

export function organizationLocationContext(): string {
  return 'UnderCodeEC trabaja de forma remota, tiene presencia en algunos países de Latinoamérica, Europa y Estados Unidos, y su sede principal está en Quito, Ecuador.';
}

export function authorizedPricesFor(query: string): readonly number[] {
  const kinds = requestedSolutionKinds(query);
  const prices: number[] = offerValues
    .filter((offer) => kinds.includes(offer.kind))
    .map((offer) => offer.price);
  const normalized = normalize(query);
  if (
    /\bhosting\b/.test(normalized) &&
    /\b(?:renovacion|renovar|segundo ano|despues del primer ano)\b/.test(
      normalized,
    )
  ) {
    prices.push(BASIC_HOSTING_RENEWAL_PRICE);
  }
  return prices;
}

export function hasPublishedPriceFor(query: string): boolean {
  return authorizedPricesFor(query).length > 0;
}

export function publishedPriceAnswer(query: string): string | undefined {
  const kinds = requestedSolutionKinds(query);
  if (kinds.length === 0) return undefined;

  const summaries: Record<CommercialSolutionKind, string> = {
    LANDING_PAGE: `Landing Page desde USD $${COMMERCIAL_OFFERS.LANDING_BASIC.price}.`,
    WEBSITE: `Sitio Web desde USD $${COMMERCIAL_OFFERS.WEBSITE_LAUNCH.price}.`,
    ONLINE_STORE: `Tienda Online desde USD $${COMMERCIAL_OFFERS.STORE_LAUNCH.price}.`,
  };
  return kinds.map((kind) => summaries[kind]).join(' ');
}

export function responseContainsOnlyAuthorizedPrices(
  query: string,
  response: string,
): boolean {
  const authorized = new Set(authorizedPricesFor(query));
  const amounts = monetaryAmountsIn(response);
  return amounts.every((amount) => authorized.has(amount));
}

export function monetaryAmountsIn(value: string): number[] {
  const pattern =
    /(?:\b(?:USD|dólares?)\s*\$?\s*([0-9]+(?:[.,][0-9]+)*)|\$\s*([0-9]+(?:[.,][0-9]+)*)|([0-9]+(?:[.,][0-9]+)*)\s*(?:USD|dólares?))/giu;
  return [...value.matchAll(pattern)]
    .map((match) => parseMoneyAmount(match[1] || match[2] || match[3]))
    .filter((amount): amount is number => amount !== undefined);
}

function parseMoneyAmount(value: string): number | undefined {
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');
  let normalized = value;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSeparator = lastDot > lastComma ? '.' : ',';
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    normalized = normalized.split(thousandsSeparator).join('');
    normalized = normalized.replace(decimalSeparator, '.');
  } else {
    const separator = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : undefined;
    if (separator) {
      const fractionLength = value.length - value.lastIndexOf(separator) - 1;
      normalized =
        fractionLength === 2
          ? value.replace(separator, '.')
          : value.split(separator).join('');
    }
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}

export function commercialCatalogContext(query: string): string[] {
  const normalized = normalize(query);
  const store =
    /\b(tienda online|ecommerce|comercio electronico|carrito|checkout|pasarela|vender online|venta online|comprar online|pagar online)\b/.test(
      normalized,
    ) ||
    (/\b(550|850|3490)\b/.test(normalized) &&
      /\b(incluye|trae|viene|interesa|detalles)\b/.test(normalized));
  const landing =
    /\b(landing|pagina de aterrizaje|captar leads?|campana publicitaria)\b/.test(
      normalized,
    ) ||
    (/\b250\b/.test(normalized) &&
      /\b(incluye|trae|viene|interesa|detalles)\b/.test(normalized));
  const website =
    /\b(sitio web|pagina web|web corporativa|presencia web|portal web)\b/.test(
      normalized,
    ) ||
    (/\b(360|510|1010)\b/.test(normalized) &&
      /\b(incluye|trae|viene|interesa|detalles)\b/.test(normalized));
  const compareWebOptions =
    website &&
    /\b(promocionar|promocion|presencia|servicios|economico|economica|barato|barata|alternativa|opciones?)\b/.test(
      normalized,
    );

  if (store) return [INFRASTRUCTURE_POLICY, STORE_DISCOVERY, STORE_CATALOG];
  if (landing) return [INFRASTRUCTURE_POLICY, LANDING_CATALOG];
  if (compareWebOptions)
    return [
      INFRASTRUCTURE_POLICY,
      WEB_OPTIONS_GUIDE,
      LANDING_CATALOG,
      WEBSITE_CATALOG,
    ];
  if (website) return [INFRASTRUCTURE_POLICY, WEBSITE_CATALOG];
  if (/\b(planes?|precios?|tarifas?|paquetes?)\b/.test(normalized)) {
    return [GENERAL_SUMMARY];
  }
  return [];
}

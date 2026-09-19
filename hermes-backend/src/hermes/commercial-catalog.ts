const INFRASTRUCTURE_POLICY = `Política de infraestructura web:
- Cuando el plan indique dominio, hosting y SSL por 1 año, esos elementos están incluidos durante el primer año.
- Hosting es el espacio del servidor donde funciona la web; dominio es la dirección, por ejemplo minegocio.com; SSL protege la conexión y muestra HTTPS.
- Después del primer año, la renovación de un hosting básico es USD $40 al año. Si el proyecto necesita más capacidad o infraestructura avanzada, el valor requiere evaluación.
- No atribuyas USD $40 a la renovación del dominio: su valor depende de la extensión y debe confirmarse.
- Cuando un plan incluya cuentas corporativas, explica que permiten direcciones como ventas@minegocio.com.`;

const STORE_DISCOVERY = `Guía de descubrimiento para tienda online:
- Avanza de forma conversacional y pregunta un dato útil por turno; no presentes un cuestionario.
- Prioriza, sin repetir datos conocidos: cantidad aproximada de productos; forma de cobro o pasarela; alcance de envíos; necesidad de filtros e inventario; dominio actual; cantidad de correos corporativos; integraciones, facturación electrónica o ventas internacionales.
- La cantidad de productos es un dato comercial clave. La carga inicial incluida en Tienda de Lanzamiento llega hasta 20 productos. Si necesita más, puedes usar el plan como referencia, pero la carga adicional requiere estimación.
- Recomienda un plan cuando exista información suficiente y explica brevemente por qué encaja. No esperes a recopilar todos los campos si la necesidad ya es clara.
- Después de recomendarlo, si aún falta definir pagos, envíos, inventario, dominio o integraciones, cierra con la siguiente pregunta más útil para continuar el asesoramiento.
- Si el requerimiento cabe en las prestaciones publicadas, puedes comunicar el precio autorizado como precio del plan, IVA incluido.
- Si se aleja del alcance publicado, comunica el precio del plan más cercano solo como referencia o punto de partida, identifica qué requisito requiere valoración y ofrece una reunión para preparar una cotización. No inventes el recargo.
- No fuerces una reunión para una tienda estándar que encaja claramente en un plan.`;

const STORE_CATALOG = `Catálogo oficial del configurador — Tienda Online (USD, IVA incluido):
1. Tienda de Lanzamiento — USD $550. Para iniciar ventas online.
   Incluye: catálogo administrable; carga inicial de hasta 20 productos; carrito y pago seguro; dominio .com, hosting y SSL por 1 año; diseño adaptable; configuración de envíos; configuración inicial en Google; 5 correos corporativos; capacitación para gestionar la tienda; 1 mes de soporte técnico.
2. Tienda de Crecimiento — USD $850. Para escalar ventas.
   Incluye todo lo de Tienda de Lanzamiento, más filtros avanzados, SEO técnico avanzado, recuperación de carritos abandonados, inventario en tiempo real, estrategia de envíos por zonas y condiciones, y 3 meses de soporte técnico.
3. Tienda Élite — USD $3.490. Arquitectura de alto rendimiento.
   Incluye todo lo de Tienda de Crecimiento, más tecnología ultra rápida, conexión con sistemas empresariales, recomendador con IA, ventas internacionales, automatización de marketing, facturación electrónica, seguridad reforzada, respaldos automáticos y soporte VIP por 6 meses.`;

const WEBSITE_CATALOG = `Catálogo oficial del configurador — Sitio Web (USD, IVA incluido):
1. Plan de Lanzamiento — USD $360. Hasta 5 páginas, diseño profesional adaptable, dominio .com y hosting por 1 año, SSL, hasta 5 correos corporativos, formulario y WhatsApp, configuración inicial en Google y 1 mes de soporte.
2. Plan de Crecimiento — USD $510. Todo lo anterior, hasta 8 páginas, textos persuasivos, optimización de velocidad, posicionamiento local, Analytics y Search Console, integraciones y 3 meses de soporte.
3. Plan de Autoridad — USD $1.010. Todo lo anterior, diseño totalmente personalizado, automatización con IA, sistemas avanzados a medida, seguridad reforzada, campaña de Google Ads por 1 mes, seguimiento y soporte VIP por 6 meses.`;

const LANDING_CATALOG = `Catálogo oficial del configurador — Landing Page (USD, IVA incluido):
1. Landing Básica — USD $250. Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por 1 año, 5 correos corporativos, SEO técnico base y 1 mes de soporte.
2. Landing Pro — USD $600. Todo lo de Landing Básica, textos persuasivos, formulario optimizado, recurso promocional, Analytics e integración con WhatsApp y respuestas iniciales.
3. Landing Premium — USD $1.500. Todo lo de Landing Básica, palabras clave para Google, campaña de Google Ads por 1 mes y diseño personalizado con animaciones inmersivas.`;

const GENERAL_SUMMARY = `Resumen de planes web autorizados (USD, IVA incluido): Sitio Web desde $360; Landing Page desde $250; Tienda Online desde $550. Antes de recomendar uno, identifica cuál de estos proyectos necesita el cliente.`;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
}

export function commercialCatalogContext(query: string): string[] {
  const normalized = normalize(query);
  const store =
    /\b(tienda|ecommerce|comercio electronico|catalogo|carrito|productos?|inventario|pasarela|envios?)\b/.test(
      normalized,
    );
  const landing =
    /\b(landing|pagina de aterrizaje|captar leads?|campana publicitaria)\b/.test(
      normalized,
    );
  const website =
    /\b(sitio web|pagina web|web corporativa|presencia web|portal web)\b/.test(
      normalized,
    );

  if (store) return [INFRASTRUCTURE_POLICY, STORE_DISCOVERY, STORE_CATALOG];
  if (landing) return [INFRASTRUCTURE_POLICY, LANDING_CATALOG];
  if (website) return [INFRASTRUCTURE_POLICY, WEBSITE_CATALOG];
  if (/\b(planes?|precios?|tarifas?|paquetes?)\b/.test(normalized)) {
    return [GENERAL_SUMMARY];
  }
  return [];
}

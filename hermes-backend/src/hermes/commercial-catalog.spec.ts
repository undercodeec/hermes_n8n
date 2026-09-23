import {
  COMMERCIAL_OFFERS,
  commercialCatalogContext,
  organizationLocationContext,
  publishedPriceAnswer,
  requestedSolutionKinds,
  responseContainsOnlyAuthorizedPrices,
} from './commercial-catalog';

describe('requestedSolutionKinds', () => {
  it.each([
    'Quiero promocionar mi negocio',
    'Quiero promocionar mi tienda',
    'Quiero promocionar mis servicios',
    'Quiero conseguir clientes',
    'Necesito captar clientes',
    'Quiero mostrar mis servicios',
    'Necesito tener presencia en internet',
    'Quiero que me contacten por WhatsApp',
    'Necesito recibir consultas',
    'Quiero dar a conocer mi negocio',
  ])('recovers landing and website for promotion intent: %s', (message) => {
    expect(requestedSolutionKinds(message, false)).toEqual([
      'LANDING_PAGE',
      'WEBSITE',
    ]);
  });

  it.each([
    'Quiero vender zapatos por internet',
    'Quiero vender ropa online',
    'Quiero vender mis productos',
    'Quiero que compren desde la página',
    'Quiero cobrar por la web',
    'Necesito un carrito de compras',
    'Quiero aceptar pagos y pedidos desde la web',
  ])('recovers online store for sales intent: %s', (message) => {
    expect(requestedSolutionKinds(message, false)).toContain('ONLINE_STORE');
  });

  it('keeps website and landing for a page that shows services', () => {
    expect(
      requestedSolutionKinds(
        'Necesito una página web para mostrar mis servicios',
        false,
      ),
    ).toEqual(['LANDING_PAGE', 'WEBSITE']);
  });

  it('keeps promotion and sales for different businesses in one turn', () => {
    expect(
      requestedSolutionKinds(
        'Tengo un negocio de reparación de lavadoras y otro de zapatos. Para el primero quiero promocionar mis servicios y con el segundo quiero vender por internet.',
        false,
      ),
    ).toEqual(['ONLINE_STORE', 'LANDING_PAGE', 'WEBSITE']);
  });

  it.each([
    'Vendo zapatos actualmente en mi local',
    'Quiero una página para mi tienda de zapatos',
    'Quiero promocionar mi tienda',
    'Quiero mostrar un catálogo',
    'Quiero mostrar mis zapatos en la página',
    'Quiero promocionar mi negocio online. Vendo zapatos en mi local',
    'Quiero vender mi negocio',
    'Quiero vender mis servicios',
  ])(
    'does not infer online checkout from display or physical sales: %s',
    (message) => {
      expect(requestedSolutionKinds(message, false)).not.toContain(
        'ONLINE_STORE',
      );
    },
  );
});

describe('commercialCatalogContext', () => {
  it('builds published website prices from typed catalog data', () => {
    expect(COMMERCIAL_OFFERS.WEBSITE_LAUNCH.price).toBe(360);
    expect(publishedPriceAnswer('¿Cuánto cuesta un sitio web?')).toContain(
      'USD $360',
    );
  });

  it('publishes only the authorized organization location', () => {
    expect(organizationLocationContext()).toContain('trabaja de forma remota');
    expect(organizationLocationContext()).toContain('Quito, Ecuador');
    expect(organizationLocationContext()).not.toMatch(
      /dirección|calle|oficina/i,
    );
  });

  it('rejects a monetary value not present in the selected catalog context', () => {
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta un sitio web?',
        'El sitio web cuesta USD $999.',
      ),
    ).toBe(false);
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta un sitio web?',
        'El sitio web publicado empieza en USD $360.',
      ),
    ).toBe(true);
  });

  it.each(['USD 999', '999 USD', '999 dólares', '$999'])(
    'rejects an unauthorized website price written as %s',
    (amount) => {
      expect(
        responseContainsOnlyAuthorizedPrices(
          '¿Cuánto cuesta un sitio web?',
          `El sitio web cuesta ${amount}.`,
        ),
      ).toBe(false);
    },
  );

  it('distinguishes decimal cents from thousands separators', () => {
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta un sitio web?',
        'El sitio web cuesta USD $360.00.',
      ),
    ).toBe(true);
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta un sitio web?',
        'El sitio web cuesta USD $1.010.',
      ),
    ).toBe(true);
  });

  it('authorizes the published basic-hosting renewal price only in renewal context', () => {
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta renovar el hosting básico después del primer año?',
        'La renovación del hosting básico cuesta USD $40 al año.',
      ),
    ).toBe(true);
    expect(
      responseContainsOnlyAuthorizedPrices(
        '¿Cuánto cuesta renovar el dominio?',
        'La renovación del dominio cuesta USD $40 al año.',
      ),
    ).toBe(false);
  });

  it('authorizes both landing and website prices in a comparison context', () => {
    expect(
      responseContainsOnlyAuthorizedPrices(
        'sitio web landing',
        'Landing desde USD $250 o sitio web desde USD $360.',
      ),
    ).toBe(true);
  });

  it('keeps both businesses and binds each published price to its solution', () => {
    const query =
      'Tengo reparación de lavadoras para promocionar servicios y zapatos para vender por internet. ¿Precios y tiempos?';
    const context = commercialCatalogContext(query).join('\n');
    expect(context).toContain('Landing Básica');
    expect(context).toContain('Plan de Lanzamiento');
    expect(context).toContain('Tienda de Lanzamiento');
    expect(
      responseContainsOnlyAuthorizedPrices(
        query,
        'Landing Básica USD $250. Plan de Lanzamiento USD $360. Tienda de Lanzamiento USD $550.',
      ),
    ).toBe(true);
    expect(
      responseContainsOnlyAuthorizedPrices(
        query,
        'Tienda de Lanzamiento USD $360.',
      ),
    ).toBe(false);
    expect(
      responseContainsOnlyAuthorizedPrices(query, 'Landing Básica 80 €.'),
    ).toBe(false);
  });

  it('provides the complete authorized store catalog and discovery guidance', () => {
    const context = commercialCatalogContext(
      'Quiero una tienda online para vender mis productos',
    ).join('\n');

    expect(context).toContain('Tienda de Lanzamiento — USD $550');
    expect(context).toContain('Tienda de Crecimiento — USD $850');
    expect(context).toContain('Tienda Élite — USD $3.490');
    expect(context).toContain('hasta 20 productos');
    expect(context).toContain('5 correos corporativos');
    expect(context).toContain('USD $40 al año');
    expect(context).toContain('pregunta un dato útil por turno');
  });

  it('does not mix store prices into a corporate website conversation', () => {
    const context = commercialCatalogContext(
      'Necesito un sitio web corporativo',
    ).join('\n');

    expect(context).toContain('Plan de Lanzamiento — USD $360');
    expect(context).not.toContain('Tienda de Lanzamiento');
  });

  it('does not assume ecommerce from a physical store that only wants to show products', () => {
    const context = commercialCatalogContext(
      'Tengo una tienda de ropa y quiero mostrar mis productos',
    ).join('\n');

    expect(context).not.toContain('Tienda de Lanzamiento');
    expect(context).not.toContain('Tienda de Crecimiento');
  });

  it('provides landing and website choices for a promotional services site', () => {
    const context = commercialCatalogContext(
      'Necesito un sitio web para promocionar mis servicios',
    ).join('\n');

    expect(context).toContain('Landing Básica — USD $250');
    expect(context).toContain('Plan de Lanzamiento — USD $360');
    expect(context).toContain('compara primero en forma breve');
    expect(context).toContain('no toda la ficha');
  });

  it('loads the selected landing details when the client identifies it by price', () => {
    const context = commercialCatalogContext(
      'Me interesa la de $250, ¿qué incluye?',
    ).join('\n');

    expect(context).toContain('Landing Básica — USD $250');
    expect(context).not.toContain('Plan de Lanzamiento — USD $360');
  });
});

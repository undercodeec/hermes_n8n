import { commercialCatalogContext } from './commercial-catalog';

describe('commercialCatalogContext', () => {
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

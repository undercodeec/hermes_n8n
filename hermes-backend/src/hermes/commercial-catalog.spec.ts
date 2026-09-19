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
});

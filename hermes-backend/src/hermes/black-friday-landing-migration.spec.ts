import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Black Friday landing seed', () => {
  const file = join(
    process.cwd(),
    'prisma/migrations/20261029200000_black_friday_landing_80/migration.sql',
  );

  it('stages the $80 promotion inactive and linked to the normal landing', () => {
    expect(existsSync(file)).toBe(true);
    const sql = readFileSync(file, 'utf8');
    expect(sql).toContain('commercial-price-landing-black-friday-80-global-v1');
    expect(sql).toContain('commercial-price-landing-basic-global-v1');
    expect(sql).toContain('80.00');
    expect(sql).toContain('black-friday-landing-80-v1');
    expect(sql).toMatch(/NULL,\s*NULL,\s*NULL,\s*'Captación de leads;/u);
    expect(sql).toMatch(/false,\s*CURRENT_TIMESTAMP/u);
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('contains all ten confirmed inclusions and no invented end date', () => {
    expect(existsSync(file)).toBe(true);
    const sql = readFileSync(file, 'utf8');
    for (const feature of [
      'Captación de leads',
      'una sola sección',
      'responsive para celulares',
      'WhatsApp y llamada directa',
      'formulario de contacto o captura de prospectos',
      'beneficios del servicio o producto',
      'dominio .com y hosting básico por 1 año',
      '5 correos corporativos',
      'SEO técnico base',
      '1 mes de soporte posterior a la entrega',
    ]) {
      expect(sql).toContain(feature);
    }
    expect(sql).toMatch(
      /CURRENT_TIMESTAMP,\s*NULL,\s*'No incluye tienda online/u,
    );
  });
});

const COMMON_COMMERCIAL_TYPOS: Array<[RegExp, string]> = [
  [/\bnesesito\b/g, 'necesito'],
  [/\bsitio wep\b/g, 'sitio web'],
  [/\brestorante\b/g, 'restaurante'],
  [
    /\b(?:servisiso|servisisos|servisio|servisios|serbisio|serbisios|servico|servicos)\b/g,
    'servicios',
  ],
  [/\bpresios?\b/g, 'precio'],
  [/\b(?:cotisacion|cotizacionn|cotisar)\b/g, 'cotizacion'],
  [/\b(?:yamar|yamame|llamr)\b/g, 'llamar'],
  [/\b(?:asesr|acesor)\b/g, 'asesor'],
];

/**
 * Corrige únicamente variantes frecuentes de términos comerciales. Se mantiene
 * deliberadamente conservador para no reescribir nombres, marcas ni datos del
 * cliente.
 */
export function normalizeCommonSpanishTypos(value: string): string {
  return COMMON_COMMERCIAL_TYPOS.reduce(
    (normalized, [pattern, replacement]) =>
      normalized.replace(pattern, replacement),
    value,
  );
}

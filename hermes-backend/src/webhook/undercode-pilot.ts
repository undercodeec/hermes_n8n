export type PilotOrigin = 'meta_ad' | 'organic';

export interface MetaReferral {
  source_type?: string;
  source_id?: string;
  ctwa_clid?: string;
}

export function classifyPilotOrigin(referral?: MetaReferral): {
  origin: PilotOrigin;
  adSourceId?: string;
} {
  if (
    referral?.source_type?.toLowerCase() !== 'ad' &&
    !referral?.ctwa_clid?.trim()
  ) {
    return { origin: 'organic' };
  }
  const adSourceId = referral?.source_id?.trim();
  return {
    origin: 'meta_ad',
    ...(adSourceId && adSourceId.length <= 128 ? { adSourceId } : {}),
  };
}

export function isTextualCommercialOptOut(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return (
    /\b(?:no (?:quiero|deseo) recibir|no me (?:envien|manden)|dejen de (?:enviarme|mandarme)|dejar de recibir)\b.{0,50}\b(?:publicidad|promociones|ofertas|mensajes comerciales|marketing)\b/u.test(
      normalized,
    ) ||
    /\b(?:denme|dame|solicito) de baja\b.{0,40}\b(?:publicidad|promociones|ofertas|mensajes comerciales|marketing)\b/u.test(
      normalized,
    ) ||
    /\b(?:quiero|deseo) darme de baja\b.{0,40}\b(?:campanas|publicidad|promociones|ofertas|marketing)\b/u.test(
      normalized,
    ) ||
    /\b(?:no (?:quiero|deseo) que me contacten mas|no me (?:contacten|escriban) mas)\b/u.test(
      normalized,
    ) ||
    /^(?:no recibir mensajes|baja|stop)[.!]?$/u.test(normalized)
  );
}

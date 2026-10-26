export type PilotOrigin = 'meta_ad' | 'organic' | 'unknown';
export type PilotOriginEvidence =
  | 'meta_referral_ad'
  | 'meta_ctwa_clid'
  | 'meta_referral_post'
  | 'insufficient';

export interface MetaReferral {
  source_type?: string;
  source_id?: string;
  ctwa_clid?: string;
}

export function classifyPilotOrigin(referral?: MetaReferral): {
  origin: PilotOrigin;
  evidence: PilotOriginEvidence;
  adSourceId?: string;
  ctwaClidPresent?: true;
} {
  const sourceType =
    typeof referral?.source_type === 'string'
      ? referral.source_type.trim().toLowerCase()
      : '';
  const clickId =
    typeof referral?.ctwa_clid === 'string' ? referral.ctwa_clid.trim() : '';
  const ctwaClidPresent = clickId.length > 0;
  if (sourceType === 'ad' || ctwaClidPresent) {
    const adSourceId =
      typeof referral?.source_id === 'string' ? referral.source_id.trim() : '';
    return {
      origin: 'meta_ad',
      evidence: sourceType === 'ad' ? 'meta_referral_ad' : 'meta_ctwa_clid',
      ...(adSourceId && adSourceId.length <= 128 ? { adSourceId } : {}),
      ...(ctwaClidPresent ? { ctwaClidPresent: true } : {}),
    };
  }
  if (sourceType === 'post')
    return { origin: 'organic', evidence: 'meta_referral_post' };
  return { origin: 'unknown', evidence: 'insufficient' };
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

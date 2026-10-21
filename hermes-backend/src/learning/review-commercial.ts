import { reviewCommercialClaims } from '../hermes/commercial-claims';
import {
  commercialClauses,
  deliveryQuantitiesIn,
  hasUnauthorizedPaymentTerms,
} from '../hermes/commercial-language';
import { monetaryValuesIn } from '../hermes/monetary-values';

const emptyAuthority = {
  marketSource: 'UNKNOWN' as const,
  relevantServiceCodes: [],
  offers: [],
  needsMarketClarification: false,
};

function normalize(text: string): string {
  return text
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Learning stores general rules only. Concrete offers remain in live commercial authority. */
export function commercialFailure(text: string): string | null {
  for (const clause of commercialClauses(text)) {
    const plain = normalize(clause);
    // Ambiguous sales instructions cannot become retrieval guidance: the live
    // authority has no way to prove what "flexible" conditions would mean.
    if (
      /\b(?:flexibiliz\w*|negoci\w*|mejor\w*|adapt\w*)\b.{0,65}\b(?:propuesta|oferta|condiciones|precio|pago|plazo)\b|\b(?:ofrec\w*|propon\w*)\b.{0,45}\b(?:condiciones atractivas|precio especial)\b|\b(?:confirm\w*|asegur\w*)\b.{0,45}\b(?:fecha concreta|disponibilidad)\b|\b(?:evit\w*|omit\w*)\b.{0,45}\b(?:escalar|derivar|handoff|humano)\b/i.test(
        plain,
      )
    )
      return 'COMMERCIAL_AMBIGUOUS_INSTRUCTION';
    if (
      /\b(?:reunion|cita|reserva|pago|cobro|mensaje|escalamiento|derivacion)\b.{0,45}\b(?:ya\s+)?(?:fue\s+)?(?:agendad[ao]|reservad[ao]|procesad[ao]|enviad[ao]|completad[ao]|confirmad[ao])\b|\b(?:hemos|he|ya)\s+(?:agendado|reservado|procesado|enviado|completado|escalado)\b/i.test(
        plain,
      )
    )
      return 'COMMERCIAL_UNVERIFIED_ACTION';
    if (monetaryValuesIn(clause).length) return 'COMMERCIAL_PRICE_CLAIM';
    if (
      /\b\d+(?:[.,]\d+)?\s*%\s*(?:de\s+)?(?:descuento|bonificacion|rebaja)/.test(
        plain,
      )
    )
      return 'COMMERCIAL_DISCOUNT_CLAIM';
    if (hasUnauthorizedPaymentTerms(plain)) return 'COMMERCIAL_PAYMENT_CLAIM';
    if (
      /\b(?:pago|pagar|cobro|abono|anticipo)\b.{0,45}\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*%\b.{0,45}\b(?:pago|pagar|cobro|abono|anticipo)\b/.test(
        plain,
      )
    )
      return 'COMMERCIAL_PAYMENT_CLAIM';
    const generalRule =
      /^(?:no\s+(?:inventar|comunicar|ofrecer|prometer|afirmar|aceptar|dar|aplicar)|evitar\s+(?:inventar|comunicar|ofrecer|prometer|afirmar|aceptar|dar|aplicar)|consultar|verificar|confirmar|validar|revisar|remitir|escalar|pedir\s+confirmacion)\b/.test(
        plain,
      ) &&
      !/\b(?:y|pero|ademas)\s+(?:ofrec\w*|acept\w*|aplic\w*|garantiz\w*|promet\w*|entreg\w*)\b/.test(
        plain,
      );
    if (generalRule) continue;
    if (reviewCommercialClaims(clause, emptyAuthority).reasons.length)
      return 'COMMERCIAL_AUTHORITY_CLAIM';
    if (
      /\b(?:acept\w*|ofrec\w*|pag\w*|cobr\w*|abon\w*|permit\w*)\b.{0,65}\b(?:transferencias?|tarjetas?|efectivo|paypal|stripe|cuotas?|anticipo|abono)\b|\b(?:transferencias?|tarjetas?|efectivo|paypal|stripe)\b.{0,55}\b(?:aceptad[ao]s?|permitid[ao]s?|disponible)\b/.test(
        plain,
      )
    )
      return 'COMMERCIAL_PAYMENT_CLAIM';
    if (
      deliveryQuantitiesIn(clause).length &&
      /\b(?:entreg\w*|plazos?|listo|terminad[ao]|garantiz\w*|compromiso|compromet\w*)/.test(
        plain,
      )
    )
      return 'COMMERCIAL_TIMELINE_CLAIM';
    if (
      /\b(?:ofrec\w*|inclu\w*|damos|tenemos|garantiz\w*|aplic\w*|otorg\w*|conced\w*|promet\w*|acept\w*|permit\w*)\b.{0,70}\b(?:garantia|promocion|bonificacion|descuento|entrega|sin costo|gratis|excepcion)\b|\b(?:garantia|promocion|bonificacion|descuento)\b.{0,45}\b(?:de|por|gratis|sin costo|incluid[ao])\b/.test(
        plain,
      )
    )
      return 'COMMERCIAL_TERMS_CLAIM';
  }
  return null;
}

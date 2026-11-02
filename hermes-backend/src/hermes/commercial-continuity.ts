import type { CommercialSnapshot } from './commercial-authority.service';
import type { CommercialProfile } from './dto/hermes-request.dto';
import { answerExplicitPriceIfMissing } from './commercial-claims';

/** Repair only a stalled campaign exchange; retain an informative safe answer. */
export function continueUnpricedCampaign(input: {
  response: string;
  customerMessage: string;
  snapshot: CommercialSnapshot;
  profile?: CommercialProfile;
  priceRequested: boolean;
  allowDiscoveryQuestion: boolean;
}): string {
  if (!input.snapshot.needsCampaignTariffConfirmation) return input.response;
  const current = input.customerMessage.trim();
  const stalled =
    /^(?:gracias(?:\s+por\s+confirmarlo)?[.!]?|de acuerdo[.!]?|perfecto[.!]?)$/iu.test(
      input.response.trim(),
    );
  const confirmation =
    /^(?:(?:en|para|con)\s+)?(?:euros?|eur|españa|ecuador|usd|dólares?)(?:\s+y\s+(?:euros?|eur|españa|ecuador|usd|dólares?))*[.!]?$/iu.test(
      current,
    );
  const fragment = /^(?:ahora\s+qu[eé]|y\s+ahora)\b/iu.test(current);
  if (!input.priceRequested && !stalled && !confirmation && !fragment)
    return input.response;

  const generic = /\b(?:tipo de proyecto|sitio web tiene en mente)\b/iu.test(
    input.response,
  );
  const useful =
    !stalled &&
    !fragment &&
    !generic &&
    /\b(?:página|landing|presentar|captar|formulario|whatsapp)\b/iu.test(
      input.response,
    )
      ? input.response
      : '';
  let result = useful || answerExplicitPriceIfMissing('', input.snapshot, true);
  if (!/\btarifa\b.*\bconfirm/iu.test(result)) {
    const notice = answerExplicitPriceIfMissing('', input.snapshot, true).split(
      ' Es una página',
    )[0];
    result = `${notice} ${result}`.trim();
  }
  if (!input.allowDiscoveryQuestion || /¿[^?]+\?/u.test(result)) return result;

  const hasBusiness = Boolean(
    input.profile?.sector ||
    input.profile?.businessNeeds ||
    input.profile?.company,
  );
  const hasGoal = Boolean(input.profile?.need);
  const question = hasGoal
    ? ''
    : hasBusiness
      ? '¿Qué contenido quiere destacar en la página?'
      : '¿A qué se dedica su negocio?';
  return `${result} ${question}`.trim();
}

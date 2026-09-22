import type { CommercialProfile } from '../hermes/dto/hermes-request.dto';
import type {
  ConversationTurnResult,
  ProposedAction,
} from './conversation-engine.types';

export type ReviewedAgentProposal = {
  profilePatch: CommercialProfile;
  tags: string[];
  action: ProposedAction;
  rejections: string[];
};

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function reviewAgentProposal(
  proposal: ConversationTurnResult,
  customerMessage: string,
  customerHistory: string[],
  allowedTags: string[],
): ReviewedAgentProposal {
  // Earlier turns provide conversational context but cannot authorize a new write
  // after the customer may have corrected that information.
  void customerHistory;
  const evidenceSource = normalize(customerMessage);
  const supported = (evidence?: string): boolean =>
    Boolean(
      evidence &&
      evidence.length >= 4 &&
      evidenceSource.includes(normalize(evidence)),
    );
  const profilePatch: CommercialProfile = {};
  const rejections: string[] = [];
  for (const [key, value] of Object.entries(
    proposal.business?.commercialProfile ?? {},
  )) {
    if (!supported(proposal.proposalEvidence?.[key])) {
      rejections.push(`PROFILE_EVIDENCE_MISSING:${key}`);
      continue;
    }
    if (typeof value === 'string') {
      const evidence = normalize(proposal.proposalEvidence?.[key] ?? '');
      const expected = normalize(value);
      const matches =
        key === 'contactPreference'
          ? ({
              CALL: /\b(?:llamada|llamar|llamen|telefono)\b/,
              WHATSAPP: /\b(?:whatsapp|chat)\b/,
              VIDEO_CALL: /\b(?:videollamada|video)\b/,
              EMAIL: /\b(?:correo|email)\b/,
            }[value]?.test(evidence) ?? false)
          : /^\d{1,3}$/.test(expected)
            ? new RegExp(`\\b${expected}\\b`).test(evidence)
            : evidence.includes(expected);
      if (!matches) {
        rejections.push(`PROFILE_VALUE_UNSUPPORTED:${key}`);
        continue;
      }
    }
    Object.assign(profilePatch, { [key]: value });
  }
  const tags = (proposal.business?.suggestedTags ?? []).filter((tag) => {
    if (
      allowedTags.includes(tag) &&
      evidenceSource.includes(normalize(tag.replace(/[_-]/g, ' ')))
    )
      return true;
    rejections.push(`TAG_NOT_SUPPORTED:${tag}`);
    return false;
  });
  const proposed = proposal.proposedActions[0] ?? { type: 'none' };
  let action: ProposedAction = { type: 'none' };
  const current = normalize(customerMessage);
  const affirmativeQuote =
    /\b(?:quiero|necesito|solicito|prepara|puedes|puede|podria|me gustaria)\b.{0,50}\b(?:cotizacion|presupuesto|propuesta|cotizar)\b|\bcotizame\b/.test(
      current,
    );
  const refusedQuote =
    /\b(?:no quiero|no necesito|no deseo|sin)\b.{0,40}\b(?:cotizacion|presupuesto|propuesta|cotizar)\b/.test(
      current,
    );
  const affirmativeHuman =
    /\b(?:quiero|necesito|solicito|pasame|comunicame)\b.{0,50}\b(?:humano|persona|asesor|agente)\b|\b(?:reclamo|queja)\b/.test(
      current,
    );
  const refusedHuman =
    /\b(?:no quiero|no necesito|no deseo|sin)\b.{0,40}\b(?:humano|persona|asesor|agente)\b/.test(
      current,
    );
  const affirmativeCall =
    /\b(?:llamame|llamarme|llamenme|pueden llamarme|quiero una llamada|necesito una llamada|quiero hablar por telefono)\b/.test(
      current,
    );
  const refusedCall =
    /\b(?:no quiero|no necesito|no me|sin)\b.{0,30}\b(?:llamada|llamar|llamen|telefono)\b/.test(
      current,
    );
  if (proposed.type !== 'none') {
    if (!supported(proposal.business?.decision))
      rejections.push('ACTION_EVIDENCE_MISSING');
    else if (
      proposed.type === 'request_handoff' &&
      affirmativeHuman &&
      !refusedHuman
    )
      action = proposed;
    else if (
      proposed.type === 'request_callback' &&
      affirmativeCall &&
      !refusedCall
    )
      action = proposed;
    else if (
      proposed.type === 'propose_quote_task' &&
      affirmativeQuote &&
      !refusedQuote
    )
      action = proposed;
    else rejections.push('ACTION_UNSUPPORTED_BY_CUSTOMER');
  }
  return { profilePatch, tags, action, rejections };
}

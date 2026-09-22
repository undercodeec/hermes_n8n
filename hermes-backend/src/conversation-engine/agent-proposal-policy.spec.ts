import { reviewAgentProposal } from './agent-proposal-policy';
import type { ConversationTurnResult } from './conversation-engine.types';

const result = (
  overrides: Partial<ConversationTurnResult> = {},
): ConversationTurnResult => ({
  replyText: 'Le puedo orientar sobre el sitio web.',
  proposedActions: [{ type: 'none' }],
  engine: 'nous_hermes',
  providerModel: 'hermes-agent',
  traceId: 'inbound',
  ...overrides,
});

describe('reviewAgentProposal', () => {
  it('accepts only profile values backed by literal customer evidence in this conversation', () => {
    const reviewed = reviewAgentProposal(
      result({
        business: { commercialProfile: { need: 'sitio web', budget: '$9999' } },
        proposalEvidence: {
          need: 'necesito un sitio web',
          budget: 'presupuesto $9999',
        },
      }),
      'necesito un sitio web',
      [],
      [],
    );
    expect(reviewed.profilePatch).toEqual({ need: 'sitio web' });
    expect(reviewed.rejections).toContain('PROFILE_EVIDENCE_MISSING:budget');
  });

  it('rejects unsupported actions while preserving valid reply and tags', () => {
    const reviewed = reviewAgentProposal(
      result({
        proposedActions: [
          { type: 'propose_quote_task', summary: 'Valorar proyecto' },
        ],
        business: {
          suggestedTags: ['web', 'private'],
          decision: 'quiero cotización',
        },
      }),
      'quiero detalles web',
      [],
      ['web'],
    );
    expect(reviewed.action.type).toBe('none');
    expect(reviewed.tags).toEqual(['web']);
    expect(reviewed.rejections).toContain('ACTION_EVIDENCE_MISSING');
  });

  it('does not accept an invented numeric value with unrelated literal evidence', () => {
    const reviewed = reviewAgentProposal(
      result({
        business: { commercialProfile: { budget: '$9999' } },
        proposalEvidence: { budget: 'mi presupuesto es $500' },
      }),
      'mi presupuesto es $500',
      [],
      [],
    );
    expect(reviewed.profilePatch.budget).toBeUndefined();
    expect(reviewed.rejections).toContain('PROFILE_VALUE_UNSUPPORTED:budget');
  });

  it('prefers the latest customer correction over an earlier value', () => {
    const reviewed = reviewAgentProposal(
      result({
        business: { commercialProfile: { service: 'tienda online' } },
        proposalEvidence: { service: 'tienda online' },
      }),
      'Me corrijo, quiero un sitio web',
      ['Quiero una tienda online'],
      [],
    );
    expect(reviewed.profilePatch.service).toBeUndefined();
    expect(reviewed.rejections).toContain('PROFILE_EVIDENCE_MISSING:service');
  });

  it('rejects a semantic field unsupported by the quoted evidence', () => {
    const reviewed = reviewAgentProposal(
      result({
        business: { commercialProfile: { service: 'tienda online' } },
        proposalEvidence: { service: 'quiero mostrar productos' },
      }),
      'quiero mostrar productos',
      [],
      [],
    );
    expect(reviewed.profilePatch.service).toBeUndefined();
    expect(reviewed.rejections).toContain('PROFILE_VALUE_UNSUPPORTED:service');
  });

  it('does not create quote or handoff actions from negated requests', () => {
    const quote = reviewAgentProposal(
      result({
        proposedActions: [{ type: 'propose_quote_task', summary: 'Valorar' }],
        business: { decision: 'No quiero cotización' },
      }),
      'No quiero cotización; solo pregunto el precio',
      [],
      [],
    );
    const handoff = reviewAgentProposal(
      result({
        proposedActions: [{ type: 'request_handoff', reason: 'cliente' }],
        business: { decision: 'No quiero hablar con una persona' },
      }),
      'No quiero hablar con una persona, solo información',
      [],
      [],
    );
    expect(quote.action.type).toBe('none');
    expect(handoff.action.type).toBe('none');
  });

  it('accepts a callback proposal only for an affirmative customer request', () => {
    const accepted = reviewAgentProposal(
      result({
        proposedActions: [{ type: 'request_callback' }],
        business: { decision: 'Llámame' },
      }),
      'Llámame mañana',
      [],
      [],
    );
    const rejected = reviewAgentProposal(
      result({
        proposedActions: [{ type: 'request_callback' }],
        business: { decision: 'no me llamen' },
      }),
      'Por favor no me llamen',
      [],
      [],
    );
    expect(accepted.action.type).toBe('request_callback');
    expect(rejected.action.type).toBe('none');
  });
});

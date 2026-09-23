import type {
  CommercialProfile,
  ConversationGuidance,
} from '../hermes/dto/hermes-request.dto';
import type { HermesDiagnostic } from '../hermes/hermes-diagnostics';
import type { CommercialSnapshot } from '../hermes/commercial-authority.service';

export type ConversationEngineId = 'gemini_direct' | 'nous_hermes';

export type ProposedAction =
  | { type: 'none' }
  | { type: 'request_handoff'; reason: string }
  | { type: 'request_callback' }
  | { type: 'propose_quote_task'; summary: string };

export type ApprovedConversationMessage = {
  role: 'user' | 'assistant';
  text: string;
};

export interface ConversationTurnInput {
  /** Internal CRM identifier. Never use a phone number or e-mail here. */
  conversationId: string;
  /** Persisted inbound message identifier used for correlation and deduplication. */
  inboundMessageId: string;
  customerMessage: string;
  approvedContext: {
    recentMessages: ApprovedConversationMessage[];
    commercialProfile?: CommercialProfile;
    recentProfileChanges?: Array<Record<string, string>>;
    approvedKnowledge: string[];
    commercialSnapshot?: CommercialSnapshot;
    handoffActive: boolean;
    contactName: string;
    leadStage?: string;
    productOfInterest?: string;
    conversationSummary?: string;
    contact?: {
      id: string;
      hasUsablePhone: boolean;
      hasEmail: boolean;
    };
    currentIntent?: string;
    conversationGuidance?: ConversationGuidance;
    pendingQuestions?: string[];
    contactPreference?: string;
    pendingActions?: Array<{
      type: string;
      status: string;
      dueAt?: string;
    }>;
    recentCompletedActions?: Array<{
      type: string;
      completedAt?: string;
    }>;
    actionCapabilities?: {
      callbackTasks: boolean;
      calendarBooking: boolean;
      humanHandoff: boolean;
    };
  };
}

export interface ConversationTurnResult {
  replyText: string;
  /** Conversational WhatsApp messages proposed by the agent, in send order. */
  replyParts?: string[];
  proposedActions: ProposedAction[];
  engine: ConversationEngineId;
  /** Effective provider model when the runtime can verify it, otherwise `unknown`. */
  providerModel: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  traceId: string;
  costEstimate?: number;
  business?: {
    suggestedTags?: string[];
    detectedIntent?: string;
    nextAction?: string;
    decision?: string;
    commercialProfile?: CommercialProfile;
  };
  /** Untrusted literal customer evidence for proposed profile fields. */
  proposalEvidence?: Record<string, string>;
  diagnostic?: HermesDiagnostic;
}

export interface ConversationEngine {
  readonly id: ConversationEngineId;
  respond(input: ConversationTurnInput): Promise<ConversationTurnResult>;
}

export class ConversationEngineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationEngineConfigurationError';
  }
}

import { Injectable } from '@nestjs/common';
import { HermesService } from '../hermes/hermes.service';
import type {
  ConversationEngine,
  ConversationTurnInput,
  ConversationTurnResult,
} from './conversation-engine.types';

@Injectable()
export class DirectGeminiEngine implements ConversationEngine {
  readonly id = 'gemini_direct' as const;

  constructor(private readonly hermes: HermesService) {}

  async respond(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const response = await this.hermes.generateResponse({
      contactName: input.approvedContext.contactName,
      messageContent: input.customerMessage,
      conversationHistory: input.approvedContext.recentMessages.map(
        ({ role, text }) => ({ role, content: text }),
      ),
      leadStage: input.approvedContext.leadStage,
      productOfInterest: input.approvedContext.productOfInterest,
      conversationSummary: input.approvedContext.conversationSummary,
      commercialProfile: input.approvedContext.commercialProfile,
      commercialSnapshot: input.approvedContext.commercialSnapshot,
      ...(input.approvedContext.approvedLearning?.length
        ? { approvedLearning: input.approvedContext.approvedLearning }
        : {}),
      contact: input.approvedContext.contact,
      conversationId: input.conversationId,
      correlationId: input.inboundMessageId,
      singleGenerationCanary: Boolean(input.singleGenerationCanary),
      currentIntent: input.approvedContext.currentIntent,
      conversationGuidance: input.approvedContext.conversationGuidance,
      pendingQuestions: input.approvedContext.pendingQuestions,
      contactPreference: input.approvedContext.contactPreference,
      pendingActions: input.approvedContext.pendingActions,
      actionCapabilities: input.approvedContext.actionCapabilities,
    });

    return {
      replyText: response.response,
      proposedActions: [{ type: 'none' }],
      engine: this.id,
      providerModel: this.hermes.getProviderModel(),
      promptVersion: this.hermes.getPromptVersion(),
      usage:
        response.tokensUsed === undefined
          ? undefined
          : { totalTokens: response.tokensUsed },
      traceId: input.inboundMessageId,
      ...(response.learningExposed?.length
        ? {
            learningExposed: response.learningExposed.map(
              ({ id, version }) => ({ id, version }),
            ),
          }
        : {}),
      costEstimate: response.costEstimate,
      business: {
        suggestedTags: response.suggestedTags,
        detectedIntent: response.detectedIntent,
        nextAction: response.nextAction,
        decision: response.decision,
        commercialProfile: response.commercialProfile,
      },
      diagnostic: response.diagnostic,
    };
  }
}

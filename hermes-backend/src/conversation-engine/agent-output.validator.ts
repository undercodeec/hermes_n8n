import { Injectable } from '@nestjs/common';
import type { CommercialProfile } from '../hermes/dto/hermes-request.dto';
import type { ProposedAction } from './conversation-engine.types';

export class InvalidAgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentOutputError';
  }
}

type ChatCompletionPayload = {
  error?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: unknown;
      function_call?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
    };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  model?: unknown;
  reasoning?: unknown;
  output?: unknown;
};

export type ValidatedAgentOutput = {
  replyText: string;
  detectedIntent?: string;
  suggestedTags?: string[];
  commercialProfilePatch?: CommercialProfile;
  fieldEvidence?: Record<string, string>;
  proposedNextAction?: ProposedAction;
  actionEvidence?: string;
  providerModel: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

@Injectable()
export class AgentOutputValidator {
  validate(
    payload: unknown,
    maximumReplyCharacters: number,
  ): ValidatedAgentOutput {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new InvalidAgentOutputError('Agent response is not an object');
    }

    const completion = payload as ChatCompletionPayload;
    if (completion.error !== undefined) {
      throw new InvalidAgentOutputError(
        'Agent response contains a top-level error',
      );
    }
    const choice = completion.choices?.[0];
    if (
      !choice ||
      typeof choice.finish_reason !== 'string' ||
      !choice.finish_reason.trim() ||
      choice.finish_reason.trim().toLowerCase() === 'error'
    ) {
      throw new InvalidAgentOutputError(
        'Agent response has an invalid finish reason',
      );
    }
    const message = choice.message;
    if (!message || typeof message !== 'object') {
      throw new InvalidAgentOutputError('Agent response has no final message');
    }
    if (
      message.tool_calls !== undefined ||
      message.function_call !== undefined ||
      message.reasoning !== undefined ||
      message.reasoning_content !== undefined ||
      completion.reasoning !== undefined ||
      completion.output !== undefined
    ) {
      throw new InvalidAgentOutputError(
        'Agent response contains tools, events, or reasoning',
      );
    }
    if (typeof message.content !== 'string') {
      throw new InvalidAgentOutputError('Agent final content is not text');
    }

    let proposal: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (!this.object(parsed)) throw new Error('not object');
      proposal = parsed;
    } catch {
      throw new InvalidAgentOutputError(
        'Agent final content is not a JSON proposal',
      );
    }
    const replyText =
      typeof proposal.replyText === 'string' ? proposal.replyText.trim() : '';
    if (!replyText) {
      throw new InvalidAgentOutputError('Agent final content is empty');
    }
    if (replyText.length > maximumReplyCharacters) {
      throw new InvalidAgentOutputError('Agent final content is too long');
    }
    if (
      /(?:BEGIN|END)[ _-]?(?:SYSTEM|PROMPT|REASONING)|<\/?(?:tool|analysis|reasoning)\b|```(?:json|sql|bash|sh|powershell)/i.test(
        replyText,
      )
    ) {
      throw new InvalidAgentOutputError(
        'Agent final content contains internal or structured data',
      );
    }

    const detectedIntent = this.optionalShortText(proposal.detectedIntent, 80);
    const actionEvidence = this.optionalShortText(proposal.actionEvidence, 300);
    let suggestedTags: string[] | undefined;
    if (proposal.suggestedTags !== undefined) {
      if (
        !Array.isArray(proposal.suggestedTags) ||
        proposal.suggestedTags.length > 8 ||
        !proposal.suggestedTags.every(
          (tag) => typeof tag === 'string' && /^[a-z0-9_-]{1,40}$/i.test(tag),
        )
      ) {
        throw new InvalidAgentOutputError('Agent tags are invalid');
      }
      suggestedTags = proposal.suggestedTags as string[];
    }
    const profileKeys = new Set([
      'service',
      'company',
      'sector',
      'location',
      'need',
      'currentSituation',
      'users',
      'productCount',
      'paymentNeeds',
      'shippingNeeds',
      'inventoryNeeds',
      'domainStatus',
      'corporateEmailNeeds',
      'integrations',
      'budget',
      'timeline',
      'lastObjection',
      'contactPreference',
    ]);
    let commercialProfilePatch: CommercialProfile | undefined;
    if (proposal.commercialProfilePatch !== undefined) {
      if (!this.object(proposal.commercialProfilePatch))
        throw new InvalidAgentOutputError('Agent profile patch is invalid');
      commercialProfilePatch = {};
      for (const [key, value] of Object.entries(
        proposal.commercialProfilePatch,
      )) {
        if (
          !profileKeys.has(key) ||
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 240
        ) {
          throw new InvalidAgentOutputError('Agent profile field is invalid');
        }
        if (
          key === 'contactPreference' &&
          !['WHATSAPP', 'CALL', 'VIDEO_CALL', 'EMAIL'].includes(value)
        ) {
          throw new InvalidAgentOutputError(
            'Agent contact preference is invalid',
          );
        }
        Object.assign(commercialProfilePatch, { [key]: value.trim() });
      }
    }
    let fieldEvidence: Record<string, string> | undefined;
    if (proposal.fieldEvidence !== undefined) {
      if (!this.object(proposal.fieldEvidence))
        throw new InvalidAgentOutputError('Agent evidence is invalid');
      fieldEvidence = {};
      for (const [key, value] of Object.entries(proposal.fieldEvidence)) {
        if (
          !profileKeys.has(key) ||
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > 300
        ) {
          throw new InvalidAgentOutputError('Agent evidence field is invalid');
        }
        fieldEvidence[key] = value.trim();
      }
    }
    let proposedNextAction: ProposedAction | undefined;
    if (proposal.proposedNextAction !== undefined) {
      if (!this.object(proposal.proposedNextAction))
        throw new InvalidAgentOutputError('Agent action is invalid');
      const action = proposal.proposedNextAction;
      if (action.type === 'none') proposedNextAction = { type: 'none' };
      else if (action.type === 'request_callback')
        proposedNextAction = { type: 'request_callback' };
      else if (
        action.type === 'request_handoff' &&
        typeof action.reason === 'string' &&
        action.reason.length <= 240
      )
        proposedNextAction = { type: 'request_handoff', reason: action.reason };
      else if (
        action.type === 'propose_quote_task' &&
        typeof action.summary === 'string' &&
        action.summary.length <= 500
      )
        proposedNextAction = {
          type: 'propose_quote_task',
          summary: action.summary,
        };
      else throw new InvalidAgentOutputError('Agent action type is invalid');
    }
    if (
      /\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/i.test(
        replyText,
      )
    ) {
      throw new InvalidAgentOutputError(
        'Agent final content contains secret-like material',
      );
    }

    const inputTokens = this.optionalNonNegativeInteger(
      completion.usage?.prompt_tokens,
    );
    const outputTokens = this.optionalNonNegativeInteger(
      completion.usage?.completion_tokens,
    );
    const usage =
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : {
            inputTokens,
            outputTokens,
            totalTokens:
              inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined,
          };

    return {
      replyText,
      detectedIntent,
      suggestedTags,
      commercialProfilePatch,
      fieldEvidence,
      proposedNextAction,
      actionEvidence,
      providerModel:
        typeof completion.model === 'string' && completion.model.trim()
          ? completion.model.trim()
          : 'unknown',
      usage,
    };
  }

  private object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private optionalShortText(value: unknown, limit: number): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      throw new InvalidAgentOutputError('Agent field is invalid');
    }
    return value.trim();
  }

  private optionalNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : undefined;
  }
}

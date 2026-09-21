import { Injectable } from '@nestjs/common';

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

    const replyText = message.content.trim();
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
      providerModel:
        typeof completion.model === 'string' && completion.model.trim()
          ? completion.model.trim()
          : 'unknown',
      usage,
    };
  }

  private optionalNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : undefined;
  }
}

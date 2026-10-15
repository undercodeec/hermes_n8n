import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { parseReviewOutput, ReviewOutput } from './review-output.validator';
import {
  buildReviewProviderRequest,
  ReviewMessage,
} from './review-provider-request';

export type ReviewProviderResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

@Injectable()
export class ReviewModelService {
  private readonly logger = new Logger(ReviewModelService.name);

  constructor(private readonly config: ConfigService) {}

  modelName(): string {
    return (
      this.config.get<string>('LEARNING_REVIEW_MODEL') ||
      this.config.get<string>('HERMES_MODEL', 'hermes-default')
    );
  }

  async review(
    messages: ReviewMessage[],
    reasonCode: string,
    suggestedReply: string | null,
    observeResponse?: (
      response: ReviewProviderResponse,
      httpStatus: number,
    ) => void,
  ): Promise<ReviewOutput> {
    const baseURL = this.config.get<string>(
      'HERMES_API_URL',
      'http://localhost:8080/v1',
    );
    const key = this.config.get<string>('HERMES_API_KEY');
    if (!key) throw new Error('REVIEW_PROVIDER_NOT_CONFIGURED');
    const response = await axios.post<ReviewProviderResponse>(
      `${baseURL.replace(/\/$/, '')}/chat/completions`,
      buildReviewProviderRequest(
        this.modelName(),
        messages,
        reasonCode,
        suggestedReply,
      ),
      {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 30000,
      },
    );
    observeResponse?.(response.data, response.status);
    const choice = response.data.choices?.[0];
    const content = choice?.message?.content;
    const diagnostic = (
      category: string,
      syntaxValid: boolean,
      schemaValid: boolean,
    ) =>
      this.logger.warn(
        JSON.stringify({
          event: 'learning_review_provider_invalid',
          category,
          provider: 'openai-compatible',
          model: this.modelName(),
          finishReason: [
            'stop',
            'length',
            'max_tokens',
            'content_filter',
            'safety',
            'error',
          ].includes(choice?.finish_reason ?? '')
            ? choice?.finish_reason
            : 'other_or_missing',
          responseLength: typeof content === 'string' ? content.length : 0,
          empty: typeof content !== 'string' || content.length === 0,
          syntaxValid,
          schemaValid,
        }),
      );
    if (
      choice?.finish_reason === 'length' ||
      choice?.finish_reason === 'max_tokens'
    ) {
      diagnostic('TRUNCATED', false, false);
      throw new Error('REVIEW_PROVIDER_TRUNCATED');
    }
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
      diagnostic('FINISH_REASON', false, false);
      throw new Error('REVIEW_PROVIDER_FINISH');
    }
    if (typeof content !== 'string' || content.length === 0) {
      diagnostic('EMPTY', false, false);
      throw new Error('REVIEW_PROVIDER_EMPTY');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      diagnostic('JSON_SYNTAX', false, false);
      throw new Error('REVIEW_PROVIDER_JSON');
    }
    try {
      return parseReviewOutput(
        parsed,
        new Set(messages.map((message) => message.id)),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : '';
      const category = [
        'REVIEW_OUTPUT_INVALID',
        'REVIEW_CANDIDATE_INVALID',
        'PRIVACY_VALIDATION_FAILED',
        'COMMERCIAL_VALIDATION_FAILED',
      ].includes(code)
        ? code
        : 'VALIDATION';
      diagnostic(
        category,
        true,
        category === 'PRIVACY_VALIDATION_FAILED' ||
          category === 'COMMERCIAL_VALIDATION_FAILED',
      );
      throw error;
    }
  }
}

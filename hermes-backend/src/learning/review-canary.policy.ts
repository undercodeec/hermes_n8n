import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReviewCanaryFeedbackIds(
  value: unknown,
): ReadonlySet<string> {
  if (value === undefined || value === '') return new Set();
  if (typeof value !== 'string')
    throw new Error(
      'LEARNING_REVIEW_CANARY_FEEDBACK_IDS must be a comma-separated UUID list',
    );
  if (value.trim() === '') return new Set();
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !UUID.test(id)))
    throw new Error(
      'LEARNING_REVIEW_CANARY_FEEDBACK_IDS contains an invalid UUID',
    );
  return new Set(ids.map((id) => id.toLowerCase()));
}

@Injectable()
export class ReviewCanaryPolicy {
  private readonly ids: ReadonlySet<string>;

  constructor(config: ConfigService) {
    this.ids = parseReviewCanaryFeedbackIds(
      config.get<string>('LEARNING_REVIEW_CANARY_FEEDBACK_IDS', ''),
    );
  }

  allowedIds(): string[] {
    return [...this.ids];
  }

  isFeedbackAllowed(feedbackId: string | null | undefined): boolean {
    return Boolean(feedbackId && this.ids.has(feedbackId.toLowerCase()));
  }

  assertFeedbackAllowed(feedbackId: string): void {
    if (!this.isFeedbackAllowed(feedbackId))
      throw new ForbiddenException(
        'Feedback fuera del alcance del reviewer canary',
      );
  }
}

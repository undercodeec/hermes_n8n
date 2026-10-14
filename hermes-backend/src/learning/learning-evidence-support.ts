import {
  ConversationReviewStatus,
  FeedbackRating,
  Prisma,
} from '@prisma/client';

// An evidence row is useful only while its original message, BAD feedback,
// and successful proposing review all remain linked. FK SetNull on deletion
// invalidates the row without requiring a new schema field.
export const effectiveEvidence: Prisma.LearningEvidenceWhereInput = {
  messageId: { not: null },
  feedbackId: { not: null },
  reviewId: { not: null },
  message: { isNot: null },
  feedback: { is: { rating: FeedbackRating.BAD } },
  review: { is: { status: ConversationReviewStatus.PROPOSED } },
};

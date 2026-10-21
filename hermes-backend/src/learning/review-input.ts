import { sanitizeReviewInput } from './review-privacy';

export type ReviewSourceMessage = {
  id: string;
  sender: string;
  content: string | null;
};

/** Shared by the worker and the isolated F2 provider evaluation. */
export function prepareReviewInput(messages: ReviewSourceMessage[]) {
  const evidenceIds = new Map<string, string>();
  const input = messages.map((message, index) => {
    const alias = `m${index + 1}`;
    evidenceIds.set(alias, message.id);
    return {
      id: alias,
      sender: message.sender,
      content: sanitizeReviewInput(message.content || ''),
    };
  });
  return { input, evidenceIds };
}

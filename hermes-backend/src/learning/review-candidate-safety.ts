import type { ReviewCandidate, ReviewOutput } from './review-output.validator';
import { commercialFailure } from './review-commercial';
import { privacyFailure } from './review-privacy';

type PersistedCandidateText = Pick<
  ReviewCandidate,
  'kind' | 'trigger' | 'guidance'
> & { serviceCode?: string | null; market?: string | null };

export function validateCandidateSafety(
  candidate: PersistedCandidateText,
): void {
  for (const value of Object.values(candidate)) {
    if (typeof value !== 'string') continue;
    const privacy = privacyFailure(value);
    if (privacy) throw new Error(`PRIVACY_VALIDATION_FAILED:${privacy}`);
    const commercial = commercialFailure(value);
    if (commercial)
      throw new Error(`COMMERCIAL_VALIDATION_FAILED:${commercial}`);
  }
}

export function validateReviewOutputSafety(output: ReviewOutput): void {
  for (const value of [
    output.issueCode,
    output.summary,
    output.counterexample,
  ]) {
    if (!value) continue;
    const failure = privacyFailure(value);
    if (failure) throw new Error(`PRIVACY_VALIDATION_FAILED:${failure}`);
  }
  if (output.candidate) validateCandidateSafety(output.candidate);
}

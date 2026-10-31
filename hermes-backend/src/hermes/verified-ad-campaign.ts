import { BLACK_FRIDAY_LANDING_POLICY_VERSION } from './black-friday-landing';
import { projectAttribution } from '../attribution-crm/attribution-crm';

export type VerifiedBlackFridayAd = {
  policyVersion: typeof BLACK_FRIDAY_LANDING_POLICY_VERSION;
  source: 'SOURCE_ID' | 'VERIFIED_META_AD_FALLBACK';
};

export function resolveVerifiedBlackFridayAd(input: {
  currentMetadata?: unknown;
  currentOccurredAt?: Date;
  priorMetadata?: unknown;
  priorOccurredAt?: Date;
  conversationMetadata?: unknown;
  conversationCreatedAt?: Date;
  now: Date;
  config: {
    sourceIds: string;
    fallbackEnabled: boolean;
    startsAt: string;
    endsAt: string;
  };
}): VerifiedBlackFridayAd | undefined {
  const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
  if (
    !utcTimestamp.test(input.config.startsAt) ||
    !utcTimestamp.test(input.config.endsAt)
  )
    return undefined;
  const start = Date.parse(input.config.startsAt);
  const end = Date.parse(input.config.endsAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    input.now.getTime() < start ||
    input.now.getTime() >= end
  )
    return undefined;

  const hasAttribution = (value: unknown) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'pilotOrigin' in value;
  const hasCurrentAttribution = hasAttribution(input.currentMetadata);
  const hasPriorAttribution = hasAttribution(input.priorMetadata);
  const metadata = hasCurrentAttribution
    ? input.currentMetadata
    : hasPriorAttribution
      ? input.priorMetadata
      : input.conversationMetadata;
  const occurred = hasCurrentAttribution
    ? (input.currentOccurredAt ?? input.now).getTime()
    : hasPriorAttribution
      ? input.priorOccurredAt?.getTime()
      : input.conversationCreatedAt?.getTime();
  if (
    occurred === undefined ||
    !Number.isFinite(occurred) ||
    occurred < start ||
    occurred >= end ||
    input.now.getTime() - occurred > 7 * 86_400_000
  )
    return undefined;
  const attribution = projectAttribution(metadata);
  if (attribution.origin !== 'meta_ad') return undefined;
  const ids = input.config.sourceIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (attribution.initialAdSourceId) {
    return ids.includes(attribution.initialAdSourceId)
      ? {
          policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
          source: 'SOURCE_ID',
        }
      : undefined;
  }
  return input.config.fallbackEnabled
    ? {
        policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
        source: 'VERIFIED_META_AD_FALLBACK',
      }
    : undefined;
}

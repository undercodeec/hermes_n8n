import { ConfigService } from '@nestjs/config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SingleGenerationCanaryConfig = {
  enabled: boolean;
  conversationId: string | null;
};

export function parseSingleGenerationCanaryConfig(
  enabled: unknown,
  conversationId: unknown,
  geminiAttempts?: unknown,
  nousAttempts?: unknown,
): SingleGenerationCanaryConfig {
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
    throw new Error(
      'F3_SINGLE_GENERATION_CANARY_ENABLED must be true or false',
    );
  if (conversationId !== undefined && typeof conversationId !== 'string')
    throw new Error(
      'F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID must be a UUID',
    );
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (id && !UUID.test(id))
    throw new Error(
      'F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID must be a UUID',
    );
  if (enabled === 'true' && !id)
    throw new Error('F3 single-generation canary requires a conversation ID');
  if (
    enabled === 'true' &&
    geminiAttempts !== undefined &&
    Number(geminiAttempts) !== 1
  )
    throw new Error('HERMES_COMPLETION_ATTEMPTS must be 1 for F3 canary');
  if (
    enabled === 'true' &&
    nousAttempts !== undefined &&
    Number(nousAttempts) !== 1
  )
    throw new Error('NOUS_HERMES_MAX_ATTEMPTS must be 1 for F3 canary');
  if (
    enabled === 'true' &&
    (geminiAttempts === undefined || nousAttempts === undefined)
  )
    throw new Error(
      'Both provider attempt limits must be explicitly 1 for F3 canary',
    );
  return {
    enabled: enabled === 'true',
    conversationId: id.toLowerCase() || null,
  };
}

export function isSingleGenerationCanaryConversation(
  config: ConfigService,
  conversationId: string,
): boolean {
  const policy = parseSingleGenerationCanaryConfig(
    config.get('F3_SINGLE_GENERATION_CANARY_ENABLED', 'false'),
    config.get('F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID', ''),
    config.get('HERMES_COMPLETION_ATTEMPTS'),
    config.get('NOUS_HERMES_MAX_ATTEMPTS'),
  );
  return (
    policy.enabled && policy.conversationId === conversationId.toLowerCase()
  );
}

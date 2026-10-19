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
  // The guarded source has its own durable dispatch reservation and one
  // attempt at each provider boundary. Global limits remain the baseline for
  // every other conversation, including concurrent traffic.
  for (const [name, value] of [
    ['HERMES_COMPLETION_ATTEMPTS', geminiAttempts],
    ['NOUS_HERMES_MAX_ATTEMPTS', nousAttempts],
  ] as const) {
    if (enabled === 'true' && value !== undefined) {
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new Error(`${name} must be a positive integer`);
      if (
        !/^[1-9]\d*$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value))
      )
        throw new Error(`${name} must be a positive integer`);
    }
  }
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

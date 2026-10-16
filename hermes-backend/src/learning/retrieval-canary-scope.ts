import { ConfigService } from '@nestjs/config';

// Conversation IDs are opaque; Prisma currently emits UUIDs, while older test
// fixtures use other safe IDs. Never interpret a pattern or a list as scope.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function parseRetrievalCanaryConversationId(
  value: unknown,
): string | null {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) return null;
  return value;
}

/** A global ON flag is insufficient: one exact conversation must be scoped. */
export function retrievalEnabledForConversation(
  config: ConfigService,
  conversationId: string,
): boolean {
  if (config.get<string>('LEARNING_RETRIEVAL_ENABLED', 'false') !== 'true')
    return false;
  const allowed = parseRetrievalCanaryConversationId(
    config.get<unknown>('LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST', ''),
  );
  return allowed !== null && allowed === conversationId;
}

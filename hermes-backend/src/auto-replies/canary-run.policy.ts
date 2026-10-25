import { ConfigService } from '@nestjs/config';
import { isSingleGenerationCanaryConversation } from './single-generation-canary.policy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CanaryRun = { id: string; start: Date; deadline: Date };

/** This opt-in transition is scoped to one Gemini QA conversation. */
export function activeCanaryRun(
  config: ConfigService,
  conversationId: string,
  now = new Date(),
): CanaryRun | null {
  const enabled = config.get<string>('F3_CANARY_RUN_GUARD_ENABLED', 'false');
  if (enabled === 'false') return null;
  if (enabled !== 'true') throw new Error('CANARY_RUN_CONFIGURATION_INVALID');
  if (!isSingleGenerationCanaryConversation(config, conversationId))
    return null;
  if (config.get<string>('F3_GEMINI_CAPS_ENABLED', 'false') !== 'true')
    throw new Error('CANARY_RUN_CONFIGURATION_INVALID');
  const id = config.get<string>('F3_CANARY_RUN_ID', '').trim().toLowerCase();
  const startRaw = config.get<string>('F3_CANARY_RUN_START_UTC', '');
  const deadlineRaw = config.get<string>('F3_CANARY_RUN_DEADLINE_UTC', '');
  const start = new Date(startRaw);
  const deadline = new Date(deadlineRaw);
  if (
    !UUID.test(id) ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(startRaw) ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(deadlineRaw) ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(deadline.getTime()) ||
    start.getTime() > now.getTime() ||
    deadline.getTime() <= now.getTime() ||
    deadline.getTime() <= start.getTime()
  )
    throw new Error('CANARY_RUN_CONFIGURATION_INVALID');
  return { id, start, deadline };
}

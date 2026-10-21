import { ConfigService } from '@nestjs/config';
import {
  isSingleGenerationCanaryConversation,
  parseSingleGenerationCanaryConfig,
} from './single-generation-canary.policy';
import { retrievalEnabledForConversation } from '../learning/retrieval-canary-scope';

const ID = 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc';

describe('F3 single-generation canary configuration', () => {
  it.each([
    ['false', '', false],
    ['false', ID, false],
    ['true', ID, true],
  ])('accepts enabled=%s, id=%s', (enabled, id, armed) => {
    const parsed = parseSingleGenerationCanaryConfig(
      enabled,
      id,
      undefined,
      '3',
    );
    expect(parsed.enabled).toBe(armed);
    const config = {
      get: (key: string) =>
        ({
          F3_SINGLE_GENERATION_CANARY_ENABLED: enabled,
          F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: id,
          NOUS_HERMES_MAX_ATTEMPTS: '3',
        })[key as 'F3_SINGLE_GENERATION_CANARY_ENABLED'],
    } as ConfigService;
    expect(isSingleGenerationCanaryConversation(config, ID)).toBe(armed);
    expect(isSingleGenerationCanaryConversation(config, 'different')).toBe(
      false,
    );
  });

  it.each([
    ['true', ''],
    ['true', 'not-a-uuid'],
    ['false', 'not-a-uuid'],
    ['yes', ID],
  ])('rejects enabled=%s, id=%s', (enabled, id) => {
    expect(() =>
      parseSingleGenerationCanaryConfig(enabled, id, '1', '1'),
    ).toThrow();
  });

  it('preserves neutral global budgets and rejects invalid values while armed', () => {
    expect(
      parseSingleGenerationCanaryConfig('true', ID, undefined, '3'),
    ).toEqual({
      enabled: true,
      conversationId: ID,
    });
    expect(() =>
      parseSingleGenerationCanaryConfig('true', ID, '0', '3'),
    ).toThrow();
    expect(() =>
      parseSingleGenerationCanaryConfig('true', ID, undefined, 'invalid'),
    ).toThrow();
  });

  it('keeps guard and retrieval as separate exact scopes', () => {
    const config = new ConfigService({
      F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
      F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: ID,
      NOUS_HERMES_MAX_ATTEMPTS: '3',
      LEARNING_RETRIEVAL_ENABLED: 'true',
      LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST: ID,
    });
    expect(isSingleGenerationCanaryConversation(config, ID)).toBe(true);
    expect(retrievalEnabledForConversation(config, ID)).toBe(true);
    expect(isSingleGenerationCanaryConversation(config, 'other')).toBe(false);
    expect(retrievalEnabledForConversation(config, 'other')).toBe(false);
    const separate = new ConfigService({
      F3_SINGLE_GENERATION_CANARY_ENABLED: 'true',
      F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: ID,
      NOUS_HERMES_MAX_ATTEMPTS: '3',
      LEARNING_RETRIEVAL_ENABLED: 'false',
      LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST: ID,
    });
    expect(isSingleGenerationCanaryConversation(separate, ID)).toBe(true);
    expect(retrievalEnabledForConversation(separate, ID)).toBe(false);
  });
});

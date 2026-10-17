import { ConfigService } from '@nestjs/config';
import {
  isSingleGenerationCanaryConversation,
  parseSingleGenerationCanaryConfig,
} from './single-generation-canary.policy';

const ID = 'd3e10ce6-996f-4e89-bc98-68bcbb3e28dc';

describe('F3 single-generation canary configuration', () => {
  it.each([
    ['false', '', false],
    ['false', ID, false],
    ['true', ID, true],
  ])('accepts enabled=%s, id=%s', (enabled, id, armed) => {
    const parsed = parseSingleGenerationCanaryConfig(enabled, id, '1', '1');
    expect(parsed.enabled).toBe(armed);
    const config = {
      get: (key: string) =>
        ({
          F3_SINGLE_GENERATION_CANARY_ENABLED: enabled,
          F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID: id,
          HERMES_COMPLETION_ATTEMPTS: '1',
          NOUS_HERMES_MAX_ATTEMPTS: '1',
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

  it('rejects provider retry budgets above one while armed', () => {
    expect(() =>
      parseSingleGenerationCanaryConfig('true', ID, '2', '1'),
    ).toThrow();
    expect(() =>
      parseSingleGenerationCanaryConfig('true', ID, '1', '3'),
    ).toThrow();
  });
});

import { ConfigService } from '@nestjs/config';
import {
  parseRetrievalCanaryConversationId,
  retrievalEnabledForConversation,
} from './retrieval-canary-scope';

describe('F3 retrieval canary scope', () => {
  const qa = '123e4567-e89b-42d3-a456-426614174000';
  const other = '123e4567-e89b-42d3-a456-426614174001';
  const config = (flag: unknown, allowlist: unknown) =>
    new ConfigService({
      LEARNING_RETRIEVAL_ENABLED: flag,
      LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST: allowlist,
    });

  it.each([
    ['false', '', qa, false],
    ['true', '', qa, false],
    ['true', qa, qa, true],
    ['true', qa, other, false],
    ['true', qa, `${qa}-suffix`, false],
    ['true', qa, qa.toUpperCase(), false],
    ['true', ` ${qa}`, qa, false],
    ['true', `${qa} `, qa, false],
    ['true', `${qa},${qa}`, qa, false],
    ['true', `${qa},${other}`, qa, false],
    ['true', '*', qa, false],
    ['true', 'bad.id', qa, false],
    ['true', undefined, qa, false],
    [undefined, qa, qa, false],
    ['TRUE', qa, qa, false],
    ['1', qa, qa, false],
    ['true', 123, qa, false],
  ] as const)(
    'flag=%s allowlist=%s conversation=%s permits retrieval=%s',
    (flag, allowlist, conversationId, expected) => {
      expect(
        retrievalEnabledForConversation(
          config(flag, allowlist),
          conversationId,
        ),
      ).toBe(expected);
    },
  );

  it('accepts one safe opaque ID, never wildcards, whitespace or a list', () => {
    expect(parseRetrievalCanaryConversationId('conversation-1')).toBe(
      'conversation-1',
    );
    for (const invalid of ['', '*', 'qa id', 'qa,id', 'qa\n', 'x', null])
      expect(parseRetrievalCanaryConversationId(invalid)).toBeNull();
  });
});

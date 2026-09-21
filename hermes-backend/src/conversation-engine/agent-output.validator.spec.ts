import {
  AgentOutputValidator,
  InvalidAgentOutputError,
} from './agent-output.validator';

describe('AgentOutputValidator', () => {
  const validator = new AgentOutputValidator();

  it('accepts only the final text and verified usage fields', () => {
    expect(
      validator.validate(
        {
          model: 'gemini-3.8-flash',
          choices: [
            { finish_reason: 'stop', message: { content: ' Respuesta final. ' } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        900,
      ),
    ).toEqual({
      replyText: 'Respuesta final.',
      providerModel: 'gemini-3.8-flash',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it.each([
    null,
    {},
    {
      error: { message: 'provider failed' },
      choices: [
        { finish_reason: 'stop', message: { content: 'texto' } },
      ],
    },
    {
      choices: [
        { finish_reason: 'error', message: { content: 'provider detail' } },
      ],
    },
    { choices: [{ message: { content: 'texto' } }] },
    { choices: [{ finish_reason: '', message: { content: 'texto' } }] },
    { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: { text: 'no' } } }] },
    {
      choices: [
        { message: { content: 'texto', tool_calls: [{ name: 'shell' }] } },
      ],
    },
    { choices: [{ message: { content: 'texto', reasoning: 'interno' } }] },
    { choices: [{ message: { content: '```sql\nselect *\n```' } }] },
    { choices: [{ message: { content: 'token=secret-value' } }] },
    { choices: [{ message: { content: 'Bearer abcdefghijk' } }] },
  ])('rejects malformed or internal provider output %#', (payload) => {
    expect(() => validator.validate(payload, 900)).toThrow(
      InvalidAgentOutputError,
    );
  });

  it('rejects an oversized response', () => {
    expect(() =>
      validator.validate(
        {
          choices: [
            { finish_reason: 'stop', message: { content: 'x'.repeat(11) } },
          ],
        },
        10,
      ),
    ).toThrow('too long');
  });
});

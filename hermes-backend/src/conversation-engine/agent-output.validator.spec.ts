import {
  AgentOutputValidator,
  InvalidAgentOutputError,
} from './agent-output.validator';

describe('AgentOutputValidator', () => {
  const validator = new AgentOutputValidator();

  it('accepts a structured proposal in the proven chat completion content field', () => {
    expect(
      validator.validate(
        {
          model: 'gemini-3.8-flash',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  replyText: 'Respuesta final.',
                  detectedIntent: 'consulta_precio',
                  suggestedTags: ['web'],
                  commercialProfilePatch: { need: 'sitio web' },
                  fieldEvidence: { need: 'necesito un sitio web' },
                  proposedNextAction: { type: 'none' },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        900,
      ),
    ).toEqual({
      replyText: 'Respuesta final.',
      detectedIntent: 'consulta_precio',
      suggestedTags: ['web'],
      commercialProfilePatch: { need: 'sitio web' },
      fieldEvidence: { need: 'necesito un sitio web' },
      proposedNextAction: { type: 'none' },
      providerModel: 'gemini-3.8-flash',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('rejects prose, fabricated action types and invalid JSON', () => {
    for (const content of [
      'Respuesta final.',
      '{',
      JSON.stringify({
        replyText: 'Hola',
        proposedNextAction: { type: 'execute_sql' },
      }),
    ]) {
      expect(() =>
        validator.validate(
          { choices: [{ finish_reason: 'stop', message: { content } }] },
          900,
        ),
      ).toThrow(InvalidAgentOutputError);
    }
  });

  it.each([
    null,
    {},
    {
      error: { message: 'provider failed' },
      choices: [{ finish_reason: 'stop', message: { content: 'texto' } }],
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
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ replyText: 'x'.repeat(11) }),
              },
            },
          ],
        },
        10,
      ),
    ).toThrow('too long');
  });
});

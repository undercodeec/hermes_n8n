import {
  AgentOutputValidator,
  InvalidAgentOutputError,
} from './agent-output.validator';

describe('AgentOutputValidator', () => {
  const validator = new AgentOutputValidator();
  const completion = (proposal: unknown) => ({
    choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(proposal) } },
    ],
  });

  it('accepts a greeting with no profile changes or action', () => {
    expect(
      validator.validate(
        completion({ replyText: 'Hola, ¿en qué puedo ayudarle?' }),
        900,
      ).replyText,
    ).toBe('Hola, ¿en qué puedo ayudarle?');
  });

  it.each([
    [
      {
        replyText: 'Hola',
        commercialProfilePatch: { objective: 'vender más' },
      },
      'profile field',
    ],
    [
      { replyText: 'Hola', proposedNextAction: 'request_callback' },
      'action is invalid',
    ],
    [
      {
        replyText: 'Le llamaremos',
        proposedNextAction: { type: 'request_callback' },
      },
      'evidence',
    ],
  ])('rejects the confirmed VPS failure shape %#', (proposal, reason) => {
    expect(() => validator.validate(completion(proposal), 900)).toThrow(reason);
  });

  it.each([
    [
      { replyText: 'Le ayudamos con desarrollo web.' },
      'general service question',
    ],
    [
      {
        replyText: 'Podemos conversar sobre su negocio.',
        commercialProfilePatch: { sector: 'salud', need: 'captar clientes' },
        fieldEvidence: { sector: 'sector salud', need: 'captar clientes' },
      },
      'sector and objective',
    ],
    [
      {
        replyText: 'Entendido, corrijo el dato.',
        commercialProfilePatch: { service: 'sitio web' },
        fieldEvidence: { service: 'sitio web' },
      },
      'corrected field',
    ],
    [
      {
        replyText: 'Registraré su solicitud para revisión.',
        proposedNextAction: {
          type: 'propose_quote_task',
          summary: 'Sitio web',
        },
        actionEvidence: 'Quiero una cotización',
      },
      'quote request',
    ],
    [
      {
        replyText: 'Registraré su solicitud de llamada.',
        proposedNextAction: { type: 'request_callback' },
        actionEvidence: 'Llámame mañana',
      },
      'callback request',
    ],
    [
      {
        replyText: 'Le pondré en contacto con el equipo.',
        proposedNextAction: {
          type: 'request_handoff',
          reason: 'Solicita una persona',
        },
        actionEvidence: 'Quiero hablar con una persona',
      },
      'human request',
    ],
  ])('accepts synthetic %s', (proposal) => {
    expect(validator.validate(completion(proposal), 900).replyText).toBe(
      proposal.replyText,
    );
  });

  it.each([
    [
      { replyText: 'Hola', commercialProfilePatch: { sector: 'salud' } },
      'profile evidence',
    ],
    [
      { replyText: 'Hola', fieldEvidence: { sector: 'salud' } },
      'no profile field',
    ],
    [
      {
        replyText: 'Hola',
        proposedNextAction: { type: 'none' },
        actionEvidence: 'hola',
      },
      'no action',
    ],
    [
      {
        replyText: 'Hola',
        proposedNextAction: { type: 'request_callback', extra: true },
        actionEvidence: 'Llámame',
      },
      'action fields',
    ],
  ])('rejects inconsistent synthetic proposal %#', (proposal, reason) => {
    expect(() => validator.validate(completion(proposal), 900)).toThrow(reason);
  });

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

import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { HermesService } from './hermes.service';

describe('HermesService commercial contract', () => {
  function setup(content: string | string[]) {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          HERMES_API_URL:
            'https://generativelanguage.googleapis.com/v1beta/openai/',
          HERMES_API_KEY: 'test-key',
          HERMES_MODEL: 'gemini-test',
          HERMES_STRUCTURED_OUTPUT: 'true',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const prisma = {
      knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new HermesService(config, prisma);
    const contents = Array.isArray(content) ? content : [content];
    const post = jest.fn();
    for (const responseContent of contents) {
      post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: responseContent } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      });
    }
    (service as any).httpClient.post = post;
    return { service, post };
  }

  it('sends the current inbound message exactly once and requests JSON schema', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response: 'Cuéntame qué necesitas.',
        detectedIntent: 'info_general',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {},
      }),
    );

    await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Mensaje actual',
      conversationHistory: [{ role: 'user', content: 'Mensaje anterior' }],
    });

    const body = post.mock.calls[0][1];
    expect(
      body.messages.filter(
        (message: { content: string }) => message.content === 'Mensaje actual',
      ),
    ).toHaveLength(1);
    expect(body.response_format.type).toBe('json_schema');
  });

  it('does not ask again for a WhatsApp number already known by the backend', async () => {
    const { service } = setup(
      JSON.stringify({
        response: '¿Puedes confirmar tu número de teléfono?',
        detectedIntent: 'agendar_cita',
        suggestedTags: [],
        nextAction: 'solicitar_confirmacion_reunion',
        commercialProfile: {},
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Quiero que me llamen',
      conversationHistory: [],
      contact: { id: 'contact-1', hasUsablePhone: true, hasEmail: false },
    });

    expect(result.response).toContain('este mismo número de WhatsApp');
    expect(result.response).not.toMatch(/confirmar tu número/i);
  });

  it('uses a safe handoff response when the provider returns invalid JSON', async () => {
    const { service, post } = setup([
      'respuesta sin JSON',
      '{\n  "response": "Hola, Ana. ¡Claro que',
    ]);

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent: 'Necesito una web',
      conversationHistory: [],
    });

    expect(result.detectedIntent).toBe('error');
    expect(result.nextAction).toBe('derivar_humano');
    expect(result.response).not.toContain('respuesta sin JSON');
    expect(result.response).not.toContain('"response"');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries an incomplete structured response and returns only the complete message', async () => {
    const complete = JSON.stringify({
      response: 'Hola, Jonathan. Claro que podemos ayudarte.',
      detectedIntent: 'info_general',
      suggestedTags: [],
      nextAction: 'continuar_descubrimiento',
      commercialProfile: {},
    });
    const { service, post } = setup([
      '{\n  "response": "Hola, Jonathan. ¡Claro que',
      complete,
    ]);

    const result = await service.generateResponse({
      contactName: 'Jonathan',
      messageContent: 'Necesito información',
      conversationHistory: [],
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].max_tokens).toBe(2048);
    expect(post.mock.calls[1][1].max_tokens).toBe(4096);
    expect(result.response).toBe('Hola, Jonathan. Claro que podemos ayudarte.');
    expect(result.tokensUsed).toBe(240);
  });
});

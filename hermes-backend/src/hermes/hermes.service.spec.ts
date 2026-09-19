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

  it('includes the concise web discovery and pending handoff rules', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'Perfecto, con esto ya podemos valorar tu proyecto. ¿Quieres que coordinemos una conversación con nuestro equipo?',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'proponer_reunion',
        commercialProfile: {},
      }),
    );

    await service.generateResponse({
      messageContent: 'Servicio a domicilio y repuestos',
      conversationHistory: [
        { role: 'user', content: 'Necesito una página web' },
        { role: 'assistant', content: '¿A qué se dedica tu negocio?' },
        {
          role: 'user',
          content: 'Reparación de lavadoras. Quiero promocionarme.',
        },
      ],
    });

    const systemMessage = post.mock.calls[0][1].messages[0].content as string;
    expect(systemMessage).toContain('¿A qué se dedica tu negocio?');
    expect(systemMessage).toContain(
      'no abras otra ronda de descubrimiento sobre contacto o interacciones',
    );
    expect(systemMessage).toContain(
      'su petición ya autoriza iniciar la derivación',
    );
    expect(systemMessage).not.toContain(
      'Para una web, averigua primero su objetivo',
    );
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

  it('adds the store plans to context and keeps ecommerce discovery facts', async () => {
    const { service, post } = setup(
      JSON.stringify({
        response:
          'Para orientarte mejor, ¿cuántos productos estimas publicar inicialmente?',
        detectedIntent: 'consulta_servicio',
        suggestedTags: [],
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {
          service: 'Tienda Online',
          need: 'Vender productos por internet',
          productCount: '30 productos',
          corporateEmailNeeds: '3 cuentas',
        },
      }),
    );

    const result = await service.generateResponse({
      contactName: 'Ana',
      messageContent:
        'Quiero una tienda online para unos 30 productos y necesito 3 correos corporativos',
      conversationHistory: [],
    });

    const body = post.mock.calls[0][1];
    const systemMessage = body.messages[0].content as string;
    expect(systemMessage).toContain('Tienda de Lanzamiento — USD $550');
    expect(systemMessage).toContain('Tienda de Crecimiento — USD $850');
    expect(systemMessage).toContain('USD $40 al año');
    expect(result.commercialProfile).toEqual(
      expect.objectContaining({
        service: 'Tienda Online',
        productCount: '30 productos',
        corporateEmailNeeds: '3 cuentas',
      }),
    );
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

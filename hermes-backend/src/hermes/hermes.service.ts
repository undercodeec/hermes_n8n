import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { HermesRequestDto, HermesResponseDto } from './dto/hermes-request.dto';

@Injectable()
export class HermesService {
  private readonly logger = new Logger(HermesService.name);
  private readonly httpClient: AxiosInstance;
  private readonly model: string;

  // Prompt del sistema para el vendedor (Paso 10 de la guía)
  private readonly systemPrompt = `Eres un asesor comercial profesional por WhatsApp para nuestra empresa.

## Rol
Asesor comercial digital.

## Objetivo
Captar, calificar y avanzar leads hacia una cita, pago o traspaso a un humano.

## Tono
Claro, cordial, persuasivo y breve. Usa un español natural y profesional.

## Reglas
- NO inventes datos, precios ni condiciones que no estén en tu contexto.
- Usa SOLO el catálogo y políticas vigentes proporcionados.
- Si falta información, pregunta al cliente.
- Si la conversación involucra reclamos sensibles, pagos fallidos o negociación especial, indica que derivarás a un especialista.
- Mantén las respuestas cortas (máximo 3 párrafos).
- No uses emojis excesivos, máximo 1-2 por mensaje.
- Siempre sugiere un siguiente paso claro.

## Formato de salida
Responde SOLO con un JSON válido con esta estructura:
{
  "response": "Tu respuesta al cliente aquí",
  "detectedIntent": "intención detectada (ej: consulta_precio, agendar_cita, queja, info_producto)",
  "suggestedTags": ["tag1", "tag2"],
  "nextAction": "próximo paso sugerido para el CRM"
}`;

  constructor(private readonly configService: ConfigService) {
    const apiUrl = this.configService.get<string>('HERMES_API_URL', 'http://localhost:8080/v1');
    const apiKey = this.configService.get<string>('HERMES_API_KEY', '');
    this.model = this.configService.get<string>('HERMES_MODEL', 'hermes-default');

    this.httpClient = axios.create({
      baseURL: apiUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000, // 60s timeout para respuestas de IA
    });
  }

  /**
   * Genera una respuesta usando Hermes Agent
   * Construye el prompt con contexto completo del contacto y conversación
   */
  async generateResponse(request: HermesRequestDto): Promise<HermesResponseDto> {
    try {
      // Construir contexto adicional para el prompt
      const contextParts: string[] = [];

      if (request.contactName) {
        contextParts.push(`Cliente: ${request.contactName}`);
      }
      if (request.leadStage) {
        contextParts.push(`Etapa del lead: ${request.leadStage}`);
      }
      if (request.productOfInterest) {
        contextParts.push(`Producto de interés: ${request.productOfInterest}`);
      }
      if (request.conversationSummary) {
        contextParts.push(`Resumen de conversación anterior: ${request.conversationSummary}`);
      }

      const contextMessage = contextParts.length
        ? `\n\n## Contexto actual del cliente\n${contextParts.join('\n')}`
        : '';

      // Construir mensajes para la API OpenAI-compatible
      const messages = [
        {
          role: 'system',
          content: this.systemPrompt + contextMessage,
        },
        // Historial de conversación
        ...request.conversationHistory.map((msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        // Mensaje actual
        {
          role: 'user' as const,
          content: request.messageContent,
        },
      ];

      const startTime = Date.now();

      const response = await this.httpClient.post('/chat/completions', {
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 500,
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.data.choices?.[0];
      const usage = response.data.usage;

      if (!choice) {
        throw new Error('No se recibió respuesta de Hermes');
      }

      const rawContent = choice.message?.content || '';

      // Intentar parsear la respuesta como JSON estructurado
      const parsedResponse = this.parseHermesResponse(rawContent);

      // Calcular costo estimado (basado en pricing típico)
      const tokensUsed = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
      const costEstimate = tokensUsed * 0.000002; // ~$2/1M tokens estimado

      this.logger.log(
        `Hermes respondió en ${latencyMs}ms, tokens: ${tokensUsed}`,
      );

      return {
        response: parsedResponse.response,
        tokensUsed,
        costEstimate,
        suggestedTags: parsedResponse.suggestedTags,
        detectedIntent: parsedResponse.detectedIntent,
        nextAction: parsedResponse.nextAction,
      };
    } catch (error: any) {
      this.logger.error(
        `Error llamando a Hermes: ${error.response?.data?.error?.message || error.message}`,
      );

      // Respuesta de fallback
      return {
        response: 'Disculpa, en este momento no puedo procesar tu solicitud. Un asesor te contactará pronto.',
        tokensUsed: 0,
        costEstimate: 0,
        detectedIntent: 'error',
        nextAction: 'revisar_error_hermes',
      };
    }
  }

  /**
   * Parsea la respuesta de Hermes, que puede ser JSON estructurado o texto plano
   */
  private parseHermesResponse(content: string): {
    response: string;
    suggestedTags?: string[];
    detectedIntent?: string;
    nextAction?: string;
  } {
    try {
      // Intentar extraer JSON del contenido
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          response: parsed.response || content,
          suggestedTags: parsed.suggestedTags || parsed.suggested_tags,
          detectedIntent: parsed.detectedIntent || parsed.detected_intent,
          nextAction: parsed.nextAction || parsed.next_action,
        };
      }
    } catch {
      // Si no es JSON válido, usar como texto plano
    }

    return { response: content };
  }
}

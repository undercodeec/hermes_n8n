import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { HermesService } from '../hermes/hermes.service';
import { HandoffService } from '../handoff/handoff.service';
import { MetaWebhookDto, MetaWebhookMessage, MetaWebhookContact } from './dto/meta-webhook.dto';
import { MessageDirection, MessageType, ConversationStatus, HandoffReason } from '@prisma/client';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
    private readonly hermesService: HermesService,
    private readonly handoffService: HandoffService,
  ) {}

  /**
   * Verifica el webhook de Meta (GET request)
   * Meta envía un challenge que debemos devolver
   */
  verifyWebhook(mode: string, token: string, challenge: string): string {
    const verifyToken = this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verificado exitosamente');
      return challenge;
    }

    this.logger.warn('Verificación de webhook fallida');
    throw new UnauthorizedException('Token de verificación inválido');
  }

  /**
   * Valida la firma SHA256 del webhook de Meta
   */
  validateSignature(payload: string, signature: string): boolean {
    const appSecret = this.configService.get<string>('META_APP_SECRET');
    if (!appSecret) {
      this.logger.warn('META_APP_SECRET no configurado, omitiendo validación de firma');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex');

    const receivedSignature = signature?.replace('sha256=', '') || '';
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex'),
    );
  }

  /**
   * Procesa el webhook completo de Meta - Flujo de 10 pasos
   */
  async processWebhook(dto: MetaWebhookDto): Promise<void> {
    if (dto.object !== 'whatsapp_business_account') {
      this.logger.warn(`Objeto no soportado: ${dto.object}`);
      return;
    }

    for (const entry of dto.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const { messages, contacts, statuses } = change.value;

        // Procesar estados de mensajes (delivered, read, etc.)
        if (statuses?.length) {
          await this.processStatuses(statuses);
        }

        // Procesar mensajes entrantes
        if (messages?.length && contacts?.length) {
          for (const message of messages) {
            const contact = contacts.find((c) => c.wa_id === message.from);
            if (contact) {
              await this.processIncomingMessage(message, contact);
            }
          }
        }
      }
    }
  }

  /**
   * Procesa un mensaje entrante siguiendo el flujo de 10 pasos de la guía
   */
  private async processIncomingMessage(
    message: MetaWebhookMessage,
    metaContact: MetaWebhookContact,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Paso 4: Identificar o crear contacto
      const contact = await this.upsertContact(metaContact);

      // Paso 5: Obtener o crear conversación activa
      const conversation = await this.getOrCreateConversation(contact.id);

      // Paso 3: Guardar mensaje crudo con metadata
      const messageType = this.mapMessageType(message.type);
      const messageContent = this.extractMessageContent(message);

      const savedMessage = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          contactId: contact.id,
          direction: MessageDirection.INBOUND,
          type: messageType,
          content: messageContent,
          rawPayload: message as any,
          wamid: message.id,
        },
      });

      this.logger.log(
        `Mensaje recibido de ${contact.waId}: ${messageContent?.substring(0, 50)}...`,
      );

      // Verificar si la conversación está en handoff (derivada a humano)
      if (conversation.status === ConversationStatus.HANDED_OFF) {
        this.logger.log(`Conversación ${conversation.id} en handoff, no se genera respuesta automática`);
        return;
      }

      // Paso 5: Obtener contexto completo
      const context = await this.buildConversationContext(contact.id, conversation.id);

      // Paso 6: Llamar a Hermes con prompt + contexto
      const hermesResponse = await this.hermesService.generateResponse({
        contactName: contact.name || 'Cliente',
        messageContent: messageContent || '',
        conversationHistory: context.recentMessages,
        leadStage: context.leadStage,
        productOfInterest: context.productOfInterest,
        conversationSummary: context.conversationSummary,
      });

      const latencyMs = Date.now() - startTime;

      // Paso 8: Aplicar reglas post-procesamiento
      const shouldHandoff = this.checkHandoffSignals(hermesResponse.response, messageContent || '');

      if (shouldHandoff) {
        await this.createAutoHandoff(conversation.id, messageContent || '');
        // Aún así enviar respuesta de transición
      }

      // Paso 9: Enviar respuesta por API de Meta
      const sentMessage = await this.metaService.sendTextMessage(
        contact.waId,
        hermesResponse.response,
      );

      // Paso 10: Registrar resultado
      await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          contactId: contact.id,
          direction: MessageDirection.OUTBOUND,
          type: MessageType.TEXT,
          content: hermesResponse.response,
          wamid: sentMessage?.messages?.[0]?.id,
          tokensUsed: hermesResponse.tokensUsed,
          latencyMs,
          costEstimate: hermesResponse.costEstimate,
        },
      });

      // Actualizar estado conversacional
      if (hermesResponse.suggestedTags || hermesResponse.detectedIntent) {
        await this.updateConversationState(conversation.id, hermesResponse);
      }

      this.logger.log(
        `Respuesta enviada a ${contact.waId} en ${latencyMs}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Error procesando mensaje de ${metaContact.wa_id}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Crea o actualiza un contacto desde los datos de Meta
   */
  private async upsertContact(metaContact: MetaWebhookContact) {
    return this.prisma.contact.upsert({
      where: { waId: metaContact.wa_id },
      update: {
        name: metaContact.profile.name || undefined,
      },
      create: {
        waId: metaContact.wa_id,
        phone: metaContact.wa_id,
        name: metaContact.profile.name,
      },
    });
  }

  /**
   * Obtiene la conversación activa del contacto o crea una nueva
   */
  private async getOrCreateConversation(contactId: string) {
    const activeConversation = await this.prisma.conversation.findFirst({
      where: {
        contactId,
        status: { in: [ConversationStatus.ACTIVE, ConversationStatus.HANDED_OFF] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeConversation) {
      return activeConversation;
    }

    return this.prisma.conversation.create({
      data: {
        contactId,
        status: ConversationStatus.ACTIVE,
        channel: 'whatsapp',
      },
    });
  }

  /**
   * Construye el contexto completo para Hermes
   */
  private async buildConversationContext(contactId: string, conversationId: string) {
    // Últimos mensajes de la conversación
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { direction: true, content: true, createdAt: true },
    });

    // Estado conversacional
    const state = await this.prisma.conversationState.findUnique({
      where: { conversationId },
    });

    // Lead activo del contacto
    const lead = await this.prisma.lead.findFirst({
      where: { contactId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      recentMessages: recentMessages.reverse().map((m) => ({
        role: m.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
        content: m.content || '',
      })),
      conversationSummary: state?.summary || undefined,
      leadStage: lead?.stage || state?.leadStage || undefined,
      productOfInterest: lead?.productOfInterest || undefined,
    };
  }

  /**
   * Verifica señales de handoff automático
   */
  private checkHandoffSignals(aiResponse: string, userMessage: string): boolean {
    const handoffKeywords = [
      'hablar con humano', 'hablar con persona', 'agente real',
      'quiero quejarme', 'reclamo', 'estoy molesto', 'no funciona',
      'descuento especial', 'cotización compleja', 'precio corporativo',
    ];

    const lowerMessage = userMessage.toLowerCase();
    return handoffKeywords.some((keyword) => lowerMessage.includes(keyword));
  }

  /**
   * Crea un handoff automático.
   *
   * Delega en `HandoffService.create` (no escribe a Prisma directo): el service
   * pausa la conversación, crea el registro y emite `conversation.handoff_requested`
   * en un único punto, cubriendo tanto el handoff automático como el manual.
   */
  private async createAutoHandoff(conversationId: string, triggerMessage: string) {
    await this.handoffService.create({
      conversationId,
      reason: HandoffReason.CUSTOM,
      reasonDetail: `Handoff automático. Mensaje trigger: ${triggerMessage.substring(0, 200)}`,
    });

    this.logger.log(`Handoff automático creado para conversación ${conversationId}`);
  }

  /**
   * Actualiza el estado conversacional con datos de la respuesta de Hermes
   */
  private async updateConversationState(
    conversationId: string,
    hermesResponse: {
      suggestedTags?: string[];
      detectedIntent?: string;
      nextAction?: string;
    },
  ) {
    await this.prisma.conversationState.upsert({
      where: { conversationId },
      update: {
        detectedIntent: hermesResponse.detectedIntent,
        nextSuggestedAction: hermesResponse.nextAction,
        commercialTags: hermesResponse.suggestedTags || [],
      },
      create: {
        conversationId,
        detectedIntent: hermesResponse.detectedIntent,
        nextSuggestedAction: hermesResponse.nextAction,
        commercialTags: hermesResponse.suggestedTags || [],
      },
    });
  }

  /**
   * Procesa estados de mensajes (delivered, read, failed)
   */
  private async processStatuses(statuses: any[]) {
    for (const status of statuses) {
      this.logger.debug(
        `Status: ${status.status} para mensaje ${status.id}`,
      );
      // Se puede extender para actualizar estado de entrega en BD
    }
  }

  /**
   * Mapea el tipo de mensaje de Meta al enum de Prisma
   */
  private mapMessageType(type: string): MessageType {
    const typeMap: Record<string, MessageType> = {
      text: MessageType.TEXT,
      image: MessageType.IMAGE,
      document: MessageType.DOCUMENT,
      audio: MessageType.AUDIO,
      video: MessageType.VIDEO,
      sticker: MessageType.STICKER,
      location: MessageType.LOCATION,
      interactive: MessageType.INTERACTIVE,
      reaction: MessageType.REACTION,
    };
    return typeMap[type] || MessageType.UNKNOWN;
  }

  /**
   * Extrae el contenido de texto del mensaje según su tipo
   */
  private extractMessageContent(message: MetaWebhookMessage): string | null {
    switch (message.type) {
      case 'text':
        return message.text?.body || null;
      case 'image':
        return message.image?.caption || '[Imagen]';
      case 'document':
        return message.document?.caption || `[Documento: ${message.document?.filename || 'sin nombre'}]`;
      case 'audio':
        return '[Audio]';
      case 'video':
        return message.video ? '[Video]' : null;
      case 'location':
        return `[Ubicación: ${message.location?.name || `${message.location?.latitude}, ${message.location?.longitude}`}]`;
      case 'interactive':
        return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactivo]';
      case 'reaction':
        return message.reaction?.emoji || '[Reacción]';
      case 'sticker':
        return '[Sticker]';
      default:
        return null;
    }
  }
}

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { HermesService } from '../hermes/hermes.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { AdvertisingService } from '../advertising/advertising.service';
import { normalizeWhatsAppId } from '../campaigns/phone-normalizer';
import { ConversationEventsService } from '../conversations/conversation-events.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { PaymentsService } from '../payments/payments.service';
import { redactPaymentMessageForAi } from '../payments/payment-message-redaction';
import {
  classifyPilotOrigin,
  isTextualCommercialOptOut,
  type MetaReferral,
} from './undercode-pilot';
import { requestsCommercialContact } from '../hermes/commercial-policy.service';
import {
  isRecord,
  validateInboxMessage,
  validateInboxStatus,
} from './webhook-inbox-validation';
import {
  MetaWebhookDto,
  MetaWebhookMessage,
  MetaWebhookContact,
} from './dto/meta-webhook.dto';
import {
  ConversationStatus,
  HandoffReason,
  HandoffStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  MetaWebhookInboxStatus,
  Prisma,
} from '@prisma/client';

const RETRYABLE_INBOX_OUTCOMES = [
  'RETRYABLE_PROCESSING_ERROR',
  'RETRYABLE_ATTRIBUTION_ERROR',
  // Preserve recovery of rows written by the deployed version.
  'processing_error',
  'attribution_retry',
];

class PermanentInvalidPayloadError extends Error {
  constructor(readonly reason: string) {
    super(`PERMANENT_INVALID_PAYLOAD:${reason}`);
  }
}

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookService.name);
  private recoveryTimer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
    private readonly hermesService: HermesService,
    private readonly handoffService: HandoffService,
    private readonly leadsService: LeadsService,
    private readonly campaignsService: CampaignsService,
    private readonly autoReplies: AutoReplyService,
    private readonly conversationGuard: ConversationGuardService,
    private readonly advertisingService: AdvertisingService,
    private readonly conversationEvents: ConversationEventsService,
    private readonly deliveries: AutomatedDeliveryService,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.recoveryTimer = setInterval(() => void this.scan(), 5000);
    this.recoveryTimer.unref();
    void this.scan();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  /** A signed callback is acknowledged only after every actionable event is durable. */
  async acceptWebhook(dto: MetaWebhookDto): Promise<void> {
    if (!isRecord(dto) || dto.object !== 'whatsapp_business_account') return;
    const events: Prisma.MetaWebhookInboxCreateManyInput[] = [];
    const malformed = (scope: string) => {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ scope, webhook: dto }))
        .digest('hex');
      events.push({
        eventKey: `invalid-envelope:${hash}`,
        eventType: 'INVALID_ENVELOPE',
        payload: { scope, webhook: dto } as unknown as Prisma.InputJsonValue,
      });
    };
    if (!Array.isArray(dto.entry)) {
      malformed('entry');
    } else
      for (const [entryIndex, entry] of dto.entry.entries()) {
        if (!isRecord(entry) || !Array.isArray(entry.changes)) {
          malformed(`entry:${entryIndex}`);
          continue;
        }
        for (const [changeIndex, change] of entry.changes.entries()) {
          if (!isRecord(change)) {
            malformed(`entry:${entryIndex}:change:${changeIndex}`);
            continue;
          }
          if (change.field !== 'messages') continue;
          if (!isRecord(change.value)) {
            malformed(`entry:${entryIndex}:change:${changeIndex}:value`);
            continue;
          }
          const value = change.value;
          const phoneNumberId = isRecord(value.metadata)
            ? value.metadata.phone_number_id
            : undefined;
          const configuredPhone = this.configuredPhoneNumberId();
          if (
            typeof phoneNumberId === 'string' &&
            phoneNumberId.trim() &&
            phoneNumberId !== configuredPhone
          )
            continue;
          const { messages, contacts, statuses } = value;
          if (messages !== undefined && !Array.isArray(messages))
            malformed(`entry:${entryIndex}:change:${changeIndex}:messages`);
          if (statuses !== undefined && !Array.isArray(statuses))
            malformed(`entry:${entryIndex}:change:${changeIndex}:statuses`);
          for (const [messageIndex, message] of (Array.isArray(messages)
            ? messages
            : []
          ).entries()) {
            const candidates = Array.isArray(contacts) ? contacts : [];
            const sender = isRecord(message) ? message.from : undefined;
            const matched = candidates.find(
              (candidate) =>
                isRecord(candidate) &&
                typeof sender === 'string' &&
                candidate.wa_id === sender,
            );
            // Meta may omit contacts. Only its validated sender may supply a
            // minimal contact; a supplied but incompatible contact is evidence.
            const contact =
              matched ??
              (candidates.length === 0 &&
              (contacts === undefined || Array.isArray(contacts)) &&
              normalizeWhatsAppId(sender)
                ? { wa_id: sender, profile: { name: '' } }
                : candidates.length === 1
                  ? candidates[0]
                  : null);
            const id = isRecord(message) ? message.id : undefined;
            const eventKey =
              typeof id === 'string' && id.trim()
                ? `message:${id}`
                : `message:sha256:${crypto
                    .createHash('sha256')
                    .update(
                      JSON.stringify({
                        entryIndex,
                        changeIndex,
                        messageIndex,
                        phoneNumberId,
                        message,
                      }),
                    )
                    .digest('hex')}`;
            events.push({
              eventKey,
              eventType: 'MESSAGE',
              payload: {
                message,
                contact,
                phoneNumberId,
              } as unknown as Prisma.InputJsonValue,
            });
          }
          for (const status of Array.isArray(statuses) ? statuses : []) {
            const rawStatus = status ?? null;
            const hash = crypto
              .createHash('sha256')
              .update(JSON.stringify(rawStatus))
              .digest('hex');
            events.push({
              eventKey: `status:${hash}`,
              eventType: 'STATUS',
              payload: {
                status: rawStatus,
                phoneNumberId,
              } as unknown as Prisma.InputJsonValue,
            });
          }
        }
      }
    if (events.length) {
      await this.prisma.metaWebhookInbox.createMany({
        data: events,
        skipDuplicates: true,
      });
    }
  }

  /** Reclaims abandoned leases after restart; the conditional update serializes workers. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = new Date();
      const pending = await this.prisma.metaWebhookInbox.findMany({
        where: {
          OR: [
            { status: MetaWebhookInboxStatus.PENDING },
            {
              status: MetaWebhookInboxStatus.FAILED,
              outcome: { in: RETRYABLE_INBOX_OUTCOMES },
              leaseUntil: { lte: now },
            },
            {
              status: MetaWebhookInboxStatus.PROCESSING,
              leaseUntil: { lte: now },
            },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const event of pending) {
        const claimToken = randomUUID();
        const claimed = await this.prisma.metaWebhookInbox.updateMany({
          where: {
            id: event.id,
            status: event.status,
            ...(event.status === MetaWebhookInboxStatus.FAILED
              ? { outcome: { in: RETRYABLE_INBOX_OUTCOMES } }
              : {}),
            ...(event.status === MetaWebhookInboxStatus.PENDING
              ? {}
              : { leaseUntil: { lte: now } }),
          },
          data: {
            status: MetaWebhookInboxStatus.PROCESSING,
            claimToken,
            leaseUntil: new Date(Date.now() + 5 * 60_000),
            attempts: { increment: 1 },
          },
        });
        if (!claimed.count) continue;
        try {
          let outcome = 'processed';
          if (event.eventType === 'MESSAGE') {
            const checked = validateInboxMessage(event.payload);
            if (!checked.value)
              throw new PermanentInvalidPayloadError(checked.reason);
            if (!this.isAuthorizedPhone(checked.value.phoneNumberId))
              throw new PermanentInvalidPayloadError('UNAUTHORIZED_PHONE');
            outcome = await this.processIncomingMessage(
              checked.value.message,
              checked.value.contact,
              event.outcome === 'processing_error' ||
                event.outcome === 'RETRYABLE_PROCESSING_ERROR' ||
                event.status === MetaWebhookInboxStatus.PROCESSING,
            );
          } else if (event.eventType === 'STATUS') {
            const checked = validateInboxStatus(event.payload);
            if (!checked.value)
              throw new PermanentInvalidPayloadError(checked.reason);
            if (!this.isAuthorizedPhone(checked.value.phoneNumberId))
              throw new PermanentInvalidPayloadError('UNAUTHORIZED_PHONE');
            await this.processStatuses([checked.value.status]);
          } else {
            throw new PermanentInvalidPayloadError('EVENT_TYPE_INVALID');
          }
          await this.prisma.metaWebhookInbox.updateMany({
            where: { id: event.id, claimToken },
            data:
              outcome === 'retry'
                ? {
                    status: MetaWebhookInboxStatus.FAILED,
                    outcome: 'RETRYABLE_ATTRIBUTION_ERROR',
                    claimToken: null,
                    leaseUntil: new Date(Date.now() + 5000),
                  }
                : {
                    status: MetaWebhookInboxStatus.COMPLETED,
                    outcome,
                    claimToken: null,
                    leaseUntil: null,
                  },
          });
        } catch (error) {
          const permanent = error instanceof PermanentInvalidPayloadError;
          if (permanent)
            this.logger.error(
              `Webhook inbox quarantined: ${event.id} ${error.reason}`,
            );
          else
            this.logger.warn(
              `Webhook inbox processing failed: ${event.id} ${error instanceof Error ? error.name : typeof error}`,
            );
          await this.prisma.metaWebhookInbox.updateMany({
            where: { id: event.id, claimToken },
            data: {
              status: MetaWebhookInboxStatus.FAILED,
              outcome: permanent
                ? `PERMANENT_INVALID_PAYLOAD:${error.reason}`
                : 'RETRYABLE_PROCESSING_ERROR',
              claimToken: null,
              leaseUntil: permanent
                ? null
                : new Date(
                    Date.now() +
                      Math.min(60_000, 5000 * Math.max(1, event.attempts + 1)),
                  ),
            },
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Webhook inbox recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Verifica el webhook de Meta (GET request)
   * Meta envía un challenge que debemos devolver
   */
  verifyWebhook(mode: string, token: string, challenge: string): string {
    const verifyToken = this.configService.get<string>(
      'META_WEBHOOK_VERIFY_TOKEN',
    );

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      this.logger.log('Webhook verificado exitosamente');
      return challenge;
    }

    this.logger.warn('Verificación de webhook fallida');
    throw new UnauthorizedException('Token de verificación inválido');
  }

  /**
   * Valida la firma SHA256 del webhook de Meta
   */
  validateSignature(payload: Buffer, signature?: string): boolean {
    const appSecret = this.configService.get<string>('META_APP_SECRET');
    if (!appSecret) {
      this.logger.warn('META_APP_SECRET no configurado; webhook rechazado');
      return false;
    }

    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex');

    if (!signature?.startsWith('sha256=')) return false;
    const receivedSignature = signature.slice(7);
    if (!/^[a-f0-9]{64}$/i.test(receivedSignature)) return false;
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

    const values = dto.entry.flatMap((entry) =>
      entry.changes.map((change) => change.value),
    );
    const messageIds = values
      .flatMap((value) => value.messages || [])
      .map((message) => message.id);
    this.logger.log(
      JSON.stringify({
        event: 'meta_webhook_received',
        entries: dto.entry.length,
        messages: messageIds.length,
        statuses: values.reduce(
          (count, value) => count + (value.statuses?.length || 0),
          0,
        ),
        messageIds,
      }),
    );

    for (const entry of dto.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        if (!this.isAuthorizedPhone(change.value.metadata?.phone_number_id))
          continue;

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
    resumeCommercial = false,
  ): Promise<string> {
    const checked = validateInboxMessage({
      message,
      contact: metaContact,
      phoneNumberId: 'direct-processing',
    });
    if (!checked.value) throw new PermanentInvalidPayloadError(checked.reason);
    message = checked.value.message;
    metaContact = checked.value.contact;
    try {
      const alreadyProcessed = await this.prisma.message.findUnique({
        where: { wamid: message.id },
        select: {
          id: true,
          contactId: true,
          conversationId: true,
          content: true,
        },
      });
      if (alreadyProcessed) {
        let attributionStatus = 'retry';
        try {
          const result = await this.advertisingService.claimReference({
            messageContent: alreadyProcessed.content,
            contactId: alreadyProcessed.contactId,
            conversationId: alreadyProcessed.conversationId,
            inboundMessageId: alreadyProcessed.id,
          });
          attributionStatus = result.status;
        } catch (error) {
          this.logger.warn(
            `Attribution retry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (message.type === 'image' || message.type === 'document') {
          const handled = await this.payments.detectProof(alreadyProcessed.id);
          if (handled)
            return attributionStatus === 'retry' ? 'retry' : 'payment_proof';
        }
        if (!resumeCommercial) return attributionStatus;
        const contact = await this.prisma.contact.findUniqueOrThrow({
          where: { id: alreadyProcessed.contactId },
        });
        const conversation = await this.prisma.conversation.findUniqueOrThrow({
          where: { id: alreadyProcessed.conversationId },
        });
        const campaignRecipient =
          await this.campaignsService.findHumanManagedRecipient(contact.id);
        return this.routeInbound(
          message,
          contact,
          conversation,
          campaignRecipient,
          alreadyProcessed,
          alreadyProcessed.content,
          attributionStatus,
        );
      }

      // Paso 4: Identificar o crear contacto
      const contact = await this.upsertContact(metaContact);

      // Campaign attribution is deliberately separate from lead creation. The
      // established inbound flow below remains the sole place that creates a lead.
      await this.campaignsService.markReplied(contact.id);
      const campaignRecipient =
        await this.campaignsService.findHumanManagedRecipient(contact.id);

      // Paso 5: Obtener o crear conversación activa
      const conversation = await this.getOrCreateConversation(
        contact.id,
        message.referral,
      );

      await this.leadsService.findOrCreateForConversation({
        contactId: contact.id,
        conversationId: conversation.id,
      });

      // Paso 3: Guardar mensaje crudo con metadata
      const messageType = this.mapMessageType(message.type);
      const messageContent = this.extractMessageContent(message);
      const adReferral = classifyPilotOrigin(message.referral);
      const messageMetadata = {
        ...(messageType === MessageType.AUDIO
          ? {
              sourceType: 'AUDIO',
              mediaId: message.audio?.id,
              mimeType: message.audio?.mime_type,
            }
          : {}),
        ...(adReferral.origin === 'meta_ad'
          ? {
              pilotOrigin: 'meta_ad',
              pilotOriginEvidence: adReferral.evidence,
              pilotAd: {
                ...(adReferral.adSourceId
                  ? { sourceId: adReferral.adSourceId }
                  : {}),
                ...(adReferral.ctwaClidPresent
                  ? { ctwaClidPresent: true }
                  : {}),
              },
            }
          : {}),
      };

      const inboundMessage = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          contactId: contact.id,
          direction: MessageDirection.INBOUND,
          sender: MessageSender.CONTACT,
          type: messageType,
          content: messageContent,
          rawPayload: message as unknown as Prisma.InputJsonValue,
          ...(Object.keys(messageMetadata).length
            ? { metadata: messageMetadata }
            : {}),
          wamid: message.id,
        },
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      await this.conversationEvents.publishCustomerMessage({
        messageId: inboundMessage.id,
        conversationId: conversation.id,
        contactId: contact.id,
        contactName: contact.name || contact.waId || 'Cliente',
        content: messageContent || `[${messageType}]`,
        messageType,
        createdAt: (inboundMessage.createdAt || new Date()).toISOString(),
      });

      // Best-effort: an attribution outage must not interrupt the existing
      // WhatsApp, AI or human-handoff flow.
      let attributionStatus = 'retry';
      try {
        const claim = await this.advertisingService.claimReference({
          messageContent,
          contactId: contact.id,
          conversationId: conversation.id,
          inboundMessageId: inboundMessage.id,
        });
        attributionStatus = claim.status;
      } catch (attributionError) {
        this.logger.warn(
          `Attribution failed for message ${message.id}: ${
            attributionError instanceof Error
              ? attributionError.message
              : 'unknown error'
          }`,
        );
      }
      if (
        messageType === MessageType.IMAGE ||
        messageType === MessageType.DOCUMENT
      ) {
        const handled = await this.payments.detectProof(inboundMessage.id);
        if (handled)
          return attributionStatus === 'retry' ? 'retry' : 'payment_proof';
      }

      return this.routeInbound(
        message,
        contact,
        conversation,
        campaignRecipient,
        inboundMessage,
        messageContent,
        attributionStatus,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error procesando mensaje ${message.id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  private async routeInbound(
    message: MetaWebhookMessage,
    contact: { id: string; waId: string },
    conversation: { id: string; status: ConversationStatus },
    campaignRecipient: { campaignId: string } | null,
    inboundMessage: { id: string },
    messageContent: string | null,
    attributionStatus: string,
  ): Promise<string> {
    if (this.isCampaignOptOut(message)) {
      await this.campaignsService.optOut(contact.id);
      this.logger.log(`Contacto marcó baja de campañas`);
      return attributionStatus;
    }
    if (
      message.type === 'text' &&
      isTextualCommercialOptOut(messageContent || '')
    ) {
      await this.campaignsService.optOut(contact.id, 'whatsapp_text');
      this.logger.log('Contacto solicitó baja comercial por texto');
    }

    // Campaign replies are never handled by Hermes. They remain visible in
    // Inbox, but an explicit handoff gives the CRM operator sole control.
    if (campaignRecipient) {
      await this.handoffService.create({
        conversationId: conversation.id,
        reason: HandoffReason.CUSTOM,
        reasonDetail: `Respuesta a campaña ${campaignRecipient.campaignId}; requiere atención humana desde CRM.`,
      });
      this.logger.log(
        `Respuesta a campaña ${campaignRecipient.campaignId}; conversación ${conversation.id} derivada a humano sin respuesta de Hermes`,
      );
      return attributionStatus;
    }

    this.logger.log(
      `Mensaje recibido en conversación ${conversation.id}: ${redactPaymentMessageForAi(messageContent || '').substring(0, 50)}...`,
    );

    // Verificar si la conversación está en handoff (derivada a humano)
    if (conversation.status === ConversationStatus.HANDED_OFF) {
      this.logger.log(
        `Conversación ${conversation.id} en handoff, no se genera respuesta automática`,
      );
      return attributionStatus;
    }

    const recentInbound = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { content: true },
    });
    const supportContext = recentInbound
      .reverse()
      .map((item) => item.content || '')
      .join(' ');
    const guardDecision = await this.conversationGuard.inspect(
      contact.id,
      messageContent || '',
      supportContext,
      requestsCommercialContact(messageContent || ''),
    );
    if (guardDecision.action === 'SUPPORT') {
      await this.handoffService.create({
        conversationId: conversation.id,
        reason: HandoffReason.SUPPORT,
        reasonDetail:
          'Solicitud de soporte: problema técnico reportado en un proyecto que el cliente atribuye explícitamente a la marca.',
      });
      await this.sendSystemMessage(
        conversation.id,
        contact.id,
        inboundMessage.id,
        guardDecision.notice,
        'SUPPORT_ROUTING',
        true,
      );
      return attributionStatus;
    }
    if (guardDecision.action === 'BLOCK') {
      if (guardDecision.notice) {
        await this.sendSystemMessage(
          conversation.id,
          contact.id,
          inboundMessage.id,
          guardDecision.notice,
          `GUARD_${guardDecision.category}`,
          false,
        );
      }
      this.logger.warn(
        `Mensaje bloqueado antes de Gemini (${guardDecision.category}) para contacto ${contact.id}`,
      );
      return attributionStatus;
    }

    // La generación y el contexto completo se resuelven en el worker para
    // que Meta reciba el webhook sin esperar al motor conversacional.
    await this.autoReplies.enqueue(
      {
        conversationId: conversation.id,
        contactId: contact.id,
        inboundMessageId: inboundMessage.id,
      },
      (messageContent || '').length,
    );
    return attributionStatus;
  }

  private async sendSystemMessage(
    conversationId: string,
    contactId: string,
    sourceMessageId: string,
    content: string,
    action: string,
    allowHandedOff: boolean,
  ): Promise<void> {
    await this.deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId,
      contactId,
      sourceMessageId,
      sender: 'SYSTEM',
      allowHandedOff,
      parts: [{ partIndex: 0, content, metadata: { action } }],
    });
    await this.deliveries.deliverPreparedBatch(sourceMessageId);
  }

  /**
   * Crea o actualiza un contacto desde los datos de Meta
   */
  private async upsertContact(metaContact: MetaWebhookContact) {
    const waId = normalizeWhatsAppId(metaContact.wa_id);
    if (!waId) throw new PermanentInvalidPayloadError('CONTACT_WA_ID_INVALID');
    return this.prisma.contact.upsert({
      where: { waId },
      update: {
        name: metaContact.profile.name || undefined,
      },
      create: {
        waId,
        phone: waId,
        name: metaContact.profile.name,
      },
    });
  }

  /**
   * Obtiene la conversación activa del contacto o crea una nueva
   */
  private async getOrCreateConversation(
    contactId: string,
    referral?: MetaReferral,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${contactId}))`;

      const latestConversation = await tx.conversation.findFirst({
        where: { contactId },
        orderBy: { updatedAt: 'desc' },
      });

      if (
        latestConversation &&
        (latestConversation.status === ConversationStatus.ACTIVE ||
          latestConversation.status === ConversationStatus.HANDED_OFF)
      ) {
        return latestConversation;
      }

      if (latestConversation?.status === ConversationStatus.CLOSED) {
        const openHandoff = await tx.humanHandoff.findFirst({
          where: {
            conversationId: latestConversation.id,
            status: {
              in: [
                HandoffStatus.PENDING,
                HandoffStatus.ASSIGNED,
                HandoffStatus.IN_PROGRESS,
              ],
            },
          },
          select: { id: true },
        });
        const resumedStatus = openHandoff
          ? ConversationStatus.HANDED_OFF
          : ConversationStatus.ACTIVE;
        const resumed = await tx.conversation.update({
          where: { id: latestConversation.id },
          data: { status: resumedStatus, closedAt: null },
        });
        await tx.auditLog.create({
          data: {
            action: 'CONVERSATION_REOPENED',
            entity: 'conversations',
            entityId: latestConversation.id,
            changes: {
              source: 'INBOUND_MESSAGE',
              before: {
                status: latestConversation.status,
                closedAt: latestConversation.closedAt,
              },
              after: { status: resumedStatus, closedAt: null },
              ...(openHandoff
                ? { preservedOpenHandoffId: openHandoff.id }
                : {}),
            },
          },
        });
        return resumed;
      }

      const origin = classifyPilotOrigin(referral);
      return tx.conversation.create({
        data: {
          contactId,
          status: ConversationStatus.ACTIVE,
          channel: 'whatsapp',
          metadata: {
            pilotOrigin: origin.origin,
            pilotOriginEvidence: origin.evidence,
            ...(origin.adSourceId || origin.ctwaClidPresent
              ? {
                  pilotAd: {
                    ...(origin.adSourceId
                      ? { sourceId: origin.adSourceId }
                      : {}),
                    ...(origin.ctwaClidPresent
                      ? { ctwaClidPresent: true }
                      : {}),
                  },
                }
              : {}),
            ...(this.configService.get<string>(
              'HERMES_PILOT_NEW_CONVERSATION_ENGINE',
              '',
            )
              ? {
                  pilotEngine: this.pilotNewConversationEngine(),
                  pilotRoutingVersion: 1,
                }
              : {}),
          },
        },
      });
    });
  }

  private pilotNewConversationEngine(): 'nous_hermes' | 'gemini_direct' {
    const engine = this.configService.get<string>(
      'HERMES_PILOT_NEW_CONVERSATION_ENGINE',
      '',
    );
    if (engine === 'gemini_direct') return engine;
    if (engine === 'nous_hermes')
      return this.configService.get<string>(
        'NOUS_PILOT_COMMERCIAL_ENABLED',
        'false',
      ) === 'true'
        ? 'nous_hermes'
        : 'gemini_direct';
    throw new Error('Invalid HERMES_PILOT_NEW_CONVERSATION_ENGINE');
  }

  private isAuthorizedPhone(inboundId?: string): boolean {
    const configured = this.configuredPhoneNumberId();
    if (inboundId === configured) return true;
    this.logger.warn('Webhook ignored for a different phone_number_id');
    return false;
  }

  private configuredPhoneNumberId(): string {
    const configured = this.configService
      .get<string>('META_PHONE_NUMBER_ID', '')
      ?.trim();
    if (!configured) {
      throw new Error(
        'META_PHONE_NUMBER_ID is required for the WhatsApp pilot',
      );
    }
    return configured;
  }

  /**
   * Construye el contexto completo para Hermes
   */
  private async buildConversationContext(
    contactId: string,
    conversationId: string,
  ) {
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
  private checkHandoffSignals(
    userMessage: string,
    detectedIntent?: string,
  ): boolean {
    const handoffKeywords = [
      'hablar con humano',
      'hablar con persona',
      'agente real',
      'quiero quejarme',
      'reclamo',
      'estoy molesto',
      'no funciona',
      'descuento especial',
      'cotización compleja',
      'precio corporativo',
    ];

    const keywords = this.csvConfig('HANDOFF_KEYWORDS', handoffKeywords);
    const intents = this.csvConfig('HANDOFF_INTENTS', [
      'solicitud_humano',
      'queja',
      'reclamo',
      'pago_fallido',
      'negociacion_especial',
    ]);
    const lowerMessage = userMessage.toLocaleLowerCase('es');
    const normalizedIntent = detectedIntent?.trim().toLocaleLowerCase('es');
    if (normalizedIntent === 'error') return false;
    return (
      keywords.some((keyword) => lowerMessage.includes(keyword)) ||
      (normalizedIntent ? intents.includes(normalizedIntent) : false)
    );
  }

  /**
   * Decide si un lead debe calificarse automáticamente según el `detectedIntent`
   * devuelto por Hermes. La lista de intents de alta intención es configurable
   * vía `LEAD_QUALIFICATION_INTENTS` (CSV). Comparación case-insensitive.
   *
   * NOTA: el criterio `closeScore >= LEAD_QUALIFICATION_SCORE_THRESHOLD` del plan
   * (§9.1) queda pendiente hasta que Hermes devuelva un puntaje de cierre; hoy
   * `HermesResponseDto` no lo incluye, así que la calificación es sólo por intent.
   */
  private shouldQualifyLead(detectedIntent?: string): boolean {
    if (!detectedIntent) return false;

    const highIntents = this.csvConfig('LEAD_QUALIFICATION_INTENTS', [
      'consulta_precio',
      'cotizacion',
      'agendar_cita',
      'pago',
    ]);

    return highIntents.includes(detectedIntent.trim().toLowerCase());
  }

  /**
   * Crea un handoff automático.
   *
   * Delega en `HandoffService.create` (no escribe a Prisma directo): el service
   * pausa la conversación, crea el registro y emite `conversation.handoff_requested`
   * en un único punto, cubriendo tanto el handoff automático como el manual.
   */
  private async createAutoHandoff(
    conversationId: string,
    triggerMessage: string,
    detectedIntent?: string,
  ) {
    await this.handoffService.create({
      conversationId,
      reason: this.handoffReason(detectedIntent),
      reasonDetail: `Handoff automático. Mensaje trigger: ${triggerMessage.substring(0, 200)}`,
    });

    this.logger.log(
      `Handoff automático creado para conversación ${conversationId}`,
    );
  }

  /**
   * Actualiza el estado conversacional con datos de la respuesta de Hermes
   */
  private csvConfig(key: string, defaults: string[]): string[] {
    const configured = this.configService.get<string>(key);
    return (configured ? configured.split(',') : defaults)
      .map((value) => value.trim().toLocaleLowerCase('es'))
      .filter(Boolean);
  }

  private handoffReason(detectedIntent?: string): HandoffReason {
    const intent = detectedIntent?.trim().toLocaleLowerCase('es');
    if (intent === 'queja' || intent === 'reclamo') {
      return HandoffReason.COMPLAINT;
    }
    if (intent === 'pago_fallido') {
      return HandoffReason.PAYMENT_ISSUE;
    }
    if (intent === 'negociacion_especial') {
      return HandoffReason.B2B_NEGOTIATION;
    }
    return HandoffReason.CUSTOM;
  }

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
  private async processStatuses(
    statuses: Array<{
      status?: unknown;
      id?: unknown;
      timestamp?: unknown;
      errors?: unknown;
    }>,
  ): Promise<void> {
    for (const status of statuses) {
      if (typeof status.id !== 'string' || typeof status.status !== 'string')
        continue;
      const firstError = Array.isArray(status.errors)
        ? (status.errors[0] as { code?: unknown; message?: unknown })
        : undefined;
      await this.campaignsService.markRecipientStatus(
        status.id,
        status.status,
        typeof status.timestamp === 'string' ? status.timestamp : undefined,
        firstError && typeof firstError === 'object'
          ? {
              code:
                typeof firstError.code === 'number'
                  ? firstError.code
                  : undefined,
              message:
                typeof firstError.message === 'string'
                  ? firstError.message
                  : undefined,
            }
          : undefined,
      );
    }
  }

  private isCampaignOptOut(message: MetaWebhookMessage): boolean {
    if (
      message.type !== 'interactive' ||
      message.interactive?.type !== 'button_reply'
    )
      return false;
    const reply = message.interactive.button_reply;
    const value = `${reply?.id || ''} ${reply?.title || ''}`
      .trim()
      .toLocaleLowerCase('es');
    return (
      value === 'no recibir mensajes' ||
      value.includes('no_recibir_mensajes') ||
      value.includes('opt_out')
    );
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
        return (
          message.document?.caption ||
          `[Documento: ${message.document?.filename || 'sin nombre'}]`
        );
      case 'audio':
        return '[Audio]';
      case 'video':
        return message.video ? '[Video]' : null;
      case 'location':
        return `[Ubicación: ${message.location?.name || `${message.location?.latitude}, ${message.location?.longitude}`}]`;
      case 'interactive':
        return (
          message.interactive?.button_reply?.title ||
          message.interactive?.list_reply?.title ||
          '[Interactivo]'
        );
      case 'reaction':
        return message.reaction?.emoji || '[Reacción]';
      case 'sticker':
        return '[Sticker]';
      default:
        return null;
    }
  }
}

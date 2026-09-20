import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationStatus,
  HandoffReason,
  MessageDirection,
  MessageSender,
  MessageType,
  Prisma,
  TaskStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { HermesService } from '../hermes/hermes.service';
import { MetaService } from '../meta/meta.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { CommercialProfile } from '../hermes/dto/hermes-request.dto';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import { TasksService } from '../tasks/tasks.service';
import { splitWhatsAppMessage } from './whatsapp-message-splitter';

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
    private readonly hermes: HermesService,
    private readonly handoffs: HandoffService,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
    private readonly commercialPolicy: CommercialPolicyService,
    private readonly conversationGuard: ConversationGuardService,
    @InjectQueue(AUTO_REPLY_QUEUE)
    private readonly queue: Queue<AutoReplyJobData>,
  ) {}

  async enqueue(data: AutoReplyJobData, messageLength: number): Promise<void> {
    const previousHermesMessage = await this.prisma.message.findFirst({
      where: {
        conversationId: data.conversationId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
      },
      select: { id: true },
    });
    const delay = this.replyDelay(messageLength, !previousHermesMessage);
    await this.queue.add('send-auto-reply', data, {
      jobId: `auto-reply-${data.inboundMessageId}`,
      delay,
    });
    this.logger.debug(
      `Respuesta automática programada para conversación ${data.conversationId} en ${delay}ms`,
    );
  }

  async process(data: AutoReplyJobData): Promise<void> {
    const inbound = await this.prisma.message.findUnique({
      where: { id: data.inboundMessageId },
      select: {
        id: true,
        content: true,
        createdAt: true,
        rawPayload: true,
        wamid: true,
        conversationId: true,
        contactId: true,
      },
    });
    if (!inbound || inbound.conversationId !== data.conversationId) return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: data.conversationId },
      include: { contact: true },
    });
    if (!conversation || conversation.status !== ConversationStatus.ACTIVE) {
      return;
    }

    // Si el cliente escribió de nuevo durante la pausa, el job más reciente
    // contestará con todo el contexto y este se descarta para no fragmentar el chat.
    if (await this.hasNewerInbound(data.conversationId, inbound)) return;

    const context = await this.buildConversationContext(
      data.contactId,
      data.conversationId,
      inbound.id,
    );
    const receivedAt =
      this.providerTimestamp(inbound.rawPayload) ?? inbound.createdAt;
    const policy = this.commercialPolicy.analyze(
      inbound.content || '',
      receivedAt,
      context.commercialProfile?.pendingQuestions,
      {
        conversationHistory: context.recentMessages,
        commercialProfile: context.commercialProfile,
      },
    );

    if (policy.requestsHuman) {
      await this.handoffs.create({
        conversationId: data.conversationId,
        reason: HandoffReason.CUSTOM,
        reasonDetail:
          'El cliente solicitó expresamente hablar con una persona.',
      });
      await this.sendAndPersist({
        conversationId: data.conversationId,
        contactId: data.contactId,
        waId: conversation.contact.waId,
        inboundWamid: inbound.wamid,
        content:
          'He registrado su solicitud para que continúe con una persona del equipo. La conversación queda pendiente de asignación.',
        metadata: { action: 'HUMAN_HANDOFF_CREATED' },
        allowedStatuses: [
          ConversationStatus.ACTIVE,
          ConversationStatus.HANDED_OFF,
        ],
      });
      await this.persistConversationState(data.conversationId, {
        detectedIntent: 'solicitud_humano',
        nextAction: 'derivar_humano',
      });
      return;
    }

    if (policy.requestsCall) {
      const callback = await this.tasks.requestCallback({
        conversationId: data.conversationId,
        contactId: data.contactId,
        leadId: context.leadId,
        sourceMessageId: inbound.id,
        requestedAt: policy.requestedCallAt,
      });
      const content = policy.requestedCallAt
        ? 'He registrado la solicitud de llamada usando este mismo número de WhatsApp para el horario indicado. Está pendiente de confirmación por el equipo; todavía no está agendada.'
        : 'Claro, podemos coordinar una llamada usando este mismo número de WhatsApp. ¿Qué horario le viene bien?';
      await this.sendAndPersist({
        conversationId: data.conversationId,
        contactId: data.contactId,
        waId: conversation.contact.waId,
        inboundWamid: inbound.wamid,
        content,
        metadata: {
          action: 'CALLBACK_TASK_PENDING',
          taskId: callback.id,
          requestedAt: policy.requestedCallAt?.toISOString(),
        },
        allowedStatuses: [ConversationStatus.ACTIVE],
      });
      await this.leads.recordCommercialProfileFromConversation({
        contactId: data.contactId,
        conversationId: data.conversationId,
        profile: {
          contactPreference: 'CALL',
          requestedContactTime: policy.requestedCallAt?.toISOString(),
          pendingQuestions: policy.pendingQuestions,
          nextStep: 'Solicitud de llamada pendiente de confirmación',
        },
        sourceMessageId: inbound.id,
      });
      await this.persistConversationState(data.conversationId, {
        detectedIntent: 'agendar_cita',
        nextAction: 'solicitar_confirmacion_reunion',
      });
      return;
    }

    if (!(await this.conversationGuard.consumeAiQuota(data.contactId))) {
      this.logger.warn(
        `Respuesta automática omitida por cuota de IA en conversación ${data.conversationId}`,
      );
      return;
    }

    const startedAt = Date.now();
    await this.showTypingIndicator(inbound.wamid);
    const response = await this.hermes.generateResponse({
      contactName: conversation.contact.name || 'Cliente',
      messageContent: inbound.content || '',
      conversationHistory: context.recentMessages,
      leadStage: context.leadStage,
      productOfInterest: context.productOfInterest,
      conversationSummary: context.conversationSummary,
      commercialProfile: context.commercialProfile,
      contact: {
        id: data.contactId,
        hasUsablePhone: Boolean(conversation.contact.waId),
        hasEmail: Boolean(conversation.contact.email),
      },
      conversationId: data.conversationId,
      correlationId: inbound.id,
      currentIntent: policy.intent,
      conversationGuidance: policy.guidance,
      pendingQuestions: policy.pendingQuestions,
      contactPreference: context.commercialProfile?.contactPreference,
      pendingActions: context.pendingActions,
      actionCapabilities: {
        callbackTasks: true,
        calendarBooking: false,
        humanHandoff: true,
      },
    });
    response.commercialProfile = {
      ...context.commercialProfile,
      ...response.commercialProfile,
      pendingQuestions: this.commercialPolicy.remainingPendingQuestions(
        policy.pendingQuestions,
        response.response,
      ),
    };
    Object.assign(
      response,
      this.commercialPolicy.enforceResponsePolicy(response, policy),
    );

    if (!this.conversationGuard.isSafeGeneratedResponse(response.response)) {
      this.logger.error(
        `Respuesta de Gemini bloqueada por la política de salida en conversación ${data.conversationId}`,
      );
      return;
    }

    // Mientras Gemini redactaba, un mensaje nuevo o un handoff puede haber
    // cambiado quién debe responder. Nunca enviar una respuesta desactualizada.
    const currentConversation = await this.prisma.conversation.findUnique({
      where: { id: data.conversationId },
      select: { status: true },
    });
    if (
      !currentConversation ||
      currentConversation.status !== ConversationStatus.ACTIVE ||
      (await this.hasNewerInbound(data.conversationId, inbound))
    ) {
      return;
    }

    const pendingQuestions = response.commercialProfile?.pendingQuestions || [];
    const requestedPriceWithoutAuthorizedValue =
      policy.pendingQuestions.includes('price') &&
      !/\b\d[\d.,]*\s*(?:EUR|euros?|USD|dólares?)\b|[€$]\s*\d/i.test(
        response.response,
      );
    const requestedTimelineWithoutAuthorizedValue =
      policy.pendingQuestions.includes('timeline') &&
      !/\b\d+\s*(?:días?|semanas?|meses?)\b/i.test(response.response);
    if (
      (requestedPriceWithoutAuthorizedValue ||
        requestedTimelineWithoutAuthorizedValue) &&
      this.hasEnoughScopeForQuote(response.commercialProfile)
    ) {
      const quote = await this.tasks.requestQuote({
        conversationId: data.conversationId,
        contactId: data.contactId,
        leadId: context.leadId,
        sourceMessageId: inbound.id,
        scopeSummary: [
          response.commercialProfile?.service,
          response.commercialProfile?.need,
          response.commercialProfile?.sector,
          response.commercialProfile?.users,
          response.commercialProfile?.timeline,
        ]
          .filter(Boolean)
          .join('; '),
      });
      response.response = requestedTimelineWithoutAuthorizedValue
        ? 'Con el alcance que ya ha descrito, no tengo una cifra ni un plazo autorizados para confirmarle por este canal. He registrado una solicitud de cotización para que el equipo prepare la valoración; queda pendiente de revisión.'
        : 'Con el alcance que ya ha descrito, no tengo una cifra autorizada para confirmarle por este canal. He registrado una solicitud de cotización para que el equipo prepare la valoración; queda pendiente de revisión.';
      response.detectedIntent = 'cotizacion';
      response.nextAction = 'solicitar_cotizacion_humana';
      response.commercialProfile = {
        ...response.commercialProfile,
        pendingQuestions: pendingQuestions.filter(
          (question) => question !== 'price' && question !== 'timeline',
        ),
        nextStep: `Cotización ${quote.id} pendiente de revisión`,
      };
    }

    const shouldHandoff = this.checkHandoffSignals(
      inbound.content || '',
      response.detectedIntent,
    );
    if (shouldHandoff) {
      await this.handoffs.create({
        conversationId: data.conversationId,
        reason: this.handoffReason(response.detectedIntent),
        reasonDetail: `Handoff automático. Mensaje trigger: ${(inbound.content || '').substring(0, 200)}`,
      });
    }
    if (
      !(await this.hasConversationStatus(
        data.conversationId,
        shouldHandoff
          ? [ConversationStatus.ACTIVE, ConversationStatus.HANDED_OFF]
          : [ConversationStatus.ACTIVE],
      ))
    ) {
      return;
    }
    const messageParts = splitWhatsAppMessage(
      response.response,
      this.positiveInteger('AI_MESSAGE_SPLIT_THRESHOLD', 520),
    );
    let sentParts = 0;
    for (const [index, content] of messageParts.entries()) {
      if (index > 0) {
        await this.pause(
          this.nonNegativeInteger('AI_MESSAGE_PART_DELAY_MS', 700),
        );
        const canContinue = await this.hasConversationStatus(
          data.conversationId,
          shouldHandoff
            ? [ConversationStatus.ACTIVE, ConversationStatus.HANDED_OFF]
            : [ConversationStatus.ACTIVE],
        );
        if (
          !canContinue ||
          (await this.hasNewerInbound(data.conversationId, inbound))
        ) {
          break;
        }
      }
      const sentMessage = await this.meta.sendTextMessage(
        conversation.contact.waId,
        content,
      );
      const partLatencyMs = Date.now() - startedAt;
      await this.prisma.message.create({
        data: {
          conversationId: data.conversationId,
          contactId: data.contactId,
          direction: MessageDirection.OUTBOUND,
          sender: MessageSender.HERMES,
          type: MessageType.TEXT,
          content,
          wamid: sentMessage?.messages?.[0]?.id,
          tokensUsed: index === 0 ? response.tokensUsed : 0,
          latencyMs: partLatencyMs,
          costEstimate: index === 0 ? response.costEstimate : 0,
        },
      });
      sentParts += 1;
    }
    const latencyMs = Date.now() - startedAt;
    await this.prisma.conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    });

    const persistedLead =
      await this.leads.recordCommercialProfileFromConversation({
        contactId: data.contactId,
        conversationId: data.conversationId,
        profile: response.commercialProfile,
        sourceMessageId: inbound.id,
      });

    if (response.suggestedTags || response.detectedIntent) {
      await this.persistConversationState(data.conversationId, response);
    }

    if (this.shouldQualifyLead(response.detectedIntent)) {
      await this.leads.qualifyFromConversation({
        contactId: data.contactId,
        conversationId: data.conversationId,
        detectedIntent: response.detectedIntent,
        productOfInterest: context.productOfInterest,
        commercialProfile:
          this.commercialProfileFromMetadata(persistedLead?.metadata) ??
          response.commercialProfile ??
          context.commercialProfile,
      });
    }

    this.logger.log(
      JSON.stringify({
        event: 'auto_reply_sent',
        conversationId: data.conversationId,
        correlationId: inbound.id,
        detectedIntent: response.detectedIntent,
        suggestedAction: response.nextAction,
        executedAction: shouldHandoff
          ? 'HUMAN_HANDOFF_CREATED_AND_MESSAGE_SENT'
          : response.nextAction === 'solicitar_cotizacion_humana'
            ? 'QUOTE_TASK_CREATED_AND_MESSAGE_SENT'
            : 'MESSAGE_SENT',
        outputValidation: 'passed',
        messageParts: sentParts,
        latencyMs,
      }),
    );
  }

  private replyDelay(messageLength: number, isInitialReply: boolean): number {
    void messageLength;
    const key = isInitialReply
      ? 'AI_INITIAL_REPLY_DELAY_MS'
      : 'AI_REPLY_DELAY_MS';
    const configured = Number(this.config.get(key));
    return Number.isSafeInteger(configured) && configured >= 0
      ? configured
      : isInitialReply
        ? 10_000
        : 2000;
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeInteger(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  private async pause(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private async hasNewerInbound(
    conversationId: string,
    inbound: {
      id: string;
      createdAt: Date;
      rawPayload: Prisma.JsonValue | null;
    },
  ): Promise<boolean> {
    const candidates = await this.prisma.message.findMany({
      where: {
        conversationId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, createdAt: true, rawPayload: true },
    });
    const inboundTime =
      this.providerTimestamp(inbound.rawPayload) ?? inbound.createdAt;
    return candidates.some((candidate) => {
      if (candidate.id === inbound.id) return false;
      const candidateTime =
        this.providerTimestamp(candidate.rawPayload) ?? candidate.createdAt;
      return candidateTime.getTime() > inboundTime.getTime();
    });
  }

  private async buildConversationContext(
    contactId: string,
    conversationId: string,
    excludedMessageId: string,
  ) {
    const [recentMessages, state, lead, pendingTasks] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId, NOT: { id: excludedMessageId } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          direction: true,
          content: true,
          createdAt: true,
          rawPayload: true,
        },
      }),
      this.prisma.conversationState.findUnique({ where: { conversationId } }),
      this.prisma.lead.findFirst({
        where: { contactId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.task.findMany({
        where: {
          conversationId,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { type: true, status: true, dueAt: true },
      }),
    ]);
    const orderedMessages = recentMessages.sort((left, right) => {
      const leftTime =
        this.providerTimestamp(left.rawPayload) ?? left.createdAt;
      const rightTime =
        this.providerTimestamp(right.rawPayload) ?? right.createdAt;
      return leftTime.getTime() - rightTime.getTime();
    });
    const conversationHistory = orderedMessages.reduce<
      Array<{ role: 'user' | 'assistant'; content: string }>
    >((history, message) => {
      const role =
        message.direction === MessageDirection.INBOUND ? 'user' : 'assistant';
      const content = message.content || '';
      const previous = history.at(-1);
      if (previous?.role === role) {
        previous.content = `${previous.content}\n\n${content}`.trim();
      } else {
        history.push({ role, content });
      }
      return history;
    }, []);
    return {
      recentMessages: conversationHistory,
      conversationSummary: state?.summary || undefined,
      leadStage: lead?.stage || state?.leadStage || undefined,
      productOfInterest: lead?.productOfInterest || undefined,
      leadId: lead?.id,
      commercialProfile: this.commercialProfileFromMetadata(lead?.metadata),
      pendingActions: pendingTasks.map((task) => ({
        type: task.type,
        status: task.status,
        dueAt: task.dueAt?.toISOString(),
      })),
    };
  }

  private providerTimestamp(
    rawPayload: Prisma.JsonValue | null,
  ): Date | undefined {
    if (
      !rawPayload ||
      typeof rawPayload !== 'object' ||
      Array.isArray(rawPayload)
    ) {
      return undefined;
    }
    const timestamp = (rawPayload as Record<string, unknown>).timestamp;
    if (typeof timestamp !== 'string' || !/^\d{9,13}$/.test(timestamp))
      return undefined;
    const numeric = Number(timestamp);
    const date = new Date(timestamp.length <= 10 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private hasEnoughScopeForQuote(profile?: CommercialProfile): boolean {
    if (!profile?.service || !profile.need) return false;
    return Boolean(
      profile.sector ||
      profile.company ||
      profile.currentSituation ||
      profile.users ||
      profile.productCount ||
      profile.paymentNeeds ||
      profile.shippingNeeds ||
      profile.inventoryNeeds ||
      profile.integrations ||
      profile.timeline ||
      profile.location,
    );
  }

  private async sendAndPersist(params: {
    conversationId: string;
    contactId: string;
    waId: string;
    inboundWamid?: string | null;
    content: string;
    metadata: Record<string, unknown>;
    allowedStatuses: ConversationStatus[];
  }): Promise<void> {
    if (
      !(await this.hasConversationStatus(
        params.conversationId,
        params.allowedStatuses,
      ))
    ) {
      return;
    }
    await this.showTypingIndicator(params.inboundWamid);
    const sent = await this.meta.sendTextMessage(params.waId, params.content);
    await this.prisma.message.create({
      data: {
        conversationId: params.conversationId,
        contactId: params.contactId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.SYSTEM,
        type: MessageType.TEXT,
        content: params.content,
        wamid: sent?.messages?.[0]?.id,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    });
    await this.prisma.conversation.update({
      where: { id: params.conversationId },
      data: { updatedAt: new Date() },
    });
  }

  private async hasConversationStatus(
    conversationId: string,
    allowedStatuses: ConversationStatus[],
  ): Promise<boolean> {
    const current = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true },
    });
    return Boolean(current && allowedStatuses.includes(current.status));
  }

  private async showTypingIndicator(
    inboundWamid?: string | null,
  ): Promise<void> {
    if (!inboundWamid) return;
    await this.meta.showTypingIndicator(inboundWamid);
  }

  private async persistConversationState(
    conversationId: string,
    response: {
      detectedIntent?: string;
      nextAction?: string;
      suggestedTags?: string[];
    },
  ): Promise<void> {
    await this.prisma.conversationState.upsert({
      where: { conversationId },
      update: {
        detectedIntent: response.detectedIntent,
        nextSuggestedAction: response.nextAction,
        commercialTags: response.suggestedTags || [],
      },
      create: {
        conversationId,
        detectedIntent: response.detectedIntent,
        nextSuggestedAction: response.nextAction,
        commercialTags: response.suggestedTags || [],
      },
    });
  }

  private commercialProfileFromMetadata(
    metadata: unknown,
  ): CommercialProfile | undefined {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return undefined;
    }
    const profile = (metadata as Record<string, unknown>).commercialProfile;
    return profile && typeof profile === 'object' && !Array.isArray(profile)
      ? profile
      : undefined;
  }

  private checkHandoffSignals(
    message: string,
    detectedIntent?: string,
  ): boolean {
    const keywords = this.csvConfig('HANDOFF_KEYWORDS', [
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
    ]);
    const intents = this.csvConfig('HANDOFF_INTENTS', [
      'solicitud_humano',
      'queja',
      'reclamo',
      'pago_fallido',
      'negociacion_especial',
    ]);
    const normalizedIntent = detectedIntent?.trim().toLocaleLowerCase('es');
    // Un fallo del proveedor o de validación no expresa que el cliente necesite
    // atención humana. Nunca crear un handoff comercial por un error técnico.
    if (normalizedIntent === 'error') return false;
    return (
      keywords.some((keyword) =>
        message.toLocaleLowerCase('es').includes(keyword),
      ) || Boolean(normalizedIntent && intents.includes(normalizedIntent))
    );
  }

  private shouldQualifyLead(detectedIntent?: string): boolean {
    return Boolean(
      detectedIntent &&
      this.csvConfig('LEAD_QUALIFICATION_INTENTS', [
        'consulta_precio',
        'cotizacion',
        'agendar_cita',
        'pago',
      ]).includes(detectedIntent.trim().toLowerCase()),
    );
  }

  private csvConfig(key: string, defaults: string[]): string[] {
    const configured = this.config.get<string>(key);
    return (configured ? configured.split(',') : defaults)
      .map((value) => value.trim().toLocaleLowerCase('es'))
      .filter(Boolean);
  }

  private handoffReason(detectedIntent?: string): HandoffReason {
    const intent = detectedIntent?.trim().toLocaleLowerCase('es');
    if (intent === 'queja' || intent === 'reclamo')
      return HandoffReason.COMPLAINT;
    if (intent === 'pago_fallido') return HandoffReason.PAYMENT_ISSUE;
    if (intent === 'negociacion_especial') return HandoffReason.B2B_NEGOTIATION;
    return HandoffReason.CUSTOM;
  }
}

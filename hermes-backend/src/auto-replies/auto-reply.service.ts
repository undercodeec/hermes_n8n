import { InjectQueue } from '@nestjs/bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { ConversationEngineService } from '../conversation-engine/conversation-engine.service';
import { MetaMediaUploadError, MetaService } from '../meta/meta.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import {
  CommercialProfile,
  HermesResponseDto,
} from '../hermes/dto/hermes-request.dto';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
} from '../hermes/commercial-authority.service';
import {
  answerExplicitPriceIfMissing,
  reviewCommercialClaims,
} from '../hermes/commercial-claims';
import { TasksService } from '../tasks/tasks.service';
import { splitWhatsAppMessage } from './whatsapp-message-splitter';
import {
  HermesIncidentMetadata,
  toIncidentMetadata,
} from '../hermes/hermes-diagnostics';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { reviewAgentProposal } from '../conversation-engine/agent-proposal-policy';
import { AGENT_DEFAULT_INTENTS } from '../conversation-engine/agent-output.contract';
import { InboundTurnService } from './inbound-turn.service';
import {
  VoiceProcessingError,
  VoiceService,
  voiceFailureLogDiagnostics,
} from '../voice/voice.service';

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
    private readonly conversationEngine: ConversationEngineService,
    private readonly handoffs: HandoffService,
    private readonly leads: LeadsService,
    private readonly tasks: TasksService,
    private readonly commercialPolicy: CommercialPolicyService,
    private readonly commercialAuthority: CommercialAuthorityService,
    private readonly conversationGuard: ConversationGuardService,
    @InjectQueue(AUTO_REPLY_QUEUE)
    private readonly queue: Queue<AutoReplyJobData>,
    private readonly deliveries: AutomatedDeliveryService,
    @Optional() private readonly inboundTurns?: InboundTurnService,
    @Optional() private readonly voice?: VoiceService,
  ) {}

  async enqueue(data: AutoReplyJobData, messageLength: number): Promise<void> {
    if (this.inboundTurns) {
      const turn = await this.inboundTurns.schedule(data);
      await this.queue.add(
        'send-auto-reply',
        { ...data, inboundTurnId: turn.id },
        {
          jobId: `auto-reply-${data.inboundMessageId}`,
          delay: Math.max(0, turn.dueAt.getTime() - Date.now()),
        },
      );
      return;
    }
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
    if (data.inboundTurnId && this.inboundTurns) {
      const turn = await this.inboundTurns.claim(data.inboundTurnId);
      if (!turn) {
        const pending = await this.inboundTurns.findPending(data.inboundTurnId);
        if (pending && this.inboundTurns.nextClaimAt(pending) > Date.now()) {
          await this.queue.add('send-auto-reply', data, {
            jobId: `turn-recheck-${pending.id}-${randomUUID()}`,
            delay: Math.max(
              1,
              this.inboundTurns.nextClaimAt(pending) - Date.now() + 1,
            ),
          });
        }
        return;
      }
      try {
        const pending = await this.inboundTurns.messages(turn.id);
        const audio = pending.filter(
          (message) =>
            message.type === MessageType.AUDIO && message.content === '[Audio]',
        );
        if (audio.length) {
          try {
            if (!this.voice)
              throw new VoiceProcessingError('STT_NOT_CONFIGURED');
            for (const message of audio) {
              const payload = message.rawPayload;
              const mediaId =
                payload &&
                typeof payload === 'object' &&
                !Array.isArray(payload) &&
                payload.audio &&
                typeof payload.audio === 'object' &&
                !Array.isArray(payload.audio) &&
                typeof payload.audio.id === 'string'
                  ? payload.audio.id
                  : undefined;
              if (!mediaId) throw new Error('AUDIO_MEDIA_ID_MISSING');
              const transcript = await this.voice.transcribe(mediaId);
              await this.prisma.message.update({
                where: { id: message.id },
                data: {
                  content: transcript.text,
                  metadata: {
                    sourceType: 'AUDIO',
                    transcriptionStatus: 'READY',
                    language: transcript.language,
                    confidence: transcript.confidence,
                  },
                },
              });
            }
          } catch (error) {
            const reasonCode =
              error instanceof VoiceProcessingError
                ? error.code
                : 'AUDIO_PROCESSING_FAILED';
            const diagnostics = voiceFailureLogDiagnostics(
              error instanceof VoiceProcessingError
                ? error.diagnostics
                : undefined,
            );
            this.logger.warn(
              JSON.stringify({
                event: 'audio_transcription_failed',
                conversationId: data.conversationId,
                inboundMessageId: turn.lastMessageId,
                reasonCode,
                provider: diagnostics.provider,
                modelId: diagnostics.modelId,
                mimeType: diagnostics.mimeType,
                audioBytes: diagnostics.audioBytes,
                providerHttpStatus: diagnostics.providerHttpStatus,
                providerErrorCode: diagnostics.providerErrorCode,
                providerMessage: diagnostics.providerMessage,
                transportCode: diagnostics.transportCode,
                transportMessage: diagnostics.transportMessage,
                requestId: diagnostics.requestId,
                failureKind: diagnostics.failureKind,
              }),
            );
            const notice =
              reasonCode === 'STT_NOT_CONFIGURED' ||
              reasonCode === 'STT_PROVIDER_UNSUPPORTED' ||
              reasonCode === 'STT_PROVIDER_FAILED' ||
              reasonCode === 'AUDIO_TOOL_UNAVAILABLE'
                ? 'No puedo procesar notas de voz en este momento. ¿Podría escribirme su mensaje?'
                : reasonCode === 'AUDIO_TOO_LONG'
                  ? 'La nota de voz es demasiado larga para procesarla. ¿Podría enviarla en partes más cortas o escribirme su mensaje?'
                  : reasonCode === 'STT_LOW_CONFIDENCE' ||
                      reasonCode === 'STT_EMPTY_OR_TOO_LONG'
                    ? 'No pude entender bien esa nota de voz. ¿Podría reenviarla o escribirme esa parte?'
                    : 'No pude procesar esa nota de voz. ¿Podría reenviarla o escribirme esa parte?';
            await this.deliveries.prepareBatch({
              deliveryKind: 'SYSTEM_NOTICE',
              conversationId: data.conversationId,
              contactId: data.contactId,
              sourceMessageId: turn.lastMessageId,
              sender: 'SYSTEM',
              allowHandedOff: false,
              parts: [
                {
                  partIndex: 0,
                  content: notice,
                  metadata: {
                    action: 'AUDIO_TRANSCRIPTION_FAILED',
                    conversationTurnId: turn.id,
                    reasonCode,
                  },
                },
              ],
            });
            await this.deliveries.deliverPreparedBatch(turn.lastMessageId);
            await this.inboundTurns.complete(turn.id, turn.processingToken!);
            return;
          }
        }
        const messages = await this.inboundTurns.messages(turn.id);
        await this.processTurn(
          { ...data, inboundMessageId: turn.lastMessageId },
          messages,
        );
        await this.inboundTurns.complete(turn.id, turn.processingToken!);
      } catch (error) {
        await this.inboundTurns.release(turn.id, turn.processingToken!);
        throw error;
      }
      return;
    }
    await this.processTurn(data);
  }

  private async processTurn(
    data: AutoReplyJobData,
    turnMessages?: Awaited<ReturnType<InboundTurnService['messages']>>,
  ): Promise<void> {
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
    if (!inbound || inbound.conversationId !== data.conversationId) {
      this.logSkip(data, 'INBOUND_NOT_FOUND_OR_MISMATCH');
      return;
    }
    const customerMessage = turnMessages?.length
      ? turnMessages
          .map(
            (message, index) =>
              `[Mensaje ${index + 1}, ${message.type}] ${message.content ?? ''}`,
          )
          .join('\n')
      : inbound.content || '';

    const recovered = await this.deliveries.recoverBatch(inbound.id);
    if (recovered?.handled) {
      this.logSkip(data, 'EXISTING_DELIVERY_BATCH', {
        confirmed: recovered.confirmed,
        terminal: recovered.terminal,
        reasonCode: recovered.reasonCode,
      });
      return;
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: data.conversationId },
      include: { contact: true },
    });
    if (!conversation || conversation.status !== ConversationStatus.ACTIVE) {
      this.logSkip(data, 'CONVERSATION_NOT_ACTIVE', {
        status: conversation?.status ?? 'NOT_FOUND',
      });
      return;
    }

    // Si el cliente escribió de nuevo durante la pausa, el job más reciente
    // contestará con todo el contexto y este se descarta para no fragmentar el chat.
    if (await this.hasNewerInbound(data.conversationId, inbound)) {
      this.logSkip(data, 'NEWER_INBOUND');
      return;
    }

    const context = await this.buildConversationContext(
      data.contactId,
      data.conversationId,
      turnMessages?.map((message) => message.id) ?? [inbound.id],
    );
    const receivedAt =
      this.providerTimestamp(inbound.rawPayload) ?? inbound.createdAt;
    const policy = this.commercialPolicy.analyze(
      customerMessage,
      receivedAt,
      context.commercialProfile?.pendingQuestions,
      {
        conversationHistory: context.recentMessages,
        commercialProfile: context.commercialProfile,
      },
    );
    const commercialSnapshot = await this.commercialAuthority.snapshot({
      customerMessage,
      profile: context.commercialProfile,
      productOfInterest: context.productOfInterest,
      recentCustomerMessages: context.recentMessages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
      priceRequested: policy.guidance.priceAnswerRequired,
    });
    policy.guidance.allowPriceAnswer =
      policy.guidance.priceAnswerRequired &&
      commercialSnapshot.offers.some(
        (offer) => offer.priceType !== 'QUOTE_REQUIRED',
      );
    const selectedEngine = policy.requestsCall
      ? this.conversationEngine.selectedEngine(data.conversationId)
      : undefined;

    if (policy.requestsHuman) {
      this.logger.log(
        JSON.stringify({
          event: 'handoff_requested',
          conversationId: data.conversationId,
          sourceMessageId: inbound.id,
        }),
      );
      await this.handoffs.create(
        {
          conversationId: data.conversationId,
          reason: HandoffReason.CUSTOM,
          reasonDetail:
            'El cliente solicitó expresamente hablar con una persona.',
        },
        undefined,
        { sourceMessageId: inbound.id, callRequested: policy.requestsCall },
      );
      const delivery = await this.sendAndPersist({
        conversationId: data.conversationId,
        contactId: data.contactId,
        sourceMessageId: inbound.id,
        inboundWamid: inbound.wamid,
        content: policy.requestsCall
          ? 'He registrado su solicitud para que un asesor coordine una llamada usando este mismo número de WhatsApp. Está pendiente de asignación y confirmación del horario.'
          : 'He registrado su solicitud para que continúe con una persona del equipo. La conversación queda pendiente de asignación.',
        metadata: { action: 'HUMAN_HANDOFF_CREATED' },
        allowHandedOff: true,
      });
      if (delivery.confirmed > 0) {
        await this.persistConversationState(data.conversationId, {
          detectedIntent: 'solicitud_humano',
          nextAction: 'derivar_humano',
        });
      }
      return;
    }

    if (policy.requestsCall && selectedEngine !== 'nous_hermes') {
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
      const delivery = await this.sendAndPersist({
        conversationId: data.conversationId,
        contactId: data.contactId,
        sourceMessageId: inbound.id,
        inboundWamid: inbound.wamid,
        content,
        metadata: {
          action: 'CALLBACK_TASK_PENDING',
          taskId: callback.id,
          requestedAt: policy.requestedCallAt?.toISOString(),
        },
        allowHandedOff: false,
      });
      if (delivery.confirmed === 0) return;
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
      this.logSkip(data, 'AI_QUOTA_EXCEEDED');
      return;
    }

    const startedAt = Date.now();
    await this.showTypingIndicator(inbound.wamid);
    const approvedKnowledge = commercialSnapshotKnowledge(commercialSnapshot);
    const engineResult = await this.conversationEngine.respond({
      conversationId: data.conversationId,
      inboundMessageId: inbound.id,
      customerMessage,
      approvedContext: {
        contactName: conversation.contact.name || 'Cliente',
        recentMessages: context.recentMessages.map(({ role, content }) => ({
          role,
          text: content,
        })),
        commercialProfile: context.commercialProfile,
        recentProfileChanges: context.recentProfileChanges,
        approvedKnowledge,
        commercialSnapshot,
        handoffActive: false,
        leadStage: context.leadStage,
        productOfInterest: context.productOfInterest,
        conversationSummary: context.conversationSummary,
        contact: {
          id: data.contactId,
          hasUsablePhone: Boolean(conversation.contact.waId),
          hasEmail: Boolean(conversation.contact.email),
        },
        currentIntent: policy.intent,
        conversationGuidance: policy.guidance,
        pendingQuestions: policy.pendingQuestions,
        contactPreference: context.commercialProfile?.contactPreference,
        pendingActions: context.pendingActions,
        recentCompletedActions: context.recentCompletedActions,
        actionCapabilities: {
          callbackTasks: true,
          calendarBooking: false,
          humanHandoff: true,
        },
      },
    });
    const response: HermesResponseDto = {
      response: engineResult.replyText,
      tokensUsed: engineResult.usage?.totalTokens,
      costEstimate: engineResult.costEstimate,
      suggestedTags: engineResult.business?.suggestedTags,
      detectedIntent: engineResult.business?.detectedIntent,
      nextAction: engineResult.business?.nextAction,
      decision: engineResult.business?.decision,
      commercialProfile: engineResult.business?.commercialProfile,
      diagnostic: engineResult.diagnostic,
    };
    const isNous = engineResult.engine === 'nous_hermes';
    const reviewedProposal =
      isNous && !response.diagnostic
        ? reviewAgentProposal(
            engineResult,
            customerMessage,
            context.recentMessages
              .filter((message) => message.role === 'user')
              .map((message) => message.content),
            this.csvConfig('HERMES_ALLOWED_TAGS', []),
          )
        : undefined;
    if (reviewedProposal) {
      response.commercialProfile = reviewedProposal.profilePatch;
      response.suggestedTags = reviewedProposal.tags;
      const allowedIntents = this.csvConfig('HERMES_ALLOWED_INTENTS', [
        ...AGENT_DEFAULT_INTENTS,
      ]);
      if (
        response.detectedIntent &&
        !allowedIntents.includes(response.detectedIntent)
      ) {
        reviewedProposal.rejections.push('INTENT_NOT_ALLOWED');
        response.detectedIntent = undefined;
      }
      // No hay calendario ni operación de cobro: estas afirmaciones nunca son confirmaciones reales.
      const unconfirmedClaim =
        /\b(?:(?:su|la|el)\s+)?(?:cita|reunión|llamada|cotización|propuesta|pago|cobro|reserva)\s+(?:ya\s+)?(?:está|quedó|ha sido)\s+(?:confirmad[oa]|agendad[oa]|reservad[oa]|enviad[oa]|aprobad[oa]|procesad[oa]|realizad[oa])\b/giu;
      if (unconfirmedClaim.test(response.response)) {
        response.response = response.response.replace(
          unconfirmedClaim,
          'solicitud pendiente de confirmación',
        );
        reviewedProposal.rejections.push('UNCONFIRMED_ACTION_CLAIM');
      }
      if (
        reviewedProposal.action.type === 'none' &&
        this.containsUnbackedFollowupPromise(response.response)
      ) {
        const kept = response.response
          .split(/(?<=[.!?])\s+/u)
          .filter(
            (sentence) => !this.containsUnbackedFollowupPromise(sentence),
          );
        response.response =
          kept.join(' ').trim() ||
          'Puedo ayudarle con la información disponible por este chat.';
        reviewedProposal.rejections.push('UNBACKED_FOLLOWUP_PROMISE');
      }
      const safetyReview = this.commercialPolicy.repairNousCommercialClaims(
        response.response,
        approvedKnowledge,
        commercialSnapshot.offers.some((offer) => offer.promotion),
      );
      response.response = safetyReview.response;
      reviewedProposal.rejections.push(...safetyReview.reasons);
    }
    const acceptedProfile = response.diagnostic
      ? context.commercialProfile
      : { ...context.commercialProfile, ...response.commercialProfile };
    response.commercialProfile = {
      ...acceptedProfile,
      ...(commercialSnapshot.marketSource === 'CURRENT' &&
      commercialSnapshot.market
        ? { market: commercialSnapshot.market }
        : {}),
      pendingQuestions: this.commercialPolicy.remainingPendingQuestions(
        policy.pendingQuestions,
        response.response,
      ),
    };
    if (!isNous) {
      Object.assign(
        response,
        this.commercialPolicy.enforceResponsePolicy(response, policy),
      );
    }
    const commercialReview = reviewCommercialClaims(
      response.response,
      commercialSnapshot,
    );
    response.response = answerExplicitPriceIfMissing(
      commercialReview.response,
      commercialSnapshot,
      policy.guidance.currentTopic === 'price',
    );
    if (
      !policy.guidance.priceAnswerRequired &&
      !commercialSnapshot.renewalRequested &&
      /\b(?:USD|EUR)\s*\$?\s*\d|[$€]\s*\d/iu.test(response.response)
    ) {
      const recommended = commercialSnapshot.offers.find(
        (offer) => offer.id === commercialSnapshot.recommendedOfferId,
      );
      response.response = recommended
        ? `Por lo que me comenta, ${recommended.name} puede encajar para la parte incluida en el plan: ${recommended.scope} ${commercialSnapshot.additionalScope?.length ? `La parte de ${commercialSnapshot.additionalScope.join(' y ')} requiere valoración aparte.` : ''}`.trim()
        : 'Puedo orientarle sobre la opción que mejor cubra su necesidad. ¿Qué función es la más importante para usted?';
      reviewedProposal?.rejections.push('UNREQUESTED_PRICE');
    }
    const recommended = commercialSnapshot.offers.find(
      (offer) => offer.id === commercialSnapshot.recommendedOfferId,
    );
    if (
      policy.guidance.priceAnswerRequired &&
      commercialSnapshot.additionalScope?.length &&
      !/\b(?:valoraci[oó]n|cotizaci[oó]n|estimar)\b/iu.test(response.response)
    ) {
      response.response =
        `${response.response} ${commercialSnapshot.additionalScope.join(' y ')} requiere valoración aparte; no hay precio confirmado para ese adicional.`.trim();
    }
    if (
      !response.diagnostic &&
      policy.guidance.allowPlanRecommendation &&
      recommended &&
      !response.response
        .toLocaleLowerCase('es')
        .includes(recommended.name.toLocaleLowerCase('es'))
    ) {
      const recommendation = `Por lo que me comenta, ${recommended.name} puede cubrir la parte de presencia web y captación: ${recommended.scope}`;
      const additional = commercialSnapshot.additionalScope?.length
        ? ` ${commercialSnapshot.additionalScope.join(' y ')} requiere valoración por separado.`
        : '';
      response.response =
        /\b(?:todo|proyecto completo)\b.{0,80}\b(?:personalizado|a medida|valoraci[oó]n)\b|\b(?:valor|precio)\b.{0,80}\b(?:depende|confirmar|valoraci[oó]n)\b/iu.test(
          response.response,
        )
          ? `${recommendation}${additional}`
          : `${recommendation}${additional} ${response.response}`.trim();
    }
    if (
      commercialSnapshot.renewalRequested &&
      recommended?.renewalUsdPerYear &&
      !new RegExp(`\\b${recommended.renewalUsdPerYear}\\b`).test(
        response.response,
      )
    ) {
      const terms = `El primer año de dominio y hosting está incluido según el alcance de ${recommended.name}. Desde el segundo año, la renovación conjunta cuesta USD ${recommended.renewalUsdPerYear} anuales.`;
      response.response =
        policy.guidance.currentTopic === 'renewal' ||
        policy.guidance.currentTopic === 'infrastructure'
          ? terms
          : `${response.response} ${terms}`.trim();
    }
    if (
      policy.pendingQuestions.includes('timeline') &&
      commercialSnapshot.policies?.length
    ) {
      const customScope = [
        customerMessage,
        context.commercialProfile?.service,
        context.commercialProfile?.need,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const days =
        recommended?.estimatedBusinessDays ??
        (/\b(?:software a medida|aplicacion movil|app movil|aplicacion web|web app|moodle)\b/.test(
          customScope,
        )
          ? 30
          : undefined);
      if (days)
        response.response = response.response
          .split(/(?<=[.!?])\s+/u)
          .filter((sentence) => {
            const quantities = [...sentence.matchAll(/\b(\d+)\s+d[ií]as\b/giu)];
            return (
              !quantities.length ||
              (quantities.every((match) => Number(match[1]) === days) &&
                /\b(?:estimad[oa]|aproximad[oa]|alrededor|sujeto|depende)\b/iu.test(
                  sentence,
                ))
            );
          })
          .join(' ')
          .trim();
      if (
        days &&
        !new RegExp(`\\b${days}\\s+d[ií]as`).test(response.response)
      ) {
        const terms = `El plazo estimado es de aproximadamente ${days} días laborables, sujeto a que entregue a tiempo textos, imágenes, accesos y demás material necesario; si se retrasa la entrega, el plazo se desplaza.`;
        response.response =
          policy.guidance.currentTopic === 'timeline'
            ? terms
            : `${response.response} ${terms}`.trim();
      }
    }
    response.response = this.polishInitialGreeting({
      reply: response.response,
      customerMessage:
        turnMessages?.length === 1
          ? turnMessages[0].content || ''
          : turnMessages
            ? ''
            : inbound.content || '',
      contactName: conversation.contact.name || '',
    });
    reviewedProposal?.rejections.push(...commercialReview.reasons);

    const outputDecision = this.conversationGuard.inspectGeneratedResponse(
      response.response,
    );
    if (outputDecision.action === 'BLOCK') {
      this.logger.error(
        `Respuesta del motor ${engineResult.engine} bloqueada por ${outputDecision.reason} en conversación ${data.conversationId}`,
      );
      response.response =
        'Disculpe, no pude procesar la respuesta de forma segura. ¿Podría reformular su solicitud?';
      response.detectedIntent = 'error';
      response.nextAction = 'sin_accion';
      response.commercialProfile = context.commercialProfile
        ? { ...context.commercialProfile }
        : undefined;
      response.diagnostic = {
        category: 'OUTPUT_BLOCKED',
        code: `HERMES_OUTPUT_${outputDecision.reason}`,
        summary: `Respuesta bloqueada por ${outputDecision.reason}`,
        attempts: 1,
        recovered: true,
        requiresHumanReview: false,
      };
    }

    if (
      !response.diagnostic &&
      this.containsUnbackedFollowupPromise(response.response)
    ) {
      response.diagnostic = {
        category: 'CONTEXT_ERROR',
        code: 'HERMES_UNBACKED_FOLLOWUP_PROMISE',
        summary: 'La respuesta prometía seguimiento sin una acción registrada',
        attempts: 1,
        recovered: true,
        requiresHumanReview: true,
      };
    }

    if (response.diagnostic?.category === 'POLICY_VIOLATION') {
      response.detectedIntent = 'info_general';
      response.nextAction = 'sin_accion';
      response.suggestedTags = undefined;
    }

    let incident: HermesIncidentMetadata | undefined;
    if (response.diagnostic) {
      let reviewTaskId: string | undefined;
      if (response.diagnostic.requiresHumanReview) {
        try {
          const reviewTask = await this.tasks.requestHermesReview({
            conversationId: data.conversationId,
            contactId: data.contactId,
            leadId: context.leadId,
            sourceMessageId: inbound.id,
            category: response.diagnostic.category,
            code: response.diagnostic.code,
            summary: response.diagnostic.summary,
          });
          reviewTaskId = reviewTask.id;
          response.response = [
            'PROVIDER_ERROR',
            'INVALID_PROVIDER_RESPONSE',
          ].includes(response.diagnostic.category)
            ? 'Disculpe, no pude completar la respuesta en este momento. Ya dejé registrado el caso para revisarlo y continuar por este mismo chat.'
            : 'Permítame consultar este punto con el equipo. Le confirmaremos por este mismo chat.';
        } catch (error) {
          this.logger.error(
            `No se pudo crear la tarea de revisión de Hermes: ${error instanceof Error ? error.message : String(error)}`,
          );
          response.response =
            'Disculpe, no pude completar la respuesta en este momento. ¿Podría enviar nuevamente su mensaje para intentarlo otra vez?';
        }
      }
      incident = toIncidentMetadata(
        {
          ...response.diagnostic,
          requiresHumanReview: Boolean(reviewTaskId),
        },
        inbound.id,
        reviewTaskId,
      );
    }

    // Mientras Gemini redactaba, un mensaje nuevo o un handoff puede haber
    // cambiado quién debe responder. Nunca enviar una respuesta desactualizada.
    const currentConversation = await this.prisma.conversation.findUnique({
      where: { id: data.conversationId },
      select: { status: true },
    });
    if (
      !currentConversation ||
      currentConversation.status !== ConversationStatus.ACTIVE
    ) {
      this.logSkip(data, 'CONVERSATION_CHANGED_DURING_GENERATION', {
        status: currentConversation?.status ?? 'NOT_FOUND',
      });
      return;
    }
    if (await this.hasNewerInbound(data.conversationId, inbound)) {
      this.logSkip(data, 'NEWER_INBOUND_DURING_GENERATION');
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
      !response.diagnostic &&
      !isNous &&
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

    const shouldHandoff =
      !response.diagnostic &&
      (isNous
        ? reviewedProposal?.action.type === 'request_handoff'
        : this.checkHandoffSignals(customerMessage, response.detectedIntent));
    let actionResult: string = 'MESSAGE_ONLY';
    if (
      isNous &&
      !response.diagnostic &&
      reviewedProposal?.action.type === 'request_callback'
    ) {
      const callback = await this.tasks.requestCallback({
        conversationId: data.conversationId,
        contactId: data.contactId,
        leadId: context.leadId,
        sourceMessageId: inbound.id,
        requestedAt: policy.requestedCallAt,
      });
      actionResult = `CALLBACK_TASK_PENDING:${callback.id}`;
      response.nextAction = 'solicitar_confirmacion_reunion';
    }
    if (
      isNous &&
      !response.diagnostic &&
      reviewedProposal?.action.type === 'propose_quote_task'
    ) {
      const quote = await this.tasks.requestQuote({
        conversationId: data.conversationId,
        contactId: data.contactId,
        leadId: context.leadId,
        sourceMessageId: inbound.id,
        scopeSummary: [
          context.commercialProfile?.service,
          context.commercialProfile?.need,
          customerMessage,
        ]
          .filter(Boolean)
          .join('; ')
          .slice(0, 500),
      });
      actionResult = `QUOTE_TASK_PENDING:${quote.id}`;
      response.nextAction = 'solicitar_cotizacion_humana';
    }
    if (shouldHandoff) {
      this.logger.log(
        JSON.stringify({
          event: 'handoff_requested',
          conversationId: data.conversationId,
          sourceMessageId: inbound.id,
        }),
      );
      await this.handoffs.create(
        {
          conversationId: data.conversationId,
          reason: this.handoffReason(response.detectedIntent),
          reasonDetail: 'Handoff automático solicitado en la conversación.',
        },
        undefined,
        response.detectedIntent === 'solicitud_humano'
          ? { sourceMessageId: inbound.id }
          : undefined,
      );
      actionResult = 'HUMAN_HANDOFF_CREATED';
      if (isNous) {
        response.detectedIntent = 'solicitud_humano';
        response.nextAction = 'derivar_humano';
      }
    }
    if (
      !(await this.hasConversationStatus(
        data.conversationId,
        shouldHandoff
          ? [ConversationStatus.ACTIVE, ConversationStatus.HANDED_OFF]
          : [ConversationStatus.ACTIVE],
      ))
    ) {
      this.logSkip(data, 'CONVERSATION_STATUS_REJECTED_BEFORE_SEND');
      return;
    }
    const conversationalParts =
      isNous &&
      !response.diagnostic &&
      engineResult.replyParts?.length &&
      response.response === engineResult.replyText
        ? engineResult.replyParts
        : [response.response];
    const messageParts = conversationalParts.flatMap((part) =>
      splitWhatsAppMessage(
        part,
        this.positiveInteger('AI_MESSAGE_SPLIT_THRESHOLD', 520),
      ),
    );
    if (messageParts.length > 9) {
      this.logSkip(data, 'TOO_MANY_REPLY_PARTS');
      return;
    }
    if (
      !response.diagnostic &&
      messageParts.some(
        (part) =>
          !part.trim() ||
          this.conversationGuard.inspectGeneratedResponse(part).action ===
            'BLOCK',
      )
    ) {
      this.logSkip(data, 'REPLY_PART_BLOCKED');
      return;
    }
    const modality = this.config.get<string>('HERMES_REPLY_MODALITY', 'mirror');
    const wantsVoice = Boolean(
      data.inboundTurnId &&
      this.voice &&
      (modality === 'voice' ||
        (modality === 'mirror' &&
          turnMessages?.at(-1)?.type === MessageType.AUDIO)),
    );
    let voiceMediaIds: string[] = [];
    if (wantsVoice && messageParts.length <= 3) {
      let generated: Buffer[] | null = null;
      try {
        const synthesized: Buffer[] = [];
        for (const content of messageParts)
          synthesized.push(await this.voice!.synthesize(content));
        generated = synthesized;
      } catch (error) {
        voiceMediaIds = [];
        const reasonCode =
          error instanceof VoiceProcessingError
            ? error.code
            : 'AUDIO_SYNTHESIS_FAILED';
        this.logger.warn(
          JSON.stringify({
            event:
              reasonCode === 'AUDIO_TOOL_UNAVAILABLE' ||
              reasonCode === 'AUDIO_CONVERSION_FAILED' ||
              reasonCode === 'TTS_INVALID_OGG'
                ? 'audio_conversion_failed'
                : 'voice_synthesis_failed',
            reasonCode,
          }),
        );
      }
      if (generated) {
        try {
          for (const bytes of generated)
            voiceMediaIds.push(await this.meta.uploadVoiceNote(bytes));
        } catch (error) {
          voiceMediaIds = [];
          const reasonCode =
            error instanceof MetaMediaUploadError
              ? error.reasonCode
              : 'VOICE_MEDIA_UPLOAD_FAILED';
          this.logger.warn(
            JSON.stringify({
              event: 'voice_media_upload_failed',
              reasonCode,
            }),
          );
        }
      }
    }
    await this.deliveries.prepareBatch({
      deliveryKind: 'HERMES_REPLY',
      conversationId: data.conversationId,
      contactId: data.contactId,
      sourceMessageId: inbound.id,
      sender: 'HERMES',
      allowHandedOff: shouldHandoff,
      parts: messageParts.map((content, partIndex) => ({
        partIndex,
        content,
        ...(data.inboundTurnId
          ? {
              metadata: {
                conversationTurnId: data.inboundTurnId,
                ...(voiceMediaIds[partIndex]
                  ? { voiceMediaId: voiceMediaIds[partIndex] }
                  : {}),
              },
            }
          : {}),
        ...(partIndex === 0
          ? {
              metadata: {
                conversationEngine: engineResult.engine,
                ...(data.inboundTurnId
                  ? {
                      conversationTurnId: data.inboundTurnId,
                      ...(voiceMediaIds[partIndex]
                        ? { voiceMediaId: voiceMediaIds[partIndex] }
                        : {}),
                    }
                  : {}),
                providerModel: engineResult.providerModel,
                traceId: engineResult.traceId,
                tokensUsed: response.tokensUsed,
                latencyMs: Date.now() - startedAt,
                ...(isNous
                  ? {
                      proposalUnchanged:
                        engineResult.replyText === response.response,
                      proposedReplySha256: createHash('sha256')
                        .update(engineResult.replyText)
                        .digest('hex'),
                      ...(engineResult.replyText !== response.response &&
                      !response.diagnostic
                        ? { proposedReply: engineResult.replyText }
                        : {}),
                      proposalRejections: reviewedProposal?.rejections,
                      proposedAction:
                        engineResult.proposedActions[0]?.type ?? 'none',
                      actionResult,
                    }
                  : {}),
                costEstimate: response.costEstimate,
                ...(incident ? { hermesIncident: incident } : {}),
              },
            }
          : {}),
      })),
    });
    if (data.inboundTurnId) {
      const configured = Number(
        this.config.get('HERMES_CONVERSATION_MESSAGE_DELAY_MS'),
      );
      const delayMs =
        Number.isSafeInteger(configured) && configured >= 0 ? configured : 3000;
      if (delayMs > 0) await delay(delayMs);
    }
    const delivery = await this.deliveries.deliverPreparedBatch(inbound.id);
    const sentParts = delivery.confirmed;
    if (sentParts === 0) {
      this.logSkip(data, delivery.reasonCode || 'DELIVERY_NOT_CONFIRMED');
      return;
    }
    if (incident) {
      await this.persistHermesIncident(data.conversationId, incident);
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

    if (
      !response.diagnostic &&
      this.shouldQualifyLead(response.detectedIntent)
    ) {
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
        conversationEngine: engineResult.engine,
        providerModel: engineResult.providerModel,
        detectedIntent: response.detectedIntent,
        suggestedAction: response.nextAction,
        executedAction: isNous
          ? actionResult
          : shouldHandoff
            ? 'HUMAN_HANDOFF_CREATED_AND_MESSAGE_SENT'
            : response.nextAction === 'solicitar_cotizacion_humana'
              ? 'QUOTE_TASK_CREATED_AND_MESSAGE_SENT'
              : 'MESSAGE_SENT',
        outputValidation: 'passed',
        ...(isNous
          ? { proposalRejections: reviewedProposal?.rejections, actionResult }
          : {}),
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
    excludedMessageIds: string[],
  ) {
    const [recentMessages, state, lead, pendingTasks, completedTasks] =
      await Promise.all([
        this.prisma.message.findMany({
          where: { conversationId, NOT: { id: { in: excludedMessageIds } } },
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
        this.prisma.task.findMany({
          where: { conversationId, status: TaskStatus.COMPLETED },
          orderBy: { completedAt: 'desc' },
          take: 3,
          select: { type: true, completedAt: true },
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
      recentProfileChanges: this.recentProfileChanges(lead?.metadata),
      pendingActions: pendingTasks.map((task) => ({
        type: task.type,
        status: task.status,
        dueAt: task.dueAt?.toISOString(),
      })),
      recentCompletedActions: completedTasks.map((task) => ({
        type: task.type,
        completedAt: task.completedAt?.toISOString(),
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

  private async persistHermesIncident(
    conversationId: string,
    incident: HermesIncidentMetadata,
  ): Promise<void> {
    const current = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const existing =
      current?.metadata &&
      typeof current.metadata === 'object' &&
      !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: {
          ...existing,
          lastHermesIncident: incident,
        },
      },
    });
  }

  private async sendAndPersist(params: {
    conversationId: string;
    contactId: string;
    sourceMessageId: string;
    inboundWamid?: string | null;
    content: string;
    metadata: Record<string, unknown>;
    allowHandedOff: boolean;
  }) {
    await this.showTypingIndicator(params.inboundWamid);
    await this.deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId: params.conversationId,
      contactId: params.contactId,
      sourceMessageId: params.sourceMessageId,
      sender: 'SYSTEM',
      allowHandedOff: params.allowHandedOff,
      parts: [
        {
          partIndex: 0,
          content: params.content,
          metadata: params.metadata,
        },
      ],
    });
    return this.deliveries.deliverPreparedBatch(params.sourceMessageId);
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

  private logSkip(
    data: AutoReplyJobData,
    reason: string,
    details: Record<string, unknown> = {},
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'auto_reply_skipped',
        reason,
        conversationId: data.conversationId,
        correlationId: data.inboundMessageId,
        ...details,
      }),
    );
  }

  private async showTypingIndicator(
    inboundWamid?: string | null,
  ): Promise<void> {
    if (!inboundWamid) return;
    await this.meta.showTypingIndicator(inboundWamid);
  }

  private polishInitialGreeting(input: {
    reply: string;
    customerMessage: string;
    contactName: string;
  }): string {
    let reply = input.reply
      .replace(
        /\bbienvenid[oa]s?\s+a\s+under\s*code\s*ec\b\s*[,;.!]?\s*/giu,
        '',
      )
      .replace(/\s{2,}/gu, ' ')
      .replace(
        /([.!]\s+)¿?(en qué|a qué|cómo|cuál|cuándo)/giu,
        (_match, prefix: string, question: string) =>
          `${prefix}¿${question[0].toLocaleUpperCase('es')}${question.slice(1)}`,
      )
      .trim();
    if (!reply) reply = '¿En qué podemos ayudarle?';
    if (
      !/^(?:hola|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|buen\s+d[ií]a)[\s.!¡¿?]*$/iu.test(
        input.customerMessage.trim(),
      )
    )
      return reply;
    const firstName = input.contactName.trim().match(/[\p{L}\p{M}'-]+/u)?.[0];
    if (
      firstName &&
      !/^(?:cliente|contacto|undercodeec)$/iu.test(firstName) &&
      !reply
        .match(/[\p{L}\p{M}'-]+/gu)
        ?.some(
          (word) =>
            word.toLocaleLowerCase('es') === firstName.toLocaleLowerCase('es'),
        )
    ) {
      reply = reply.replace(
        /^(Buenas (?:tardes|noches)|Buenos d[ií]as|Buen d[ií]a|Hola)[.,!¡]?\s+/iu,
        (_match, greeting: string) => `${greeting}, ${firstName}. `,
      );
    }
    return reply;
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

  private recentProfileChanges(
    metadata: unknown,
  ): Array<Record<string, string>> {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      return [];
    const history = (metadata as Record<string, unknown>)
      .commercialProfileHistory;
    if (!Array.isArray(history)) return [];
    const safeKeys = new Set([
      'service',
      'sector',
      'need',
      'currentSituation',
      'users',
      'productCount',
      'paymentNeeds',
      'shippingNeeds',
      'inventoryNeeds',
      'domainStatus',
      'corporateEmailNeeds',
      'integrations',
      'budget',
      'timeline',
      'contactPreference',
      'lastObjection',
    ]);
    return history
      .slice(-3)
      .map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return {};
        const changes = (entry as Record<string, unknown>).changes;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes))
          return {};
        return Object.fromEntries(
          Object.entries(changes)
            .filter(
              ([key, value]) => safeKeys.has(key) && typeof value === 'string',
            )
            .map(([key, value]) => [key, (value as string).slice(0, 160)]),
        );
      })
      .filter((entry) => Object.keys(entry).length > 0);
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

  private containsUnbackedFollowupPromise(response: string): boolean {
    const normalized = response
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
    return (
      /\b(?:confirmaremos|revisaremos|contactaremos|responderemos)\b/.test(
        normalized,
      ) ||
      /\b(?:permita(?:me)?|voy a|vamos a)\b.{0,45}\b(?:consultar|revisar|confirmar)\b/.test(
        normalized,
      )
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

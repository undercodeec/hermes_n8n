import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationStatus,
  HandoffReason,
  MessageDirection,
  MessageSender,
  MessageType,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { HermesService } from '../hermes/hermes.service';
import { MetaService } from '../meta/meta.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';

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
    private readonly conversationGuard: ConversationGuardService,
    @InjectQueue(AUTO_REPLY_QUEUE)
    private readonly queue: Queue<AutoReplyJobData>,
  ) {}

  async enqueue(data: AutoReplyJobData, messageLength: number): Promise<void> {
    const delay = this.replyDelay(messageLength);
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
        conversationId: true,
        contactId: true,
      },
    });
    if (!inbound || inbound.conversationId !== data.conversationId) return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: data.conversationId },
      include: { contact: true },
    });
    if (!conversation || conversation.status === ConversationStatus.HANDED_OFF) {
      return;
    }

    // Si el cliente escribió de nuevo durante la pausa, el job más reciente
    // contestará con todo el contexto y este se descarta para no fragmentar el chat.
    if (await this.hasNewerInbound(data.conversationId, inbound.id)) return;

    if (!(await this.conversationGuard.consumeAiQuota(data.contactId))) {
      this.logger.warn(
        `Respuesta automática omitida por cuota de IA en conversación ${data.conversationId}`,
      );
      return;
    }

    const context = await this.buildConversationContext(
      data.contactId,
      data.conversationId,
    );
    const startedAt = Date.now();
    const response = await this.hermes.generateResponse({
      contactName: conversation.contact.name || 'Cliente',
      messageContent: inbound.content || '',
      conversationHistory: context.recentMessages,
      leadStage: context.leadStage,
      productOfInterest: context.productOfInterest,
      conversationSummary: context.conversationSummary,
    });

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
      currentConversation.status === ConversationStatus.HANDED_OFF ||
      (await this.hasNewerInbound(data.conversationId, inbound.id))
    ) {
      return;
    }

    const shouldHandoff = this.checkHandoffSignals(
      inbound.content || '',
      response.detectedIntent,
    );
    const sentMessage = await this.meta.sendTextMessage(
      conversation.contact.waId,
      response.response,
    );
    const latencyMs = Date.now() - startedAt;

    await this.prisma.message.create({
      data: {
        conversationId: data.conversationId,
        contactId: data.contactId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        type: MessageType.TEXT,
        content: response.response,
        wamid: sentMessage?.messages?.[0]?.id,
        tokensUsed: response.tokensUsed,
        latencyMs,
        costEstimate: response.costEstimate,
      },
    });
    await this.prisma.conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    });

    if (shouldHandoff) {
      await this.handoffs.create({
        conversationId: data.conversationId,
        reason: this.handoffReason(response.detectedIntent),
        reasonDetail: `Handoff automático. Mensaje trigger: ${(inbound.content || '').substring(0, 200)}`,
      });
    }

    if (response.suggestedTags || response.detectedIntent) {
      await this.prisma.conversationState.upsert({
        where: { conversationId: data.conversationId },
        update: {
          detectedIntent: response.detectedIntent,
          nextSuggestedAction: response.nextAction,
          commercialTags: response.suggestedTags || [],
        },
        create: {
          conversationId: data.conversationId,
          detectedIntent: response.detectedIntent,
          nextSuggestedAction: response.nextAction,
          commercialTags: response.suggestedTags || [],
        },
      });
    }

    if (this.shouldQualifyLead(response.detectedIntent)) {
      await this.leads.qualifyFromConversation({
        contactId: data.contactId,
        conversationId: data.conversationId,
        detectedIntent: response.detectedIntent,
        productOfInterest: context.productOfInterest,
      });
    }

    this.logger.log(
      `Respuesta automática enviada a ${conversation.contact.waId} en ${latencyMs}ms`,
    );
  }

  private replyDelay(messageLength: number): number {
    const isLong = messageLength >= this.positiveInteger(
      'AI_REPLY_LONG_MESSAGE_THRESHOLD',
      160,
    );
    const min = this.positiveInteger(
      isLong ? 'AI_REPLY_LONG_DELAY_MIN_MS' : 'AI_REPLY_DELAY_MIN_MS',
      isLong ? 4000 : 2000,
    );
    const max = Math.max(
      min,
      this.positiveInteger(
        isLong ? 'AI_REPLY_LONG_DELAY_MAX_MS' : 'AI_REPLY_DELAY_MAX_MS',
        isLong ? 8000 : 4000,
      ),
    );
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private async hasNewerInbound(
    conversationId: string,
    inboundMessageId: string,
  ): Promise<boolean> {
    const latest = await this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return Boolean(latest && latest.id !== inboundMessageId);
  }

  private async buildConversationContext(contactId: string, conversationId: string) {
    const [recentMessages, state, lead] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { direction: true, content: true },
      }),
      this.prisma.conversationState.findUnique({ where: { conversationId } }),
      this.prisma.lead.findFirst({
        where: { contactId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      recentMessages: recentMessages.reverse().map((message) => ({
        role: message.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
        content: message.content || '',
      })),
      conversationSummary: state?.summary || undefined,
      leadStage: lead?.stage || state?.leadStage || undefined,
      productOfInterest: lead?.productOfInterest || undefined,
    };
  }

  private checkHandoffSignals(message: string, detectedIntent?: string): boolean {
    const keywords = this.csvConfig('HANDOFF_KEYWORDS', [
      'hablar con humano', 'hablar con persona', 'agente real', 'quiero quejarme',
      'reclamo', 'estoy molesto', 'no funciona', 'descuento especial',
      'cotización compleja', 'precio corporativo',
    ]);
    const intents = this.csvConfig('HANDOFF_INTENTS', [
      'solicitud_humano', 'queja', 'reclamo', 'pago_fallido',
      'negociacion_especial', 'error',
    ]);
    const normalizedIntent = detectedIntent?.trim().toLocaleLowerCase('es');
    return keywords.some((keyword) => message.toLocaleLowerCase('es').includes(keyword)) ||
      Boolean(normalizedIntent && intents.includes(normalizedIntent));
  }

  private shouldQualifyLead(detectedIntent?: string): boolean {
    return Boolean(detectedIntent && this.csvConfig('LEAD_QUALIFICATION_INTENTS', [
      'consulta_precio', 'cotizacion', 'agendar_cita', 'pago',
    ]).includes(detectedIntent.trim().toLowerCase()));
  }

  private csvConfig(key: string, defaults: string[]): string[] {
    const configured = this.config.get<string>(key);
    return (configured ? configured.split(',') : defaults)
      .map((value) => value.trim().toLocaleLowerCase('es'))
      .filter(Boolean);
  }

  private handoffReason(detectedIntent?: string): HandoffReason {
    const intent = detectedIntent?.trim().toLocaleLowerCase('es');
    if (intent === 'queja' || intent === 'reclamo') return HandoffReason.COMPLAINT;
    if (intent === 'pago_fallido') return HandoffReason.PAYMENT_ISSUE;
    if (intent === 'negociacion_especial') return HandoffReason.B2B_NEGOTIATION;
    return HandoffReason.CUSTOM;
  }
}

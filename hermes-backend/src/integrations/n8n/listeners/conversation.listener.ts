import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { N8N_QUEUE } from '../n8n.constants';
import { ConversationHandoffRequestedEvent } from '../../../common/events/conversation.events';

/**
 * Listener de eventos de conversación. Toma el evento de dominio emitido en el
 * bus in-process y lo encola en BullMQ para que el processor lo despache a n8n.
 * Mismo patrón que `PingListener` (Etapa 1).
 */
@Injectable()
export class ConversationListener {
  constructor(@InjectQueue(N8N_QUEUE) private readonly queue: Queue) {}

  @OnEvent('conversation.handoff_requested', { async: true })
  async onHandoffRequested(
    evt: ConversationHandoffRequestedEvent,
  ): Promise<void> {
    await this.queue.add(
      'conversation.handoff_requested',
      {
        event: evt.name,
        version: evt.version,
        eventId: evt.eventId,
        occurredAt: evt.occurredAt,
        traceId: evt.traceId,
        data: {
          handoffId: evt.handoffId,
          conversationId: evt.conversationId,
          contactId: evt.contactId,
          reason: evt.reason,
          reasonDetail: evt.reasonDetail,
          assignedAgentId: evt.assignedAgentId,
        },
      },
      { jobId: evt.eventId }, // idempotencia: BullMQ rechaza jobId duplicado
    );
  }
}

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { N8N_QUEUE } from '../n8n.constants';
import {
  LeadQualifiedEvent,
  LeadCreatedEvent,
} from '../../../common/events/lead.events';

/**
 * Listener de eventos de lead. Toma el evento de dominio del bus in-process y lo
 * encola en BullMQ para que el processor lo despache a n8n. Mismo patrón que
 * `ConversationListener` (Etapa 2).
 */
@Injectable()
export class LeadListener {
  constructor(@InjectQueue(N8N_QUEUE) private readonly queue: Queue) {}

  @OnEvent('lead.qualified', { async: true })
  async onLeadQualified(evt: LeadQualifiedEvent): Promise<void> {
    await this.queue.add(
      'lead.qualified',
      {
        event: evt.name,
        version: evt.version,
        eventId: evt.eventId,
        occurredAt: evt.occurredAt,
        traceId: evt.traceId,
        data: {
          leadId: evt.leadId,
          contactId: evt.contactId,
          conversationId: evt.conversationId,
          score: evt.score,
          detectedIntent: evt.detectedIntent,
          productOfInterest: evt.productOfInterest,
          contactName: evt.contactName,
          waId: evt.waId,
          crmUrl: evt.crmUrl,
        },
      },
      { jobId: evt.eventId }, // idempotencia: BullMQ rechaza jobId duplicado
    );
  }

  @OnEvent('lead.created', { async: true })
  async onLeadCreated(evt: LeadCreatedEvent): Promise<void> {
    await this.queue.add(
      'lead.created',
      {
        event: evt.name,
        version: evt.version,
        eventId: evt.eventId,
        occurredAt: evt.occurredAt,
        traceId: evt.traceId,
        data: {
          leadId: evt.leadId,
          contactId: evt.contactId,
        },
      },
      { jobId: evt.eventId },
    );
  }
}

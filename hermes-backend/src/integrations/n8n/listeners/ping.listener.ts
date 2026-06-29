import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { N8N_QUEUE } from '../n8n.constants';
import { PingEvent } from '../../../common/events/ping.event';

/**
 * Listener del evento de prueba. Toma el PingEvent emitido en el bus
 * in-process y lo encola en BullMQ. Mismo patrón que tendrán los listeners
 * reales (lead, handoff, etc.) en las etapas siguientes.
 */
@Injectable()
export class PingListener {
  constructor(@InjectQueue(N8N_QUEUE) private readonly queue: Queue) {}

  @OnEvent('ping', { async: true })
  async onPing(evt: PingEvent): Promise<void> {
    await this.queue.add(
      'ping',
      {
        event: evt.name,
        version: evt.version,
        eventId: evt.eventId,
        occurredAt: evt.occurredAt,
        traceId: evt.traceId,
        data: { message: evt.message },
      },
      { jobId: evt.eventId }, // idempotencia: BullMQ rechaza jobId duplicado
    );
  }
}

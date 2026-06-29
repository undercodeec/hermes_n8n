import { DomainEvent } from './domain-event';

/**
 * Evento de prueba usado para validar la infraestructura de eventos de
 * punta a punta (emit → listener → BullMQ → dispatcher → n8n /webhook/ping)
 * sin tocar todavía ningún flujo de negocio real.
 *
 * Se dispara desde el endpoint temporal `POST /internal/test-event`.
 */
export class PingEvent extends DomainEvent {
  readonly name = 'ping';

  constructor(
    public readonly message: string = 'pong',
    traceId?: string,
  ) {
    super(traceId);
  }
}

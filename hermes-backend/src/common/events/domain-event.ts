import { randomUUID } from 'crypto';

/**
 * Clase base para todos los eventos de dominio.
 *
 * Cada evento lleva su propia identidad (`eventId`) y momento de ocurrencia
 * (`occurredAt`) para que puedan deduplicarse y ordenarse aguas abajo
 * (BullMQ, n8n, dashboard futuro). El `version` permite versionar el contrato
 * del payload sin romper consumidores.
 *
 * El `traceId` se propaga desde el request original (ver common/trace) para
 * poder seguir un evento de punta a punta a través de la cola y n8n.
 */
export abstract class DomainEvent {
  readonly eventId: string = randomUUID();
  readonly occurredAt: string = new Date().toISOString();
  readonly version: string = '1.0';

  /** Nombre canónico del evento, ej: 'lead.qualified'. */
  abstract readonly name: string;

  constructor(public readonly traceId?: string) {}
}

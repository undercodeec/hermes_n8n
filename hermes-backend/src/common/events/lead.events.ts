import { DomainEvent } from './domain-event';

/**
 * Se emite cuando un lead alcanza la etapa QUALIFIED, ya sea de forma automática
 * (detección de alta intención en el webhook, ver `LeadsService.qualifyFromConversation`)
 * o manual (cambio de stage vía API, `LeadsService.update`).
 *
 * `score` transporta `closeProbability` (0.0–1.0) del lead; hoy Hermes no calcula
 * un puntaje de cierre, así que suele venir en 0 y la calificación se decide por
 * `detectedIntent`. El día que Hermes devuelva un score, este campo lo refleja
 * sin cambios de contrato (ver §6.1 del plan).
 */
export class LeadQualifiedEvent extends DomainEvent {
  readonly name = 'lead.qualified';

  constructor(
    public readonly leadId: string,
    public readonly contactId: string,
    public readonly conversationId: string | null,
    public readonly score: number,
    public readonly detectedIntent?: string,
    public readonly productOfInterest?: string,
    public readonly contactName?: string,
    public readonly waId?: string,
    public readonly crmUrl?: string,
    traceId?: string,
  ) {
    super(traceId);
  }
}

/**
 * Se emite al crear un lead vía API. Criticidad baja: hoy no tiene workflow de
 * n8n asociado (el processor descarta el job si no hay path configurado), pero
 * se emite para dejar el punto de extensión listo (dashboard/WebSocket, §9.1).
 */
export class LeadCreatedEvent extends DomainEvent {
  readonly name = 'lead.created';

  constructor(
    public readonly leadId: string,
    public readonly contactId: string,
    traceId?: string,
  ) {
    super(traceId);
  }
}

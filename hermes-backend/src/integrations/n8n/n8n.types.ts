/**
 * Forma del payload que viaja a n8n. Es genérico: el `data` específico de
 * cada evento lo arman los listeners, no el dispatcher. n8n usa `eventId`
 * para deduplicar y `version` para versionar el contrato.
 */
export interface N8nEventPayload {
  event: string; // 'lead.qualified'
  version: string; // '1.0'
  eventId: string; // UUID
  occurredAt: string; // ISO 8601
  traceId?: string;
  data: Record<string, unknown>; // body específico del evento
}

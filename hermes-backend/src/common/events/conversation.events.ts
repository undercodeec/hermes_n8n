import { DomainEvent } from './domain-event';

/**
 * Se emite cuando una conversación se deriva a un humano, ya sea de forma
 * automática (detección de keywords en el webhook) o manual (API de handoff).
 *
 * Punto de emisión ÚNICO: `HandoffService.create`. El webhook ya no escribe el
 * handoff directo a Prisma; llama al service, que crea el registro y emite este
 * evento. Así un solo lugar cubre handoff automático y manual (ver §6.3 / §9.4
 * del plan).
 */
export class ConversationHandoffRequestedEvent extends DomainEvent {
  readonly name = 'conversation.handoff_requested';

  constructor(
    public readonly handoffId: string,
    public readonly conversationId: string,
    public readonly contactId: string | null,
    public readonly reason: string,
    public readonly reasonDetail?: string,
    public readonly assignedAgentId?: string,
    traceId?: string,
  ) {
    super(traceId);
  }
}

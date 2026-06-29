import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Resuelve el path del webhook de n8n para cada evento, leyendo del `.env`.
 * Si un evento no tiene path configurado, `resolveWebhookPath` devuelve
 * `undefined` y el processor lo descarta sin reintentar.
 */
@Injectable()
export class N8nConfig {
  private readonly map: Record<string, string | undefined>;

  constructor(private readonly cfg: ConfigService) {
    this.map = {
      // Evento de prueba (Etapa 1). Fallback al path del workflow dummy.
      ping: this.cfg.get('N8N_WEBHOOK_PING') ?? '/webhook/ping',

      'lead.qualified': this.cfg.get('N8N_WEBHOOK_LEAD_QUALIFIED'),
      'conversation.handoff_requested': this.cfg.get(
        'N8N_WEBHOOK_HANDOFF_REQUESTED',
      ),
      'conversation.stalled': this.cfg.get('N8N_WEBHOOK_CONVERSATION_STALLED'),
      'task.followup_due': this.cfg.get('N8N_WEBHOOK_TASK_FOLLOWUP_DUE'),
      'quote.requested': this.cfg.get('N8N_WEBHOOK_QUOTE_REQUESTED'),
      'payment.intent_detected': this.cfg.get('N8N_WEBHOOK_PAYMENT_INTENT'),
    };
  }

  resolveWebhookPath(eventName: string): string | undefined {
    return this.map[eventName];
  }
}

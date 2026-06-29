import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios from 'axios';
import { N8nEventPayload } from './n8n.types';

/**
 * Capa de transporte hacia n8n. Responsabilidad única: firmar el body con
 * HMAC, hacer el POST con timeout y loguear. Si falla, lanza el error para que
 * BullMQ reintente con backoff. No conoce nada de eventos de dominio.
 */
@Injectable()
export class N8nDispatcher {
  private readonly logger = new Logger(N8nDispatcher.name);

  constructor(private readonly config: ConfigService) {}

  async dispatch(webhookPath: string, payload: N8nEventPayload): Promise<void> {
    const baseUrl = this.config.getOrThrow<string>('N8N_BASE_URL');
    const secret = this.config.getOrThrow<string>('N8N_HMAC_SECRET');
    const timeoutMs = Number(
      this.config.get('N8N_DISPATCH_TIMEOUT_MS') ?? 5000,
    );

    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    try {
      await axios.post(`${baseUrl}${webhookPath}`, payload, {
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Signature': `sha256=${signature}`,
          'X-Hermes-Event': payload.event,
          'X-Hermes-Event-Id': payload.eventId,
          'X-Hermes-Trace-Id': payload.traceId ?? '',
        },
      });
      this.logger.log(`Dispatched ${payload.event} (${payload.eventId})`);
    } catch (err: any) {
      this.logger.error(
        `Dispatch failed for ${payload.event} (${payload.eventId}): ${err.message}`,
      );
      throw err; // dejar que BullMQ reintente
    }
  }
}

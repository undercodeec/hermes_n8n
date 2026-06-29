import {
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { timingSafeEqual } from 'crypto';
import { PingEvent } from '../../common/events/ping.event';

/**
 * Controller temporal de Etapa 1 para validar la infraestructura de eventos
 * end-to-end. Emite un PingEvent al bus → PingListener lo encola → processor
 * lo dispatcha al workflow dummy `/webhook/ping` de n8n.
 *
 * Está protegido por un token compartido (`N8N_CALLBACK_TOKEN`) en el header
 * `X-Internal-Token`: el endpoint queda detrás del reverse proxy público y los
 * logs muestran bots escaneando rutas, así que no puede quedar abierto.
 *
 * TODO: eliminar este controller una vez validada la Etapa 1.
 */
@ApiTags('Integrations')
@Controller('internal')
export class N8nTestController {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly cls: ClsService,
    private readonly config: ConfigService,
  ) {}

  @Post('test-event')
  @ApiOperation({ summary: 'Emite un PingEvent de prueba hacia n8n (Etapa 1)' })
  @ApiHeader({ name: 'X-Internal-Token', required: true })
  emitTestEvent(@Headers('x-internal-token') token?: string): {
    emitted: boolean;
    eventId: string;
    traceId?: string;
  } {
    this.assertAuthorized(token);

    const traceId = this.cls.get<string>('traceId');
    const event = new PingEvent('pong', traceId);
    this.emitter.emit(event.name, event);
    return { emitted: true, eventId: event.eventId, traceId };
  }

  /** Compara el token recibido contra `N8N_CALLBACK_TOKEN` en tiempo constante. */
  private assertAuthorized(token?: string): void {
    const expected = this.config.getOrThrow<string>('N8N_CALLBACK_TOKEN');
    // Fail-closed: nunca autorizar si el secreto no está configurado (vacío o
    // débil) o si no llega token. `getOrThrow` no protege contra string vacío.
    if (!token || expected.length < 16) {
      throw new UnauthorizedException('Invalid or missing internal token');
    }
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid or missing internal token');
    }
  }
}

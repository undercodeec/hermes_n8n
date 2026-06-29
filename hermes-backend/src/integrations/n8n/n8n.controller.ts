import { Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { PingEvent } from '../../common/events/ping.event';

/**
 * Controller temporal de Etapa 1 para validar la infraestructura de eventos
 * end-to-end. Emite un PingEvent al bus → PingListener lo encola → processor
 * lo dispatcha al workflow dummy `/webhook/ping` de n8n.
 *
 * TODO: eliminar (o proteger con guard) una vez validada la Etapa 1.
 */
@ApiTags('Integrations')
@Controller('internal')
export class N8nTestController {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly cls: ClsService,
  ) {}

  @Post('test-event')
  @ApiOperation({ summary: 'Emite un PingEvent de prueba hacia n8n (Etapa 1)' })
  emitTestEvent(): { emitted: boolean; eventId: string; traceId?: string } {
    const traceId = this.cls.get<string>('traceId');
    const event = new PingEvent('pong', traceId);
    this.emitter.emit(event.name, event);
    return { emitted: true, eventId: event.eventId, traceId };
  }
}

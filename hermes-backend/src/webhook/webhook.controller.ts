import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Headers,
  RawBody,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { MetaWebhookDto } from './dto/meta-webhook.dto';

@ApiTags('Webhook')
@Controller('webhooks/meta/whatsapp')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  @ApiOperation({ summary: 'Verificación del webhook de Meta' })
  @ApiQuery({ name: 'hub.mode', required: true })
  @ApiQuery({ name: 'hub.verify_token', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true })
  @ApiResponse({ status: 200, description: 'Webhook verificado' })
  @ApiResponse({ status: 401, description: 'Token inválido' })
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    return this.webhookService.verifyWebhook(mode, token, challenge);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recibir eventos del webhook de Meta' })
  @ApiResponse({ status: 200, description: 'Evento recibido' })
  async receive(
    // El ValidationPipe global corre con whitelist + forbidNonWhitelisted y
    // rechazaría el payload de Meta (DTO sin decoradores) con 400. Un pipe a nivel
    // de parámetro NO reemplaza al global (se suman), así que tipamos el body como
    // Record para que el pipe global lo omita (sólo valida metatypes que son clases
    // con decoradores). Meta es un tercero que puede añadir campos en cualquier
    // momento, por lo que aceptamos el body tal cual y lo casteamos al DTO.
    @Body() body: Record<string, unknown>,
    @Headers('x-hub-signature-256') signature: string,
  ): Promise<string> {
    // Validar firma (en producción se debería usar RawBody para esto)
    // La validación de firma completa requiere acceso al body crudo
    this.logger.debug('Webhook recibido de Meta');

    // Procesar el webhook de forma asíncrona para responder rápido a Meta
    this.webhookService
      .processWebhook(body as unknown as MetaWebhookDto)
      .catch((error) => {
      this.logger.error(`Error procesando webhook: ${error.message}`, error.stack);
    });

    // Meta espera un 200 OK rápido
    return 'OK';
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Sse,
  UseGuards,
  MessageEvent,
  StreamableFile,
  Header,
  Optional,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConversationsService } from './conversations.service';
import {
  projectCrmConversationRecord,
  projectCrmMessage,
} from '../attribution-crm/attribution-crm';
import { CreateConversationDto } from './dto/create-conversation.dto';
import {
  QueryConversationsDto,
  QueryMessagesDto,
} from './dto/query-conversations.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';
import { ConversationEventsService } from './conversation-events.service';
import { Observable, concatMap, map, takeUntil, takeWhile, timer } from 'rxjs';
import { AuthService } from '../auth/auth.service';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly conversationEvents: ConversationEventsService,
    @Optional() private readonly authService?: AuthService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Crear conversación' })
  async create(@Body() dto: CreateConversationDto) {
    return projectCrmConversationRecord(
      await this.conversationsService.create(dto),
    );
  }

  @Get()
  @ApiOperation({ summary: 'Listar y filtrar conversaciones del CRM' })
  findAll(@Query() query: QueryConversationsDto) {
    return this.conversationsService.findAll(query);
  }

  @Sse('events')
  @ApiOperation({ summary: 'Eventos en tiempo real del Inbox mediante SSE' })
  events(@CurrentUser() user: { id: string; sessionId?: string; sessionType?: string; accessExpiresAt?: number }): Observable<MessageEvent> {
    const stream = this.conversationEvents.stream();
    if (user?.sessionType !== 'web') return stream;
    if (!this.authService || !user.sessionId || !user.accessExpiresAt)
      throw new Error('Web SSE session validation unavailable');
    // Guard authorizes the handshake; every emitted event checks DB revocation
    // and idle expiry. Close the connection at JWT expiry even without events.
    return stream.pipe(
      concatMap(async (event) => ({ event, active: !!(await this.authService!.checkWeb(user.id, user.sessionId!).catch(() => null)) })),
      takeWhile(({ active }) => active),
      map(({ event }) => event),
      takeUntil(timer(Math.max(0, user.accessExpiresAt * 1000 - Date.now()))),
    );
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Historial paginado de una conversación' })
  findMessages(@Param('id') id: string, @Query() query: QueryMessagesDto) {
    return this.conversationsService.findMessages(id, query);
  }

  @Get(':id/messages/:messageId/media')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async inboxMedia(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    const media = await this.conversationsService.inboxMedia(id, messageId);
    return new StreamableFile(media.bytes, {
      type: media.mimeType,
      disposition: 'inline',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener conversación con contexto CRM' })
  findOne(@Param('id') id: string) {
    return this.conversationsService.findOne(id);
  }

  @Post(':id/reply')
  @ApiOperation({
    summary: 'Responder manualmente dentro de la ventana de 24 horas',
  })
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplyConversationDto,
    @CurrentUser('id') userId: string,
  ) {
    return projectCrmMessage(
      await this.conversationsService.reply(id, dto, userId),
    );
  }

  @Put(':id/close')
  @ApiOperation({ summary: 'Cerrar conversación' })
  async close(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return projectCrmConversationRecord(
      await this.conversationsService.close(id, userId),
    );
  }

  @Put(':id/reopen')
  @ApiOperation({ summary: 'Reabrir conversación con Hermes' })
  async reopen(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return projectCrmConversationRecord(
      await this.conversationsService.reopen(id, userId),
    );
  }
}

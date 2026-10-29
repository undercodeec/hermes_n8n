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
import { Observable } from 'rxjs';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly conversationEvents: ConversationEventsService,
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
  events(): Observable<MessageEvent> {
    return this.conversationEvents.stream();
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

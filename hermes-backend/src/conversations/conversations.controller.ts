import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import {
  QueryConversationsDto,
  QueryMessagesDto,
} from './dto/query-conversations.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear conversación' })
  create(@Body() dto: CreateConversationDto) {
    return this.conversationsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar y filtrar conversaciones del CRM' })
  findAll(@Query() query: QueryConversationsDto) {
    return this.conversationsService.findAll(query);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Historial paginado de una conversación' })
  findMessages(@Param('id') id: string, @Query() query: QueryMessagesDto) {
    return this.conversationsService.findMessages(id, query);
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
  reply(
    @Param('id') id: string,
    @Body() dto: ReplyConversationDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.conversationsService.reply(id, dto, userId);
  }

  @Put(':id/close')
  @ApiOperation({ summary: 'Cerrar conversación' })
  close(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.conversationsService.close(id, userId);
  }
}

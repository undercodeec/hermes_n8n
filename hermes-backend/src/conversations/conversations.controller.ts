import {
  Controller, Get, Post, Put, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ReplyConversationDto } from './dto/reply-conversation.dto';
import { ConversationStatus } from '@prisma/client';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear conversación' })
  create(@Body() dto: CreateConversationDto) {
    return this.conversationsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar conversaciones' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ConversationStatus })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: ConversationStatus,
  ) {
    return this.conversationsService.findAll(page || 1, limit || 20, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener conversación con mensajes' })
  findOne(@Param('id') id: string) {
    return this.conversationsService.findOne(id);
  }

  @Post(':id/reply')
  @ApiOperation({ summary: 'Responder manualmente a una conversación' })
  reply(@Param('id') id: string, @Body() dto: ReplyConversationDto) {
    return this.conversationsService.reply(id, dto);
  }

  @Put(':id/close')
  @ApiOperation({ summary: 'Cerrar conversación' })
  close(@Param('id') id: string) {
    return this.conversationsService.close(id);
  }
}

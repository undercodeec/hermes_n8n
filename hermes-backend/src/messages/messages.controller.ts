import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MessagesService } from './messages.service';

@ApiTags('Messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('conversation/:conversationId')
  @ApiOperation({ summary: 'Listar mensajes de una conversación' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findByConversation(
    @Param('conversationId') conversationId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.messagesService.findByConversation(conversationId, page || 1, limit || 50);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener mensaje por ID' })
  findOne(@Param('id') id: string) {
    return this.messagesService.findOne(id);
  }
}

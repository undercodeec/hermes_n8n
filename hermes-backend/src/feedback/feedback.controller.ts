import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackService } from './feedback.service';

@ApiTags('Feedback')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  @ApiOperation({ summary: 'Valorar una respuesta confirmada de Hermes' })
  create(@Body() dto: CreateFeedbackDto, @CurrentUser('id') userId: string) {
    return this.feedback.create(dto, userId);
  }

  @Get('conversation/:conversationId')
  @ApiOperation({ summary: 'Feedback y resumen de una conversación' })
  forConversation(@Param('conversationId') conversationId: string) {
    return this.feedback.forConversation(conversationId);
  }
}

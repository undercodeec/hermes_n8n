import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConversationReviewService } from './conversation-review.service';
import { LearningDecisionDto } from './dto/learning-decision.dto';
import { ReviewCanaryTriggerDto } from './dto/review-canary-trigger.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Learning')
@ApiBearerAuth()
@Controller('api/learning')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class LearningController {
  constructor(private readonly reviews: ConversationReviewService) {}

  @Post('reviews/canary')
  @ApiOperation({
    summary:
      'ADMIN: solicitar una revisión manual de un feedback BAD autorizado para canary',
  })
  triggerCanary(
    @Body() dto: ReviewCanaryTriggerDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.reviews.triggerCanary(dto, userId);
  }

  @Get('candidates')
  candidates() {
    return this.reviews.listCandidates();
  }

  @Post('candidates/:id/decision')
  decide(
    @Param('id') id: string,
    @Body() dto: LearningDecisionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.reviews.decide(id, dto, userId);
  }
}

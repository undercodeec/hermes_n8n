import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ConversationReviewService } from './conversation-review.service';

@Controller('api/learning')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class LearningController {
  constructor(private readonly reviews: ConversationReviewService) {}

  @Get('candidates')
  candidates() {
    return this.reviews.listCandidates();
  }
}

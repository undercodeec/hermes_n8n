import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConversationReviewService } from './conversation-review.service';
import { LearningController } from './learning.controller';
import { LEARNING_REVIEW_QUEUE } from './learning.constants';
import { LearningProcessor } from './learning.processor';
import { ReviewModelService } from './review-model.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: LEARNING_REVIEW_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 3600, count: 500 },
        removeOnFail: false,
      },
    }),
  ],
  controllers: [LearningController],
  providers: [ConversationReviewService, ReviewModelService, LearningProcessor],
  exports: [ConversationReviewService],
})
export class LearningModule {}

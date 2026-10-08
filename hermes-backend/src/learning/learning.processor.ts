import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ConversationReviewService } from './conversation-review.service';
import { LEARNING_REVIEW_QUEUE, ReviewJobData } from './learning.constants';

@Processor(LEARNING_REVIEW_QUEUE, { concurrency: 1 })
export class LearningProcessor extends WorkerHost {
  constructor(private readonly reviews: ConversationReviewService) {
    super();
  }
  process(job: Job<ReviewJobData>): Promise<void> {
    return this.reviews.process(job.data.reviewId);
  }
}

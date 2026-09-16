import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { AutoReplyService } from './auto-reply.service';

@Processor(AUTO_REPLY_QUEUE)
export class AutoReplyProcessor extends WorkerHost {
  constructor(private readonly autoReplies: AutoReplyService) {
    super();
  }

  async process(job: Job<AutoReplyJobData>): Promise<void> {
    await this.autoReplies.process(job.data);
  }
}

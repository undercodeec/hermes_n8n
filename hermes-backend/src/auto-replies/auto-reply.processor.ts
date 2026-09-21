import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AUTO_REPLY_QUEUE, AutoReplyJobData } from './auto-reply.constants';
import { AutoReplyService } from './auto-reply.service';

@Processor(AUTO_REPLY_QUEUE)
export class AutoReplyProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoReplyProcessor.name);

  constructor(private readonly autoReplies: AutoReplyService) {
    super();
  }

  async process(job: Job<AutoReplyJobData>): Promise<void> {
    await this.autoReplies.process(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<AutoReplyJobData> | undefined, error: Error): void {
    this.logger.error(
      JSON.stringify({
        event: 'auto_reply_job_failed',
        jobId: job?.id,
        conversationId: job?.data.conversationId,
        correlationId: job?.data.inboundMessageId,
        attemptsMade: job?.attemptsMade ?? 0,
        maxAttempts: job?.opts.attempts ?? 1,
        error: error.message,
      }),
    );
  }
}

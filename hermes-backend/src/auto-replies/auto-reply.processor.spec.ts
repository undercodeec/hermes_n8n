import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AutoReplyJobData } from './auto-reply.constants';
import { AutoReplyProcessor } from './auto-reply.processor';
import { AutoReplyService } from './auto-reply.service';

describe('AutoReplyProcessor observability', () => {
  it('records a failed queue attempt with its conversation correlation', () => {
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const processor = new AutoReplyProcessor({} as AutoReplyService);
    const job = {
      id: 'auto-reply-inbound-1',
      attemptsMade: 3,
      opts: { attempts: 3 },
      data: {
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-1',
      },
    };

    processor.onFailed(
      job as unknown as Job<AutoReplyJobData>,
      new Error('Meta no pudo enviar el mensaje'),
    );

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0][0] as string)).toEqual({
      event: 'auto_reply_job_failed',
      jobId: 'auto-reply-inbound-1',
      conversationId: 'conversation-1',
      correlationId: 'inbound-1',
      attemptsMade: 3,
      maxAttempts: 3,
      error: 'Meta no pudo enviar el mensaje',
    });
  });
});

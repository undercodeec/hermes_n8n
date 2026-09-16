import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutoReplyService } from './auto-reply.service';
import { AutoReplyProcessor } from './auto-reply.processor';
import { AUTO_REPLY_QUEUE } from './auto-reply.constants';
import { HermesModule } from '../hermes/hermes.module';
import { MetaModule } from '../meta/meta.module';
import { HandoffModule } from '../handoff/handoff.module';
import { LeadsModule } from '../leads/leads.module';
import { ConversationGuardModule } from '../conversation-guard/conversation-guard.module';

@Module({
  imports: [
    HermesModule,
    MetaModule,
    HandoffModule,
    LeadsModule,
    ConversationGuardModule,
    BullModule.registerQueue({
      name: AUTO_REPLY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1500, jitter: 0.25 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    }),
  ],
  providers: [AutoReplyService, AutoReplyProcessor],
  exports: [AutoReplyService],
})
export class AutoReplyModule {}

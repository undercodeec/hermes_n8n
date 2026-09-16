import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MetaModule } from '../meta/meta.module';
import { HermesModule } from '../hermes/hermes.module';
import { HandoffModule } from '../handoff/handoff.module';
import { LeadsModule } from '../leads/leads.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AutoReplyModule } from '../auto-replies/auto-reply.module';
import { ConversationGuardModule } from '../conversation-guard/conversation-guard.module';

@Module({
  imports: [
    MetaModule,
    HermesModule,
    HandoffModule,
    LeadsModule,
    CampaignsModule,
    AutoReplyModule,
    ConversationGuardModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}

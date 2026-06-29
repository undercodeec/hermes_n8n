import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MetaModule } from '../meta/meta.module';
import { HermesModule } from '../hermes/hermes.module';
import { HandoffModule } from '../handoff/handoff.module';

@Module({
  imports: [MetaModule, HermesModule, HandoffModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}

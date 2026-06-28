import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MetaModule } from '../meta/meta.module';
import { HermesModule } from '../hermes/hermes.module';

@Module({
  imports: [MetaModule, HermesModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}

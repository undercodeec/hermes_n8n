import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MetaModule } from '../meta/meta.module';
import { ConversationEventsService } from './conversation-events.service';

@Module({
  imports: [MetaModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationEventsService],
  exports: [ConversationsService, ConversationEventsService],
})
export class ConversationsModule {}

import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MetaModule } from '../meta/meta.module';
import { ConversationEventsService } from './conversation-events.service';
import { MobileReplyController } from './mobile-reply.controller';
import { MobileReplyService } from './mobile-reply.service';

@Module({
  imports: [MetaModule],
  controllers: [ConversationsController, MobileReplyController],
  providers: [
    ConversationsService,
    ConversationEventsService,
    MobileReplyService,
  ],
  exports: [ConversationsService, ConversationEventsService],
})
export class ConversationsModule {}

import { Module } from '@nestjs/common';
import { ConversationGuardService } from './conversation-guard.service';

@Module({
  providers: [ConversationGuardService],
  exports: [ConversationGuardService],
})
export class ConversationGuardModule {}

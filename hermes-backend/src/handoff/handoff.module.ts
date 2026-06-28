import { Module } from '@nestjs/common';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';

@Module({
  controllers: [HandoffController],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}

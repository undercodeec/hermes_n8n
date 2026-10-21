import { Module } from '@nestjs/common';
import { BackupRunner } from './backup-runner.service';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

@Module({
  controllers: [RetentionController],
  providers: [BackupRunner, RetentionService],
})
export class RetentionModule {}

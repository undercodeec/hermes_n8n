import { Module } from '@nestjs/common';
import { HermesService } from './hermes.service';

@Module({
  providers: [HermesService],
  exports: [HermesService],
})
export class HermesModule {}

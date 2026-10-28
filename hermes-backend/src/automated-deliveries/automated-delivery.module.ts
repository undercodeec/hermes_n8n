import { Module } from '@nestjs/common';
import { MetaModule } from '../meta/meta.module';
import { TasksModule } from '../tasks/tasks.module';
import { AutomatedDeliveryService } from './automated-delivery.service';

@Module({
  imports: [MetaModule, TasksModule],
  providers: [AutomatedDeliveryService],
  exports: [AutomatedDeliveryService],
})
export class AutomatedDeliveryModule {}

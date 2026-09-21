import { Module } from '@nestjs/common';
import { MetaModule } from '../meta/meta.module';
import { AutomatedDeliveryService } from './automated-delivery.service';

@Module({
  imports: [MetaModule],
  providers: [AutomatedDeliveryService],
  exports: [AutomatedDeliveryService],
})
export class AutomatedDeliveryModule {}

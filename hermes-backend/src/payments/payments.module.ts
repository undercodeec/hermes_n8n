import { Module } from '@nestjs/common';
import { AutomatedDeliveryModule } from '../automated-deliveries/automated-delivery.module';
import { LeadsModule } from '../leads/leads.module';
import {
  BankAccountsController,
  TransfersController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { TransferIntentPolicy } from './transfer-intent.policy';

@Module({
  imports: [AutomatedDeliveryModule, LeadsModule],
  controllers: [BankAccountsController, TransfersController],
  providers: [PaymentsService, TransferIntentPolicy],
  exports: [PaymentsService],
})
export class PaymentsModule {}

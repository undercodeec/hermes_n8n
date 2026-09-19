import { Module } from '@nestjs/common';
import { HermesService } from './hermes.service';
import { CommercialPolicyService } from './commercial-policy.service';

@Module({
  providers: [HermesService, CommercialPolicyService],
  exports: [HermesService, CommercialPolicyService],
})
export class HermesModule {}

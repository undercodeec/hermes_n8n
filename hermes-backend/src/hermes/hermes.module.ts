import { Module } from '@nestjs/common';
import { HermesService } from './hermes.service';
import { CommercialPolicyService } from './commercial-policy.service';
import { CommercialAuthorityService } from './commercial-authority.service';

@Module({
  providers: [
    HermesService,
    CommercialPolicyService,
    CommercialAuthorityService,
  ],
  exports: [HermesService, CommercialPolicyService, CommercialAuthorityService],
})
export class HermesModule {}

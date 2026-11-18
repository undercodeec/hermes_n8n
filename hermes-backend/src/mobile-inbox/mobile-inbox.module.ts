import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MobileInboxController } from './mobile-inbox.controller';
import { MobileInboxGuard } from './mobile-inbox.guard';
import { MobileInboxService } from './mobile-inbox.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [MobileInboxController],
  providers: [MobileInboxGuard, MobileInboxService],
})
export class MobileInboxModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { TasksModule } from '../../tasks/tasks.module';
import { LeadsModule } from '../../leads/leads.module';
import { GoogleCalendarService } from './google-calendar.service';
import { MeetingOperationsService } from './meeting-operations.service';
import { MeetingsService } from './meetings.service';
import { MeetingRecoveryService } from './meeting-recovery.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleOAuthController } from './google-oauth.controller';
import { AutomatedDeliveryModule } from '../../automated-deliveries/automated-delivery.module';

@Module({
  imports: [PrismaModule, TasksModule, LeadsModule, AutomatedDeliveryModule],
  controllers: [GoogleOAuthController],
  providers: [
    GoogleCalendarService,
    MeetingOperationsService,
    MeetingsService,
    MeetingRecoveryService,
    GoogleOAuthService,
  ],
  exports: [MeetingsService, GoogleCalendarService],
})
export class GoogleCalendarModule {}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { QueryMeetingsDto } from './dto/query-meetings.dto';
import { MeetingReadService } from './meeting-read.service';

@ApiTags('Meetings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/meetings')
export class MeetingsController {
  constructor(private readonly meetingRead: MeetingReadService) {}

  @Get()
  @ApiOperation({ summary: 'Listar reuniones para el calendario CRM' })
  list(@Query() query: QueryMeetingsDto) {
    return this.meetingRead.listForCrm(query);
  }
}

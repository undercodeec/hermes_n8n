import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AcquisitionService } from './acquisition.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/analytics/acquisition')
export class AcquisitionController {
  constructor(private readonly acquisition: AcquisitionService) {}

  @Get()
  @ApiOperation({
    summary:
      'Origen comprobado de conversaciones WhatsApp y conversiones verificadas',
  })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.acquisition.summary(from, to);
  }
}

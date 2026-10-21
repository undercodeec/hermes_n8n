import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RetentionService } from './retention.service';

@ApiTags('Retention and recovery')
@ApiBearerAuth()
@Controller('api/admin/retention-recovery-policy')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class RetentionController {
  constructor(private readonly service: RetentionService) {}

  @Get()
  get() {
    return this.service.get();
  }

  @Put()
  update(
    @Body() body: Record<string, unknown>,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.update(body, userId);
  }

  @Post('rotation-preview')
  preview(@Body() body: Record<string, unknown>) {
    return this.service.preview(body);
  }

  @Post('backup')
  backup() {
    return this.service.backupNow();
  }

  @Post('restore-check')
  restore() {
    return this.service.restoreNow();
  }
}

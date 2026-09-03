import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService, private readonly campaignsService: CampaignsService) {}

  @Get('crm-overview')
  @ApiOperation({
    summary: 'Resumen CRM: observados, calificados, abiertos y handoffs',
  })
  getCrmOverview() {
    return this.analyticsService.getCrmOverview();
  }

  @Get('funnel')
  @ApiOperation({ summary: 'Distribución del funnel de leads' })
  getFunnel() {
    return this.analyticsService.getFunnelDistribution();
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Métricas de conversaciones' })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Fecha inicio (ISO)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'Fecha fin (ISO)',
  })
  getConversations(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getConversationMetrics(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('response-times')
  @ApiOperation({ summary: 'Tiempos medios de respuesta' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  getResponseTimes(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getAverageResponseTime(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('costs')
  @ApiOperation({ summary: 'Métricas de costos' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  getCosts(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.getCostMetrics(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'Rendimiento por campaña' })
  getCampaigns() {
    return this.campaignsService.getPerformance();
  }
}

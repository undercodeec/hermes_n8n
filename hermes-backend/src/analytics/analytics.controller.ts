import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('funnel')
  @ApiOperation({ summary: 'Distribución del funnel de leads' })
  getFunnel() {
    return this.analyticsService.getFunnelDistribution();
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Métricas de conversaciones' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'Fecha inicio (ISO)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'Fecha fin (ISO)' })
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
    return this.analyticsService.getCampaignPerformance();
  }
}

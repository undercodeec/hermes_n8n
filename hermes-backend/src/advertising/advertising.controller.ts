import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdvertisingService } from './advertising.service';
import { AttributionRegistrationGuard } from './attribution-registration.guard';
import { GoogleAdsReportingService } from './google-ads-reporting.service';
import {
  AdvertisingDateRangeDto,
  CreateContactIntentDto,
  RecordCommercialEventDto,
  RevokeAdvertisingConsentDto,
  SyncMetricsDto,
  UpdateAdvertisingIntegrationDto,
  UpsertConversionMappingDto,
} from './dto/advertising.dto';

@ApiTags('Advertising attribution')
@Controller('api/advertising/contact-intents')
export class AttributionIntentsController {
  constructor(private readonly advertising: AdvertisingService) {}

  @Post()
  @UseGuards(AttributionRegistrationGuard)
  @ApiHeader({ name: 'X-Hermes-Attribution-Key', required: true })
  @ApiOperation({
    summary: 'Create an opaque, expiring WhatsApp attribution reference',
  })
  create(@Body() dto: CreateContactIntentDto) {
    return this.advertising.createContactIntent(dto);
  }
}

@ApiTags('Advertising and attribution')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/advertising')
export class AdvertisingController {
  constructor(
    private readonly advertising: AdvertisingService,
    private readonly reporting: GoogleAdsReportingService,
  ) {}

  @Get('dashboard')
  dashboard(@Query() query: AdvertisingDateRangeDto) {
    return this.advertising.getDashboard(
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
  }

  @Get('status')
  status() {
    return this.advertising.getIntegrationStatus();
  }

  @Put('integration')
  @Roles(UserRole.ADMIN)
  updateIntegration(@Body() dto: UpdateAdvertisingIntegrationDto) {
    return this.advertising.updateIntegration(dto);
  }

  @Get('mappings')
  mappings() {
    return this.advertising.listMappings();
  }

  @Put('mappings')
  @Roles(UserRole.ADMIN)
  upsertMapping(@Body() dto: UpsertConversionMappingDto) {
    return this.advertising.upsertMapping(dto);
  }

  @Post('leads/:id/events')
  recordEvent(
    @Param('id') leadId: string,
    @Body() dto: RecordCommercialEventDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.advertising.recordOperatorEvent(leadId, dto, userId);
  }

  @Get('leads/:id/history')
  leadHistory(@Param('id') leadId: string) {
    return this.advertising.getLeadHistory(leadId);
  }

  @Post('contacts/:id/revoke')
  @Roles(UserRole.ADMIN)
  revoke(
    @Param('id') contactId: string,
    @Body() dto: RevokeAdvertisingConsentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.advertising.revokeContact(contactId, dto.reason, userId);
  }

  @Get('metrics')
  metrics(@Query() query: SyncMetricsDto) {
    return this.reporting.list(query.from, query.to);
  }

  @Post('metrics/sync')
  @Roles(UserRole.ADMIN)
  syncMetrics(@Body() dto: SyncMetricsDto) {
    return this.reporting.sync(dto.from, dto.to);
  }
}

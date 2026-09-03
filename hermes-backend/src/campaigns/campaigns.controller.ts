import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignSourceDto } from './dto/create-campaign-source.dto';
import { CreateAdsMetadataDto } from './dto/create-ads-metadata.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { ImportCampaignContactsDto } from './dto/import-campaign-contacts.dto';
import { CampaignQueryDto } from './dto/campaign-query.dto';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  // Existing acquisition attribution routes are evaluated before :id.
  @Post('sources') createSource(@Body() dto: CreateCampaignSourceDto) { return this.campaigns.createSource(dto); }
  @Get('sources') findAllSources(@Query() query: CampaignQueryDto) { return this.campaigns.findAllSources(query.page, query.limit); }
  @Get('sources/:id') findOneSource(@Param('id') id: string) { return this.campaigns.findOneSource(id); }
  @Post('ads-metadata') createAdsMetadata(@Body() dto: CreateAdsMetadataDto) { return this.campaigns.createAdsMetadata(dto); }
  @Get('ads-metadata') findAllAdsMetadata(@Query('campaignSourceId') campaignSourceId?: string) { return this.campaigns.findAllAdsMetadata(campaignSourceId); }

  @Get('templates') @ApiOperation({ summary: 'List approved WhatsApp templates from the configured WABA' })
  templates() { return this.campaigns.getTemplates(); }
  @Get() @ApiOperation({ summary: 'List official WhatsApp campaigns' })
  findAll(@Query() query: CampaignQueryDto) { return this.campaigns.findAll(query.page, query.limit); }
  @Post() @ApiOperation({ summary: 'Create a draft official WhatsApp campaign' })
  create(@Body() dto: CreateCampaignDto, @CurrentUser() user: { id: string }) { return this.campaigns.createCampaign(dto, user); }
  @Get(':id') @ApiOperation({ summary: 'Get official WhatsApp campaign' })
  findOne(@Param('id') id: string) { return this.campaigns.findOne(id); }
  @Get(':id/recipients') @ApiOperation({ summary: 'List campaign recipients' })
  recipients(@Param('id') id: string, @Query() query: CampaignQueryDto) { return this.campaigns.findRecipients(id, query.page, query.limit); }
  @Post(':id/contacts') @ApiOperation({ summary: 'Import a validated JSON contact batch; maximum 500 rows' })
  importContacts(@Param('id') id: string, @Body() dto: ImportCampaignContactsDto, @CurrentUser() user: { id: string }) { return this.campaigns.importContacts(id, dto.contacts, user); }
  @Post(':id/start') @ApiOperation({ summary: 'Explicitly enqueue a campaign; never sends inside this request' })
  start(@Param('id') id: string, @CurrentUser() user: { id: string }) { return this.campaigns.start(id, user); }
  @Post(':id/pause') pause(@Param('id') id: string, @CurrentUser() user: { id: string }) { return this.campaigns.pause(id, user); }
  @Post(':id/resume') resume(@Param('id') id: string, @CurrentUser() user: { id: string }) { return this.campaigns.resume(id, user); }
  @Post(':id/cancel') cancel(@Param('id') id: string, @CurrentUser() user: { id: string }) { return this.campaigns.cancel(id, user); }
}

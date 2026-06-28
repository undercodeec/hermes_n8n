import {
  Controller, Get, Post, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignSourceDto } from './dto/create-campaign-source.dto';
import { CreateAdsMetadataDto } from './dto/create-ads-metadata.dto';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Post('sources')
  @ApiOperation({ summary: 'Crear fuente de campaña' })
  createSource(@Body() dto: CreateCampaignSourceDto) {
    return this.campaignsService.createSource(dto);
  }

  @Get('sources')
  @ApiOperation({ summary: 'Listar fuentes de campaña' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllSources(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.campaignsService.findAllSources(page || 1, limit || 20);
  }

  @Get('sources/:id')
  @ApiOperation({ summary: 'Obtener fuente de campaña por ID' })
  findOneSource(@Param('id') id: string) {
    return this.campaignsService.findOneSource(id);
  }

  @Post('ads-metadata')
  @ApiOperation({ summary: 'Crear metadata de anuncio' })
  createAdsMetadata(@Body() dto: CreateAdsMetadataDto) {
    return this.campaignsService.createAdsMetadata(dto);
  }

  @Get('ads-metadata')
  @ApiOperation({ summary: 'Listar metadata de anuncios' })
  @ApiQuery({ name: 'campaignSourceId', required: false, type: String })
  findAllAdsMetadata(@Query('campaignSourceId') campaignSourceId?: string) {
    return this.campaignsService.findAllAdsMetadata(campaignSourceId);
  }
}

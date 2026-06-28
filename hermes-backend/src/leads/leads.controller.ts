import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadStage } from '@prisma/client';

@ApiTags('Leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear lead' })
  @ApiResponse({ status: 201, description: 'Lead creado' })
  create(@Body() dto: CreateLeadDto) {
    return this.leadsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar leads' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'stage', required: false, enum: LeadStage })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('stage') stage?: LeadStage,
  ) {
    return this.leadsService.findAll(page || 1, limit || 20, stage);
  }

  @Get('funnel')
  @ApiOperation({ summary: 'Distribución del funnel de leads' })
  getFunnel() {
    return this.leadsService.getFunnelDistribution();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener lead por ID' })
  findOne(@Param('id') id: string) {
    return this.leadsService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar lead' })
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto) {
    return this.leadsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar lead' })
  remove(@Param('id') id: string) {
    return this.leadsService.remove(id);
  }
}

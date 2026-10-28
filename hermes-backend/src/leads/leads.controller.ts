import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { QueryLeadsDto } from './dto/query-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { CorrectLeadStageDto } from './dto/correct-lead-stage.dto';

@ApiTags('Leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear lead' })
  @ApiResponse({ status: 201, description: 'Lead creado' })
  async create(@Body() dto: CreateLeadDto) {
    const created = await this.leadsService.create(dto);
    return this.leadsService.findOne(created.id);
  }

  @Get()
  @ApiOperation({ summary: 'Listar leads' })
  findAll(@Query() query: QueryLeadsDto) {
    return this.leadsService.findAll(query);
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
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentUser('id') userId: string,
  ) {
    await this.leadsService.update(id, dto, userId);
    return this.leadsService.findOne(id);
  }

  @Post(':id/correct-stage')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Corregir etapa comercial con auditoría administrativa',
  })
  @ApiResponse({ status: 201, description: 'Corrección registrada' })
  async correctStage(
    @Param('id') id: string,
    @Body() dto: CorrectLeadStageDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.leadsService.correctStage(id, dto, userId);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Eliminar lead' })
  async remove(@Param('id') id: string) {
    const removed = await this.leadsService.remove(id);
    return { id: removed.id };
  }
}

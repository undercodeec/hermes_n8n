import {
  Controller, Get, Post, Put, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { HandoffService } from './handoff.service';
import { CreateHandoffDto } from './dto/create-handoff.dto';
import { HandoffStatus } from '@prisma/client';

@ApiTags('Handoff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/handoff')
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Post()
  @ApiOperation({ summary: 'Crear handoff (escalar a humano)' })
  create(@Body() dto: CreateHandoffDto) {
    return this.handoffService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar handoffs' })
  @ApiQuery({ name: 'status', required: false, enum: HandoffStatus })
  findAll(@Query('status') status?: HandoffStatus) {
    return this.handoffService.findAll(status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener handoff por ID' })
  findOne(@Param('id') id: string) {
    return this.handoffService.findOne(id);
  }

  @Put(':id/assign')
  @ApiOperation({ summary: 'Asignar agente a handoff' })
  assign(@Param('id') id: string, @Body('agentId') agentId: string) {
    return this.handoffService.assign(id, agentId);
  }

  @Put(':id/resolve')
  @ApiOperation({ summary: 'Resolver handoff' })
  resolve(@Param('id') id: string, @Body('resolution') resolution: string) {
    return this.handoffService.resolve(id, resolution);
  }
}

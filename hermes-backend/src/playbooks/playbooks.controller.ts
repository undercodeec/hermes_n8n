import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlaybooksService } from './playbooks.service';
import { CreatePlaybookDto } from './dto/create-playbook.dto';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';
import { PlaybookType } from '@prisma/client';

@ApiTags('Playbooks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/playbooks')
export class PlaybooksController {
  constructor(private readonly playbooksService: PlaybooksService) {}

  @Post()
  @ApiOperation({ summary: 'Crear playbook de ventas' })
  create(@Body() dto: CreatePlaybookDto) {
    return this.playbooksService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar playbooks' })
  @ApiQuery({ name: 'type', required: false, enum: PlaybookType })
  findAll(@Query('type') type?: PlaybookType) {
    return this.playbooksService.findAll(type);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener playbook por ID' })
  findOne(@Param('id') id: string) {
    return this.playbooksService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar playbook' })
  update(@Param('id') id: string, @Body() dto: UpdatePlaybookDto) {
    return this.playbooksService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar playbook' })
  remove(@Param('id') id: string) {
    return this.playbooksService.remove(id);
  }
}

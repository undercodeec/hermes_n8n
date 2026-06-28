import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { KnowledgeService } from './knowledge.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentType } from '@prisma/client';

@ApiTags('Knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post('documents')
  @ApiOperation({ summary: 'Crear documento de conocimiento' })
  create(@Body() dto: CreateDocumentDto) {
    return this.knowledgeService.create(dto);
  }

  @Get('documents')
  @ApiOperation({ summary: 'Listar documentos' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'type', required: false, enum: DocumentType })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('type') type?: DocumentType,
  ) {
    return this.knowledgeService.findAll(page || 1, limit || 20, type);
  }

  @Get('search')
  @ApiOperation({ summary: 'Buscar documentos por contenido' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'type', required: false, enum: DocumentType })
  search(@Query('q') query: string, @Query('type') type?: DocumentType) {
    return this.knowledgeService.search(query, type);
  }

  @Get('documents/:id')
  @ApiOperation({ summary: 'Obtener documento por ID' })
  findOne(@Param('id') id: string) {
    return this.knowledgeService.findOne(id);
  }

  @Put('documents/:id')
  @ApiOperation({ summary: 'Actualizar documento' })
  update(@Param('id') id: string, @Body() dto: UpdateDocumentDto) {
    return this.knowledgeService.update(id, dto);
  }

  @Delete('documents/:id')
  @ApiOperation({ summary: 'Eliminar documento' })
  remove(@Param('id') id: string) {
    return this.knowledgeService.remove(id);
  }
}

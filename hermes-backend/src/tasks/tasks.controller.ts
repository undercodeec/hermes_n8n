import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TaskStatus } from '@prisma/client';

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: 'Crear tarea' })
  create(@Body() dto: CreateTaskDto) {
    return this.tasksService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar tareas' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: TaskStatus })
  @ApiQuery({ name: 'assignedUserId', required: false, type: String })
  findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: TaskStatus,
    @Query('assignedUserId') assignedUserId?: string,
  ) {
    return this.tasksService.findAll(page || 1, limit || 20, status, assignedUserId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener tarea por ID' })
  findOne(@Param('id') id: string) {
    return this.tasksService.findOne(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar tarea' })
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar tarea' })
  remove(@Param('id') id: string) {
    return this.tasksService.remove(id);
  }
}

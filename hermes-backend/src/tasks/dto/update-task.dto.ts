import { PartialType } from '@nestjs/swagger';
import { CreateTaskDto } from './create-task.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';
import { TaskStatus } from '@prisma/client';

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional({ description: 'Estado de la tarea', enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;
}

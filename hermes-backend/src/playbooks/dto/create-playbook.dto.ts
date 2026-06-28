import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNumber, IsArray } from 'class-validator';
import { PlaybookType } from '@prisma/client';

export class CreatePlaybookDto {
  @ApiProperty({ description: 'Título del playbook', example: 'Manejo de objeción de precio' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Contenido del guión' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Tipo de playbook', enum: PlaybookType })
  @IsOptional()
  @IsEnum(PlaybookType)
  type?: PlaybookType;

  @ApiPropertyOptional({ description: 'Triggers/condiciones para activar', type: [String] })
  @IsOptional()
  @IsArray()
  triggers?: string[];

  @ApiPropertyOptional({ description: 'Prioridad (mayor = más importante)', default: 0 })
  @IsOptional()
  @IsNumber()
  priority?: number;
}

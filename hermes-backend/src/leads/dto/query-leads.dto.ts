import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeadStage } from '@prisma/client';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class QueryLeadsDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Nombre, teléfono, WhatsApp ID, producto o intención',
  })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ enum: LeadStage })
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @ApiPropertyOptional({ description: 'Intención detectada por Hermes' })
  @IsOptional()
  @IsString()
  intent?: string;

  @ApiPropertyOptional({ description: 'Fecha inicial ISO-8601' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Fecha final ISO-8601' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por handoff abierto',
    type: Boolean,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  hasHandoff?: boolean;

  @ApiPropertyOptional({
    description: 'Filtrar por existencia de respuesta automática de Hermes',
    type: Boolean,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  hermesReplied?: boolean;
}

function toOptionalBoolean({ value, obj, key }: TransformFnParams): unknown {
  const source = obj as Record<string, unknown>;
  const rawValue: unknown = source[key] ?? (value as unknown);
  if (rawValue === true || rawValue === 'true') return true;
  if (rawValue === false || rawValue === 'false') return false;
  return rawValue;
}

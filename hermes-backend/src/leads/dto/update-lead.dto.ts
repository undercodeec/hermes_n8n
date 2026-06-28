import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { LeadStage } from '@prisma/client';

export class UpdateLeadDto {
  @ApiPropertyOptional({ description: 'Etapa del funnel', enum: LeadStage })
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @ApiPropertyOptional({ description: 'Score del lead (0-100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  score?: number;

  @ApiPropertyOptional({ description: 'Producto de interés' })
  @IsOptional()
  @IsString()
  productOfInterest?: string;

  @ApiPropertyOptional({ description: 'Presupuesto estimado' })
  @IsOptional()
  @IsNumber()
  estimatedBudget?: number;

  @ApiPropertyOptional({ description: 'Última objeción detectada' })
  @IsOptional()
  @IsString()
  lastObjection?: string;

  @ApiPropertyOptional({ description: 'Próxima acción' })
  @IsOptional()
  @IsString()
  nextAction?: string;

  @ApiPropertyOptional({ description: 'Probabilidad de cierre (0-1)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  closeProbability?: number;

  @ApiPropertyOptional({ description: 'Razón de pérdida' })
  @IsOptional()
  @IsString()
  lostReason?: string;
}

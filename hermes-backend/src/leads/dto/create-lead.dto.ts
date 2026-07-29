import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNumber } from 'class-validator';
import { LeadStage } from '@prisma/client';

export class CreateLeadDto {
  @ApiProperty({ description: 'ID del contacto' })
  @IsString()
  contactId: string;

  @ApiPropertyOptional({ description: 'Etapa del funnel', enum: LeadStage })
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @ApiPropertyOptional({ description: 'Producto de interés' })
  @IsOptional()
  @IsString()
  productOfInterest?: string;

  @ApiPropertyOptional({ description: 'Presupuesto estimado' })
  @IsOptional()
  @IsNumber()
  estimatedBudget?: number;

  @ApiPropertyOptional({ description: 'ID de la fuente de campaña' })
  @IsOptional()
  @IsString()
  campaignSourceId?: string;

  @ApiPropertyOptional({
    description: 'Conversación principal de la nueva oportunidad',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;
}

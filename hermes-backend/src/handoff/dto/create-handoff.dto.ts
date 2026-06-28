import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { HandoffReason } from '@prisma/client';

export class CreateHandoffDto {
  @ApiProperty({ description: 'ID de la conversación' })
  @IsString()
  conversationId: string;

  @ApiProperty({ description: 'Razón del handoff', enum: HandoffReason })
  @IsEnum(HandoffReason)
  reason: HandoffReason;

  @ApiPropertyOptional({ description: 'Detalle adicional de la razón' })
  @IsOptional()
  @IsString()
  reasonDetail?: string;

  @ApiPropertyOptional({ description: 'ID del agente a asignar' })
  @IsOptional()
  @IsString()
  assignedAgentId?: string;
}

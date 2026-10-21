import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ReviewCanaryTriggerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  feedbackId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Clave estable para reintentos administrativos',
  })
  @IsUUID()
  requestKey: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'ID del review FAILED histórico; requerido para autorizar una segunda evaluación independiente',
  })
  @IsOptional()
  @IsUUID()
  recanaryOfReviewId?: string;
}

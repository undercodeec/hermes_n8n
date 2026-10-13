import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

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
}

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class MobileReplyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Mismo UUID que Idempotency-Key',
  })
  @IsUUID()
  operationId: string;

  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  content: string;
}

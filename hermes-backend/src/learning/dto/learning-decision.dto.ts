import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum LearningDecisionAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  RETIRE = 'RETIRE',
}

export class LearningDecisionDto {
  @ApiProperty({ enum: LearningDecisionAction })
  @IsEnum(LearningDecisionAction)
  action: LearningDecisionAction;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: 'Vencimiento ISO 8601 requerido al aprobar',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string;
}

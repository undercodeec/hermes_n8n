import { ApiProperty } from '@nestjs/swagger';
import { LeadStage } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum LeadStageCorrectionReasonCode {
  TEST_CORRECTION = 'TEST_CORRECTION',
  DATA_ENTRY_ERROR = 'DATA_ENTRY_ERROR',
  BUSINESS_REASSESSMENT = 'BUSINESS_REASSESSMENT',
  OTHER = 'OTHER',
}

export class CorrectLeadStageDto {
  @ApiProperty({ enum: LeadStage })
  @IsEnum(LeadStage)
  targetStage: LeadStage;

  @ApiProperty({ enum: LeadStage })
  @IsEnum(LeadStage)
  expectedCurrentStage: LeadStage;

  @ApiProperty({ enum: LeadStageCorrectionReasonCode })
  @IsEnum(LeadStageCorrectionReasonCode)
  reasonCode: LeadStageCorrectionReasonCode;

  @ApiProperty({ minLength: 8, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(500)
  reason: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  requestKey: string;
}

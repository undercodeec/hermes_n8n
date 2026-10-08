import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeedbackRating, FeedbackReasonCode } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateFeedbackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId: string;

  @ApiProperty({ enum: FeedbackRating })
  @IsEnum(FeedbackRating)
  rating: FeedbackRating;

  @ApiPropertyOptional({ enum: FeedbackReasonCode })
  @IsOptional()
  @IsEnum(FeedbackReasonCode)
  reasonCode?: FeedbackReasonCode;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  suggestedReply?: string;

  @ApiProperty({ format: 'uuid', description: 'Clave estable para reintentos' })
  @IsUUID()
  requestKey: string;
}

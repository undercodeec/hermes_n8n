import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ConversationStatus } from '@prisma/client';

export class CreateConversationDto {
  @ApiProperty({ description: 'ID del contacto' })
  @IsString()
  contactId: string;

  @ApiPropertyOptional({ description: 'Canal', default: 'whatsapp' })
  @IsOptional()
  @IsString()
  channel?: string;
}

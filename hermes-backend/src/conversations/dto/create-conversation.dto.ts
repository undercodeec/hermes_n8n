import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class CreateConversationDto {
  @ApiProperty({ description: 'ID del contacto' })
  @IsString()
  contactId: string;

  @ApiPropertyOptional({ description: 'Canal', default: 'whatsapp' })
  @IsOptional()
  @IsString()
  channel?: string;
}

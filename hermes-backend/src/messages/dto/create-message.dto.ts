import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { MessageDirection, MessageType } from '@prisma/client';

export class CreateMessageDto {
  @ApiProperty({ description: 'ID de la conversación' })
  @IsString()
  conversationId: string;

  @ApiProperty({ description: 'ID del contacto' })
  @IsString()
  contactId: string;

  @ApiProperty({ description: 'Dirección del mensaje', enum: MessageDirection })
  @IsEnum(MessageDirection)
  direction: MessageDirection;

  @ApiPropertyOptional({ description: 'Tipo de mensaje', enum: MessageType })
  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType;

  @ApiPropertyOptional({ description: 'Contenido del mensaje' })
  @IsOptional()
  @IsString()
  content?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ReplyConversationDto {
  @ApiProperty({ description: 'Contenido de la respuesta manual' })
  @IsString()
  content: string;
}

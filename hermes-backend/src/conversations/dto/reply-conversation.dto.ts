import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReplyConversationDto {
  @ApiProperty({ description: 'Contenido de la respuesta manual' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  content: string;
}

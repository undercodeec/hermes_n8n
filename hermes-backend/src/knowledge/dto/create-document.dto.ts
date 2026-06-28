import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray } from 'class-validator';
import { DocumentType } from '@prisma/client';

export class CreateDocumentDto {
  @ApiProperty({ description: 'Título del documento', example: 'FAQ General' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Contenido del documento' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Tipo de documento', enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiPropertyOptional({ description: 'Tags para búsqueda', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

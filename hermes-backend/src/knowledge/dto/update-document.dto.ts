import { PartialType } from '@nestjs/swagger';
import { CreateDocumentDto } from './create-document.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean } from 'class-validator';

export class UpdateDocumentDto extends PartialType(CreateDocumentDto) {
  @ApiPropertyOptional({ description: 'Estado activo/inactivo' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

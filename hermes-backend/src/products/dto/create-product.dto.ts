import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ description: 'Nombre del producto', example: 'Plan Premium' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Descripción' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Categoría' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'SKU' })
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiPropertyOptional({ description: 'URL de imagen' })
  @IsOptional()
  @IsString()
  imageUrl?: string;
}

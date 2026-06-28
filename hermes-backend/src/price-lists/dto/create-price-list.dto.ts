import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsDateString } from 'class-validator';

export class CreatePriceListDto {
  @ApiProperty({ description: 'ID del producto' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Nombre de la lista de precios', example: 'Precio general' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Precio', example: 99.99 })
  @IsNumber()
  price: number;

  @ApiPropertyOptional({ description: 'Moneda', default: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Fecha de inicio de vigencia' })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({ description: 'Fecha de fin de vigencia' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ description: 'Restricciones' })
  @IsOptional()
  @IsString()
  restrictions?: string;

  @ApiPropertyOptional({ description: 'Notas' })
  @IsOptional()
  @IsString()
  notes?: string;
}

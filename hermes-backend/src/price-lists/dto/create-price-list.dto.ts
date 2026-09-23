import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
} from '@prisma/client';

export class CreatePriceListDto {
  @ApiProperty({ description: 'ID del producto' })
  @IsString()
  productId: string;

  @ApiProperty({
    description: 'Nombre de la lista de precios',
    example: 'Precio general',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Importe; omitir para QUOTE_REQUIRED',
    example: 99.99,
  })
  @IsOptional()
  @IsNumber()
  price?: number | null;

  @ApiPropertyOptional({
    enum: CommercialMarket,
    description: 'Mercado concreto; omitirlo para una tarifa global',
    nullable: true,
  })
  @IsOptional()
  @IsEnum(CommercialMarket)
  market?: CommercialMarket | null;

  @ApiPropertyOptional({ enum: CommercialPriceType })
  @IsOptional()
  @IsEnum(CommercialPriceType)
  priceType?: CommercialPriceType;

  @ApiPropertyOptional({ enum: CommercialTaxMode })
  @IsOptional()
  @IsEnum(CommercialTaxMode)
  taxMode?: CommercialTaxMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  taxLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  taxRatePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  policyVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPromotion?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supersedesPriceListId?: string;

  @ApiPropertyOptional({ description: 'Moneda', default: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Fecha de inicio de vigencia' })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({
    description: 'Fecha de fin de vigencia',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  validUntil?: string | null;

  @ApiPropertyOptional({ description: 'Restricciones' })
  @IsOptional()
  @IsString()
  restrictions?: string;

  @ApiPropertyOptional({ description: 'Notas' })
  @IsOptional()
  @IsString()
  notes?: string;
}

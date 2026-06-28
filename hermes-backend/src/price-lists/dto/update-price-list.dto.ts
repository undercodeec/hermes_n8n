import { PartialType } from '@nestjs/swagger';
import { CreatePriceListDto } from './create-price-list.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean } from 'class-validator';

export class UpdatePriceListDto extends PartialType(CreatePriceListDto) {
  @ApiPropertyOptional({ description: 'Estado activo/inactivo' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

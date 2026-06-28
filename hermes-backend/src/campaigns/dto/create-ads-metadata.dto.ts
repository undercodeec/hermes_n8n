import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber } from 'class-validator';

export class CreateAdsMetadataDto {
  @ApiProperty({ description: 'ID de la fuente de campaña' })
  @IsString()
  campaignSourceId: string;

  @ApiPropertyOptional({ description: 'Meta Ad ID' })
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiPropertyOptional({ description: 'Meta Adset ID' })
  @IsOptional()
  @IsString()
  adsetId?: string;

  @ApiPropertyOptional({ description: 'Meta Campaign ID' })
  @IsOptional()
  @IsString()
  campaignId?: string;

  @ApiPropertyOptional({ description: 'Nombre del anuncio' })
  @IsOptional()
  @IsString()
  adName?: string;

  @ApiPropertyOptional({ description: 'Gasto del anuncio' })
  @IsOptional()
  @IsNumber()
  spend?: number;

  @ApiPropertyOptional({ description: 'Impresiones' })
  @IsOptional()
  @IsNumber()
  impressions?: number;

  @ApiPropertyOptional({ description: 'Clicks' })
  @IsOptional()
  @IsNumber()
  clicks?: number;
}

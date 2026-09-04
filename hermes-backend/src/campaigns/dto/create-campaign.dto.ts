import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateCampaignDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @Length(1, 160)
  name: string;

  @ApiProperty({ maxLength: 512 })
  @IsString()
  @Length(1, 512)
  templateName: string;

  @ApiProperty({ example: 'es' })
  @IsString()
  @Matches(/^[a-z]{2,3}([_-][A-Z]{2})?$/)
  templateLanguage: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  templateCategory?: string;

  @ApiPropertyOptional({ description: 'Video selected from the Hermes campaign media library' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  headerVideoAssetId?: string;

  @ApiPropertyOptional({ description: 'Meta media ID for a video header' })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  headerVideoMediaId?: string;

  @ApiPropertyOptional({ description: 'HTTPS video URL; host must be allow-listed server-side' })
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  headerVideoUrl?: string;
}

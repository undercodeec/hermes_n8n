import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class CreateCampaignSourceDto {
  @ApiPropertyOptional({ description: 'UTM Source', example: 'facebook' })
  @IsOptional()
  @IsString()
  utmSource?: string;

  @ApiPropertyOptional({ description: 'UTM Medium', example: 'cpc' })
  @IsOptional()
  @IsString()
  utmMedium?: string;

  @ApiPropertyOptional({ description: 'UTM Campaign', example: 'promo_junio' })
  @IsOptional()
  @IsString()
  utmCampaign?: string;

  @ApiPropertyOptional({ description: 'UTM Term' })
  @IsOptional()
  @IsString()
  utmTerm?: string;

  @ApiPropertyOptional({ description: 'UTM Content' })
  @IsOptional()
  @IsString()
  utmContent?: string;

  @ApiPropertyOptional({ description: 'Landing page URL' })
  @IsOptional()
  @IsString()
  landingPage?: string;

  @ApiPropertyOptional({ description: 'Canal de entrada', default: 'whatsapp' })
  @IsOptional()
  @IsString()
  entryChannel?: string;

  @ApiPropertyOptional({ description: 'Primer mensaje del contacto' })
  @IsOptional()
  @IsString()
  firstMessage?: string;
}

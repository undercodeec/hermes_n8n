import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CAMPAIGN_IMPORT_MAX_ROWS } from '../campaigns.constants';

export class CampaignContactImportRowDto {
  @ApiProperty()
  @IsString()
  @Length(1, 160)
  nombre: string;

  @ApiProperty()
  @IsString()
  @Length(1, 64)
  telefono: string;

  @IsOptional()
  @IsString()
  @Length(0, 32)
  consentimiento?: string;
}

export class ImportCampaignContactsDto {
  @ApiProperty({ type: [CampaignContactImportRowDto], maxItems: CAMPAIGN_IMPORT_MAX_ROWS })
  @IsArray()
  @ArrayMaxSize(CAMPAIGN_IMPORT_MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => CampaignContactImportRowDto)
  contacts: CampaignContactImportRowDto[];
}

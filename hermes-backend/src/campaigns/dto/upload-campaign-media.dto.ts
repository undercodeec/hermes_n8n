import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class UploadCampaignMediaDto {
  @ApiPropertyOptional({ description: 'Friendly name shown in the CRM media library' })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  name?: string;
}

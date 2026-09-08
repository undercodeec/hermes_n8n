import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class ConfigureTemplateMediaDto {
  @ApiProperty()
  @IsString()
  @Length(1, 128)
  templateId: string;

  @ApiProperty()
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
  campaignMediaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  mediaUrl?: string;
}

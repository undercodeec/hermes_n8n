import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RegisterCampaignMediaDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @Length(1, 160)
  name: string;

  @ApiProperty({ description: 'Existing WhatsApp Cloud API Media ID' })
  @IsString()
  @Length(1, 256)
  metaMediaId: string;
}

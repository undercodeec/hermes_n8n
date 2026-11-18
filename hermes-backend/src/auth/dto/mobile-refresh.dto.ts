import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class MobileRefreshDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  refreshToken: string;
}

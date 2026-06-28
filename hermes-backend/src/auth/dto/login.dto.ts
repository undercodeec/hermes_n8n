import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Email del usuario', example: 'admin@hermes.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Contraseña' })
  @IsString()
  password: string;
}

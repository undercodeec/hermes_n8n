import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({ description: 'Email del usuario', example: 'admin@hermes.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Contraseña', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ description: 'Nombre del usuario', example: 'Admin Hermes' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Rol del usuario', enum: UserRole, default: UserRole.SALES_AGENT })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

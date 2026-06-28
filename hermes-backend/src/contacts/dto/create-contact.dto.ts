import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEmail } from 'class-validator';

export class CreateContactDto {
  @ApiProperty({ description: 'WhatsApp ID (número de teléfono)', example: '5491155556666' })
  @IsString()
  waId: string;

  @ApiPropertyOptional({ description: 'Teléfono', example: '+5491155556666' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Nombre del contacto', example: 'Juan Pérez' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Email', example: 'juan@empresa.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Empresa' })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiPropertyOptional({ description: 'Cargo' })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiPropertyOptional({ description: 'Notas' })
  @IsOptional()
  @IsString()
  notes?: string;
}

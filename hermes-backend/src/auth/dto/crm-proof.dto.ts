import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CrmProofDto {
  @ApiProperty({
    description:
      'Prueba de acceso de corta duración firmada por el backend Admin de Undercodeec',
  })
  @IsString()
  @MaxLength(2048)
  proof: string;

  @ApiPropertyOptional({ description: 'Refresh web vigente para reexchange sin crear otra sesión; no renueva inactividad' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  existingRefreshToken?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CrmProofDto {
  @ApiProperty({
    description:
      'Prueba de acceso de corta duración firmada por el backend Admin de Undercodeec',
  })
  @IsString()
  @MaxLength(2048)
  proof: string;
}

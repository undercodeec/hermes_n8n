import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export enum HandoffResolutionAction {
  RETURN_TO_HERMES = 'RETURN_TO_HERMES',
  CLOSE_CONVERSATION = 'CLOSE_CONVERSATION',
  KEEP_HUMAN = 'KEEP_HUMAN',
}

export class AssignHandoffDto {
  @ApiPropertyOptional({
    description:
      'Agente que toma el handoff. Si se omite, se usa el usuario autenticado.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  agentId?: string;
}

export class ResolveHandoffDto {
  @ApiProperty({ description: 'Detalle de la resolución' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  resolution: string;

  @ApiProperty({ enum: HandoffResolutionAction })
  @IsEnum(HandoffResolutionAction)
  action: HandoffResolutionAction;
}

import { PartialType } from '@nestjs/swagger';
import { CreatePlaybookDto } from './create-playbook.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean } from 'class-validator';

export class UpdatePlaybookDto extends PartialType(CreatePlaybookDto) {
  @ApiPropertyOptional({ description: 'Estado activo/inactivo' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

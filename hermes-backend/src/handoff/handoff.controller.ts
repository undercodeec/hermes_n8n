import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { HandoffStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateHandoffDto } from './dto/create-handoff.dto';
import { AssignHandoffDto, ResolveHandoffDto } from './dto/handoff-actions.dto';
import { HandoffService } from './handoff.service';

@ApiTags('Handoff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/handoff')
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Post()
  @ApiOperation({ summary: 'Crear handoff idempotente' })
  create(@Body() dto: CreateHandoffDto, @CurrentUser('id') userId: string) {
    return this.handoffService.create(dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'Listar handoffs' })
  @ApiQuery({ name: 'status', required: false, enum: HandoffStatus })
  findAll(@Query('status') status?: HandoffStatus) {
    return this.handoffService.findAll(status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener handoff por ID' })
  findOne(@Param('id') id: string) {
    return this.handoffService.findOne(id);
  }

  @Put(':id/take')
  @ApiOperation({ summary: 'Tomar el handoff y marcarlo en progreso' })
  take(
    @Param('id') id: string,
    @Body() dto: AssignHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.handoffService.assign(id, dto.agentId ?? userId, userId);
  }

  @Put(':id/assign')
  @ApiOperation({ summary: 'Asignar agente y marcar el handoff en progreso' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.handoffService.assign(id, dto.agentId ?? userId, userId);
  }

  @Put(':id/resolve')
  @ApiOperation({
    summary: 'Resolver, cerrar, devolver a Hermes o mantener control humano',
  })
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.handoffService.resolve(id, dto, userId);
  }
}

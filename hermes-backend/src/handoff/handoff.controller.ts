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
import { projectCrmHandoff } from '../attribution-crm/attribution-crm';

@ApiTags('Handoff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
@Controller('api/handoff')
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Post()
  @ApiOperation({ summary: 'Crear handoff idempotente' })
  async create(
    @Body() dto: CreateHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return projectCrmHandoff(await this.handoffService.create(dto, userId));
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
  async take(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return projectCrmHandoff(
      await this.handoffService.assign(id, userId, userId),
    );
  }

  @Put(':id/assign')
  @ApiOperation({ summary: 'Asignar agente y marcar el handoff en progreso' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return projectCrmHandoff(
      await this.handoffService.assign(id, dto.agentId ?? userId, userId),
    );
  }

  @Put(':id/resolve')
  @ApiOperation({
    summary: 'Resolver, cerrar, devolver a Hermes o mantener control humano',
  })
  async resolve(
    @Param('id') id: string,
    @Body() dto: ResolveHandoffDto,
    @CurrentUser('id') userId: string,
  ) {
    return projectCrmHandoff(
      await this.handoffService.resolve(id, dto, userId),
    );
  }
}

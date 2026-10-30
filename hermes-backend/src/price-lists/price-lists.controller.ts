import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { PriceListsService } from './price-lists.service';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpdatePriceListDto } from './dto/update-price-list.dto';

@ApiTags('Price Lists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/price-lists')
export class PriceListsController {
  constructor(private readonly priceListsService: PriceListsService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Crear lista de precios' })
  create(@Body() dto: CreatePriceListDto) {
    return this.priceListsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar listas de precios' })
  @ApiQuery({ name: 'productId', required: false, type: String })
  findAll(@Query('productId') productId?: string) {
    return this.priceListsService.findAll(productId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener lista de precios por ID' })
  findOne(@Param('id') id: string) {
    return this.priceListsService.findOne(id);
  }

  @Get(':id/audit')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Consultar auditoría de una tarifa' })
  audit(@Param('id') id: string) {
    return this.priceListsService.audit(id);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Actualizar lista de precios' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePriceListDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.priceListsService.update(id, dto, userId);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Eliminar lista de precios' })
  remove(@Param('id') id: string) {
    return this.priceListsService.remove(id);
  }
}

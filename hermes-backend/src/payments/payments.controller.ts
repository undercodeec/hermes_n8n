import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import {
  ApproveTransferDto,
  RejectTransferDto,
} from './dto/transfer-decision.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/bank-accounts')
@Roles(UserRole.ADMIN)
export class BankAccountsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get() list() {
    return this.payments.listAccounts();
  }
  @Post() create(
    @Body() dto: BankAccountDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.payments.createAccount(dto, userId);
  }
  @Put(':id') update(
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.payments.updateAccount(id, dto, userId);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/transfers')
@Roles(UserRole.ADMIN, UserRole.SALES_AGENT)
export class TransfersController {
  constructor(private readonly payments: PaymentsService) {}
  @Get('conversation/:conversationId') byConversation(
    @Param('conversationId') id: string,
  ) {
    return this.payments.byConversation(id);
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.payments.getTransfer(id);
  }
  @Post(':id/start-review') startReview(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.payments.startReview(id, userId);
  }
  @Post(':id/approve') @Roles(UserRole.ADMIN) approve(
    @Param('id') id: string,
    @Body() dto: ApproveTransferDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.payments.approve(id, dto, userId);
  }
  @Post(':id/reject') @Roles(UserRole.ADMIN) reject(
    @Param('id') id: string,
    @Body() dto: RejectTransferDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.payments.reject(id, dto, userId);
  }
}

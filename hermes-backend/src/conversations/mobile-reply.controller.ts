import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MobileAuthGuard } from '../auth/mobile-auth.guard';
import { MobileReplyDto } from './dto/mobile-reply.dto';
import { MobileReplyService } from './mobile-reply.service';

type MobileActor = { id: string; sessionId: string };

@ApiTags('Mobile reply')
@ApiBearerAuth()
@UseGuards(MobileAuthGuard)
@Controller('api/mobile/conversations/:conversationId/replies')
export class MobileReplyController {
  constructor(private readonly replies: MobileReplyService) {}

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'UUID idéntico a operationId del JSON',
  })
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Respuesta móvil manual; operación UUID idempotente, sin reenvío de resultados inciertos',
  })
  reply(
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') headerId: string | undefined,
    @Body() dto: MobileReplyDto,
    @CurrentUser() actor: MobileActor,
  ) {
    return this.replies.reply(conversationId, headerId, dto, actor);
  }

  @Get(':operationId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Conciliar estado de una intención; nunca reenvía a Meta',
  })
  status(
    @Param('conversationId') conversationId: string,
    @Param('operationId') operationId: string,
    @CurrentUser() actor: MobileActor,
  ) {
    return this.replies.status(conversationId, operationId, actor);
  }
}

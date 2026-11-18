import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  Sse,
  UseGuards,
  MessageEvent,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MobileInboxGuard } from './mobile-inbox.guard';
import type { MobileInboxActor } from './mobile-inbox.guard';
import { MobileInboxQuery, MobileMessageQuery } from './mobile-inbox.dto';
import { MobileInboxService } from './mobile-inbox.service';

@ApiTags('Mobile inbox (read-only)')
@ApiBearerAuth()
@Controller('api/mobile/inbox')
@UseGuards(MobileInboxGuard)
export class MobileInboxController {
  constructor(
    private readonly inbox: MobileInboxService,
    private readonly guard: MobileInboxGuard,
    private readonly jwt: JwtService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: MobileInboxQuery) {
    return this.inbox.list(query);
  }

  @Get('events')
  @Sse()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Accel-Buffering', 'no')
  events(
    @CurrentUser() actor: MobileInboxActor,
    @Req() request: Request,
  ): Observable<MessageEvent> {
    // Authenticated at handshake. No private payloads, offsets, Last-Event-ID or replay.
    // Access JWT expiry and revocation are rechecked while the connection is alive.
    const raw = request.headers.authorization?.replace(/^Bearer /i, '') ?? '';
    const decoded: unknown = this.jwt.decode(raw);
    const exp =
      decoded && typeof decoded === 'object' && 'exp' in decoded
        ? decoded.exp
        : undefined;
    const expiresAt = typeof exp === 'number' ? exp * 1000 : 0;
    return new Observable<MessageEvent>((subscriber) => {
      let stopped = false;
      let heartbeats = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
      subscriber.add(stop);
      subscriber.next({
        type: 'connected',
        data: { reconciliation: 'restart' },
        retry: 3000,
      });
      const tick = async () => {
        if (stopped) return;
        try {
          if (Date.now() >= expiresAt || !(await this.guard.active(actor))) {
            subscriber.complete();
            return;
          }
          if (stopped) return;
          // Check revocation every 15s; do not run a costly Inbox re-read each heartbeat.
          subscriber.next({ type: 'heartbeat', data: {} });
          if (++heartbeats % 4 === 0) {
            // Reconcile every 60s; NOT an assertion of new messages.
            subscriber.next({
              type: 'reconcile',
              data: { reconciliation: 'restart' },
            });
          }
          timer = setTimeout(() => {
            void tick();
          }, 15000);
        } catch {
          subscriber.complete();
        }
      };
      timer = setTimeout(() => {
        void tick();
      }, 15000);
    });
  }

  @Get(':id/messages')
  @Header('Cache-Control', 'private, no-store')
  messages(@Param('id') id: string, @Query() query: MobileMessageQuery) {
    return this.inbox.messages(id, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(@Param('id') id: string) {
    return this.inbox.detail(id);
  }
}

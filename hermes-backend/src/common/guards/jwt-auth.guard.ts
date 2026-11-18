import { Injectable, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  protected acceptsMobileToken(): boolean { return false; }

  handleRequest<TUser = any>(err: any, user: any, info: any, context: ExecutionContext, status?: any): TUser {
    const authenticated = super.handleRequest(err, user, info, context, status) as { sessionType?: string; sessionId?: string };
    // Mobile JWTs cannot use legacy admin routes, including registration,
    // payments or WhatsApp. Add explicit mobile routes only after review.
    if (authenticated?.sessionId && authenticated.sessionType !== 'web' && !this.acceptsMobileToken())
      throw new ForbiddenException('La sesión móvil no habilita esta operación');
    return authenticated as TUser;
  }
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    return super.canActivate(context);
  }
}

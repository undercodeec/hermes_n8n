import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Injectable()
export class MobileAuthGuard extends JwtAuthGuard {
  protected acceptsMobileToken(): boolean { return true; }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    const user = context
      .switchToHttp()
      .getRequest<{ user?: { sessionId?: string; sessionType?: string } }>().user;
    if (!allowed || !user?.sessionId || user.sessionType !== 'mobile')
      throw new UnauthorizedException('Se requiere una sesión móvil');
    return true;
  }
}

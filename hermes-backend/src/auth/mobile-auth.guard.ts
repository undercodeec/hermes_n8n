import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Injectable()
export class MobileAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await super.canActivate(context);
    const user = context
      .switchToHttp()
      .getRequest<{ user?: { sessionId?: string } }>().user;
    if (!allowed || !user?.sessionId)
      throw new UnauthorizedException('Se requiere una sesión móvil');
    return true;
  }
}

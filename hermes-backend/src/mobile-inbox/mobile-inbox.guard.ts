import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { MobileAuthGuard } from '../auth/mobile-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

export type MobileInboxActor = { id: string; sessionId: string; email: string };

@Injectable()
export class MobileInboxGuard extends MobileAuthGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async active(actor: MobileInboxActor): Promise<boolean> {
    const email = this.config
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (!email || actor.email.trim().toLowerCase() !== email) return false;
    const session = await this.prisma.mobileSession.findFirst({
      where: {
        id: actor.sessionId,
        userId: actor.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: {
          is: {
            isActive: true,
            role: UserRole.ADMIN,
            email: { equals: email, mode: 'insensitive' },
          },
        },
      },
      select: { id: true },
    });
    return !!session;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const actor = context
      .switchToHttp()
      .getRequest<{ user: MobileInboxActor }>().user;
    if (!actor || !(await this.active(actor)))
      throw new UnauthorizedException('Operador móvil no autorizado');
    return true;
  }
}

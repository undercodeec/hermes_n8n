import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  sid?: string;
  typ?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.typ === 'mobile' || payload.sid !== undefined) {
      if (payload.typ !== 'mobile' || typeof payload.sid !== 'string') {
        throw new UnauthorizedException('Token móvil inválido');
      }
      const session = await this.prisma.mobileSession.findFirst({
        where: {
          id: payload.sid,
          userId: payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!session)
        throw new UnauthorizedException('Sesión móvil vencida o revocada');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no autorizado o inactivo');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      ...(payload.typ === 'mobile' ? { sessionId: payload.sid } : {}),
    };
  }
}

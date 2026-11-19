import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { mobileJwtKey } from '../mobile-jwt-key';
import { webJwtKey } from '../web-jwt-key';
import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  sid?: string;
  typ?: string;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const webSecret = configService.getOrThrow<string>('JWT_SECRET');
    const mobileSecret = mobileJwtKey(webSecret);
    const sessionWebSecret = webJwtKey(webSecret);
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Select the verification key using an untrusted hint only. Passport-JWT
      // verifies the signature with the selected key BEFORE validate() is called.
      secretOrKeyProvider: (_request, rawToken: string, done) => {
        if (!rawToken || rawToken.length > 8192)
          return done(new Error('Invalid token'));
        try {
          const parts = rawToken.split('.');
          if (parts.length !== 3) return done(new Error('Invalid token'));
          const claims = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8'),
          ) as unknown;
          if (!claims || typeof claims !== 'object')
            return done(new Error('Invalid token'));
          const type = (claims as Record<string, unknown>).typ;
          return done(null, type === 'mobile' ? mobileSecret : type === 'web' ? sessionWebSecret : webSecret);
        } catch {
          return done(new Error('Invalid token'));
        }
      },
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.typ === 'web') {
      if (typeof payload.sid !== 'string' || !payload.sid ||
          typeof payload.exp !== 'number')
        throw new UnauthorizedException('Token web inválido');
      const session = await this.prisma.webSession.findFirst({
        where: { id: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { expiresAt: true },
      });
      if (!session || session.expiresAt.getTime() <= Date.now())
        throw new UnauthorizedException('Sesión web vencida o revocada');
    } else if (payload.typ !== undefined && payload.typ !== 'mobile') {
      throw new UnauthorizedException('Tipo de token inválido');
    }
    if (payload.typ === 'mobile' || (payload.sid !== undefined && payload.typ !== 'web')) {
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
    // CRM operator must use the durable web/mobile session. Legacy password and
    // pre-rollout proof JWTs cannot bypass the 24-hour idle/revocation policy.
    const operatorEmail = this.configService
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (user.email.trim().toLowerCase() === operatorEmail &&
        payload.typ !== 'mobile' && payload.typ !== 'web') {
      throw new UnauthorizedException('Se requiere sesión CRM vigente');
    }
    if (payload.typ === 'mobile' || payload.typ === 'web') {
      if (
        user.role !== UserRole.ADMIN ||
        user.email.trim().toLowerCase() !== operatorEmail
      )
        throw new UnauthorizedException('Operador móvil no autorizado');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      ...(payload.typ === 'mobile' || payload.typ === 'web'
        ? { sessionId: payload.sid, sessionType: payload.typ, accessExpiresAt: payload.exp }
        : {}),
    };
  }
}

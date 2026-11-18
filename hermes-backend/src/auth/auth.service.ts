import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { mobileJwtKey } from './mobile-jwt-key';
import { webJwtKey } from './web-jwt-key';

@Injectable()
export class AuthService {
  private readonly mobileIdleMs = 24 * 60 * 60 * 1000;
  private readonly webIdleMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('El email ya está registrado');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        name: dto.name,
        role: dto.role,
      },
    });

    const token = this.generateToken(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken: token,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const token = this.generateToken(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken: token,
    };
  }

  async loginWithCrmProof(proof: string, existingRefreshToken?: string) {
    const payload = this.verifyCrmProof(proof);
    const existing = existingRefreshToken ? this.parseRefresh(existingRefreshToken) : null;
    const generatedPassword = await bcrypt.hash(
      randomBytes(32).toString('hex'),
      12,
    );
    const refreshSecret = randomBytes(32).toString('base64url');
    const result = await this.consumeProof(payload, async (tx) => {
      const account = await tx.user.upsert({
        where: { email: payload.sub },
        update: {},
        create: {
          email: payload.sub,
          password: generatedPassword,
          name: 'Gerencia Undercodeec',
          role: UserRole.ADMIN,
        },
      });
      if (!account.isActive || account.role !== UserRole.ADMIN)
        throw new UnauthorizedException('Usuario no autorizado o inactivo');
      // Serialize OTP exchange against per-operator revocation.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${account.id} FOR UPDATE`;
      if (payload.exp <= Math.floor(Date.now() / 1000)) this.invalidCrmProof();
      const current = await tx.user.findUnique({ where: { id: account.id } });
      if (!current?.isActive || current.role !== UserRole.ADMIN)
        throw new UnauthorizedException('Usuario no autorizado o inactivo');
      if (existing) {
        const active = await tx.webSession.findFirst({
          where: { id: existing.id, userId: account.id, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        if (!active || active.expiresAt.getTime() <= Date.now())
          throw new UnauthorizedException('Sesión web vencida o revocada');
        const rotated = await tx.webSession.updateMany({
          where: {
            id: existing.id, userId: account.id, refreshHash: existing.hash,
            revokedAt: null, expiresAt: { gt: new Date() },
          },
          data: { refreshHash: this.hashRefresh(refreshSecret) },
        });
        if (rotated.count !== 1)
          throw new UnauthorizedException('Refresh token ya utilizado');
        return { user: current, session: active };
      }
      const session = await tx.webSession.create({
        data: {
          userId: account.id,
          refreshHash: this.hashRefresh(refreshSecret),
          expiresAt: new Date(Date.now() + this.webIdleMs),
        },
      });
      return { user: current, session };
    });
    return this.webTokens(result.user, result.session.id, refreshSecret, result.session.expiresAt);
  }

  async refreshWeb(refreshToken: string) {
    const { id, hash } = this.parseRefresh(refreshToken);
    const secret = randomBytes(32).toString('base64url');
    const session = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.webSession.findUnique({
        where: { id }, include: { user: true },
      });
      const now = new Date();
      if (!existing || existing.revokedAt || existing.expiresAt <= now ||
          !existing.user.isActive || existing.user.role !== UserRole.ADMIN ||
          !this.isCrmOperator(existing.user.email))
        throw new UnauthorizedException('Sesión web vencida o revocada');
      const updated = await tx.webSession.updateMany({
        where: { id, refreshHash: hash, revokedAt: null, expiresAt: { gt: now } },
        data: { refreshHash: this.hashRefresh(secret) },
      });
      if (updated.count !== 1)
        throw new UnauthorizedException('Refresh token ya utilizado');
      return existing;
    });
    return this.webTokens(session.user, id, secret, session.expiresAt);
  }

  async checkWeb(userId: string, sessionId: string) {
    const session = await this.prisma.webSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Sesión web vencida o revocada');
    return { active: true, expiresAt: session.expiresAt, idleRemainingMs: session.expiresAt.getTime() - Date.now() };
  }

  async webActivity(userId: string, sessionId: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.webIdleMs);
    const result = await this.prisma.webSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    if (result.count !== 1)
      throw new UnauthorizedException('Sesión web vencida o revocada');
    return { active: true, expiresAt };
  }

  async logoutWeb(userId: string, sessionId: string) {
    await this.prisma.webSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  async logoutWebWithRefresh(refreshToken: string) {
    const { id, hash } = this.parseRefresh(refreshToken);
    const result = await this.prisma.webSession.updateMany({
      where: { id, refreshHash: hash, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1)
      throw new UnauthorizedException('Sesión web vencida o revocada');
    return { revoked: true };
  }

  async revokeAllWebForOperator(userId: string, email: string) {
    if (!this.isCrmOperator(email))
      throw new UnauthorizedException('Operador no autorizado');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user?.isActive || user.role !== UserRole.ADMIN || !this.isCrmOperator(user.email))
        throw new UnauthorizedException('Operador no autorizado');
      const result = await tx.webSession.updateMany({
        where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
      });
      return { revokedSessions: result.count };
    });
  }

  private isCrmOperator(email: string): boolean {
    return email.trim().toLowerCase() === this.configService
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim().toLowerCase();
  }

  private webTokens(
    user: { id: string; email: string; name: string; role: UserRole },
    id: string, secret: string, expiresAt: Date,
  ) {
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken: this.jwtService.sign(
        { sub: user.id, email: user.email, role: user.role, sid: id, typ: 'web' },
        { expiresIn: '5m', secret: webJwtKey(this.configService.getOrThrow<string>('JWT_SECRET')) },
      ),
      refreshToken: `${id}.${secret}`,
      expiresAt,
    };
  }

  async loginMobileWithCrmProof(proof: string) {
    const payload = this.verifyCrmProof(proof, 'hermes-crm-mobile');
    const password = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const refreshSecret = randomBytes(32).toString('base64url');
    const refreshHash = this.hashRefresh(refreshSecret);
    const result = await this.consumeProof(payload, async (tx) => {
      // Never update an existing account's role or active status from mobile.
      const user = await tx.user.upsert({
        where: { email: payload.sub },
        update: {},
        create: {
          email: payload.sub,
          password,
          name: 'Gerencia Undercodeec',
          role: UserRole.ADMIN,
        },
      });
      if (!user.isActive)
        throw new UnauthorizedException('Usuario desactivado');
      if (user.role !== UserRole.ADMIN)
        throw new UnauthorizedException('Usuario no autorizado');
      // Serialize new phone logins for this operator even when they carry
      // different valid proofs. Last committed login is the only active phone.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
      if (payload.exp <= Math.floor(Date.now() / 1000)) this.invalidCrmProof();
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current?.isActive || current.role !== UserRole.ADMIN)
        throw new UnauthorizedException('Usuario no autorizado o inactivo');
      await tx.mobileSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const session = await tx.mobileSession.create({
        data: {
          userId: user.id,
          refreshHash,
          expiresAt: new Date(Date.now() + this.mobileIdleMs),
        },
      });
      return { user, session };
    });
    return this.mobileTokens(
      result.user,
      result.session.id,
      refreshSecret,
      result.session.expiresAt,
    );
  }

  private async consumeProof<T>(
    payload: CrmProofPayload,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.consumedCrmProof.create({
          data: { jti: payload.jti, expiresAt: new Date(payload.exp * 1000) },
        });
        // A proof expiring while the transaction waited for a DB lock is not valid.
        if (payload.exp <= Math.floor(Date.now() / 1000))
          this.invalidCrmProof();
        return action(tx);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new UnauthorizedException('La prueba de acceso ya fue utilizada');
      }
      throw error;
    }
  }

  async refreshMobile(refreshToken: string) {
    const { id, hash } = this.parseRefresh(refreshToken);
    const newSecret = randomBytes(32).toString('base64url');
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.mobileSession.findUnique({
        where: { id },
        include: { user: true },
      });
      const now = new Date();
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= now ||
        !session.user.isActive ||
        session.user.role !== UserRole.ADMIN
      ) {
        throw new UnauthorizedException('Sesión móvil vencida o revocada');
      }
      // Compare-and-swap: exactly one concurrent refresh can consume a token.
      const updated = await tx.mobileSession.updateMany({
        where: {
          id,
          refreshHash: hash,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { refreshHash: this.hashRefresh(newSecret) },
      });
      if (updated.count !== 1)
        throw new UnauthorizedException('Refresh token ya utilizado');
      return session;
    });
    return this.mobileTokens(result.user, id, newSecret, result.expiresAt);
  }

  // A consumed refresh must not revoke a successful concurrent rotation:
  // possession of an older token alone must not log the operator out.
  async logoutMobileWithRefresh(refreshToken: string) {
    const { id, hash } = this.parseRefresh(refreshToken);
    const updated = await this.prisma.mobileSession.updateMany({
      where: {
        id,
        refreshHash: hash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new UnauthorizedException('Sesión móvil vencida o revocada');
    return { revoked: true };
  }

  async checkMobile(userId: string, sessionId: string) {
    const now = new Date();
    const session = await this.prisma.mobileSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { expiresAt: true },
    });
    // Do not report an active session if it expired while the DB read was pending.
    if (!session)
      throw new UnauthorizedException('Sesión móvil vencida o revocada');
    const idleRemainingMs = session.expiresAt.getTime() - Date.now();
    if (idleRemainingMs <= 0)
      throw new UnauthorizedException('Sesión móvil vencida o revocada');
    return { active: true, expiresAt: session.expiresAt, idleRemainingMs };
  }

  async mobileActivity(userId: string, sessionId: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.mobileIdleMs);
    const updated = await this.prisma.mobileSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    if (updated.count !== 1)
      throw new UnauthorizedException('Sesión móvil vencida o revocada');
    return { active: true, expiresAt };
  }

  async logoutMobile(userId: string, sessionId: string) {
    await this.prisma.mobileSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  }

  async revokeAllMobileForOperator(userId: string, email: string) {
    const operatorEmail = this.configService
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (email.trim().toLowerCase() !== operatorEmail)
      throw new UnauthorizedException('Operador no autorizado');
    const result = await this.prisma.$transaction(async (tx) => {
      // Use the same per-operator lock as mobile login so a revocation cannot
      // miss a newly created session in a concurrent transaction.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      const account = await tx.user.findUnique({ where: { id: userId } });
      if (
        !account?.isActive ||
        account.role !== UserRole.ADMIN ||
        account.email.trim().toLowerCase() !== operatorEmail
      )
        throw new UnauthorizedException('Operador no autorizado');
      return tx.mobileSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { revokedSessions: result.count };
  }

  private mobileTokens(
    user: { id: string; email: string; name: string; role: UserRole },
    id: string,
    secret: string,
    expiresAt: Date,
  ) {
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken: this.jwtService.sign(
        {
          sub: user.id,
          email: user.email,
          role: user.role,
          sid: id,
          typ: 'mobile',
        },
        {
          expiresIn: '5m',
          secret: mobileJwtKey(
            this.configService.getOrThrow<string>('JWT_SECRET'),
          ),
        },
      ),
      refreshToken: `${id}.${secret}`,
      expiresAt,
    };
  }

  private hashRefresh(secret: string) {
    return createHash('sha256').update(secret).digest('hex');
  }

  private parseRefresh(token: string) {
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw new UnauthorizedException('Refresh token inválido');
    return { id: match[1], hash: this.hashRefresh(match[2]) };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    return user;
  }

  private generateToken(userId: string, email: string, role: string): string {
    return this.jwtService.sign({
      sub: userId,
      email,
      role,
    });
  }

  private verifyCrmProof(
    proof: string,
    audience: 'hermes-crm' | 'hermes-crm-mobile' = 'hermes-crm',
  ): CrmProofPayload {
    const secret = this.configService.get<string>('CRM_HERMES_PROOF_SECRET');
    const operatorEmail = this.configService
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException(
        'La autenticación CRM no está configurada',
      );
    }

    const parts = proof.split('.');
    if (parts.length !== 3) this.invalidCrmProof();
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    if (!this.safeEqual(signature, expectedSignature)) this.invalidCrmProof();

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(
        Buffer.from(encodedHeader, 'base64url').toString('utf8'),
      ) as unknown;
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as unknown;
    } catch {
      this.invalidCrmProof();
    }

    if (!this.isRecord(header) || !this.isRecord(payload)) {
      this.invalidCrmProof();
    }

    const now = Math.floor(Date.now() / 1000);
    const email =
      typeof payload.sub === 'string' ? payload.sub.trim().toLowerCase() : '';
    if (
      header.alg !== 'HS256' ||
      header.typ !== 'JWT' ||
      payload.iss !== 'undercodeec-admin' ||
      payload.aud !== audience ||
      payload.role !== 'ADMIN' ||
      email !== operatorEmail ||
      typeof payload.jti !== 'string' ||
      payload.jti.length < 16 ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.iat > now + 30 ||
      payload.exp <= now ||
      payload.exp - payload.iat > 180
    ) {
      this.invalidCrmProof();
    }

    return {
      iss: 'undercodeec-admin',
      aud: audience,
      sub: email,
      role: 'ADMIN',
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
    };
  }

  private safeEqual(value: string, expected: string): boolean {
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private invalidCrmProof(): never {
    throw new UnauthorizedException('Prueba de acceso inválida o vencida');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

interface CrmProofPayload {
  iss: 'undercodeec-admin';
  aud: 'hermes-crm' | 'hermes-crm-mobile';
  sub: string;
  role: 'ADMIN';
  jti: string;
  iat: number;
  exp: number;
}

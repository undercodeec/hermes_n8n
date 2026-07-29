import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly consumedCrmProofs = new Map<string, number>();

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

  async loginWithCrmProof(proof: string) {
    const payload = this.verifyCrmProof(proof);
    const now = Math.floor(Date.now() / 1000);

    for (const [jti, expiresAt] of this.consumedCrmProofs) {
      if (expiresAt <= now) this.consumedCrmProofs.delete(jti);
    }
    if (this.consumedCrmProofs.has(payload.jti)) {
      throw new UnauthorizedException('La prueba de acceso ya fue utilizada');
    }
    this.consumedCrmProofs.set(payload.jti, payload.exp);

    const generatedPassword = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const user = await this.prisma.user.upsert({
      where: { email: payload.sub },
      update: {
        name: 'Gerencia Undercodeec',
        role: UserRole.ADMIN,
        isActive: true,
      },
      create: {
        email: payload.sub,
        password: generatedPassword,
        name: 'Gerencia Undercodeec',
        role: UserRole.ADMIN,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      accessToken: this.generateToken(user.id, user.email, user.role),
    };
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

  private verifyCrmProof(proof: string): CrmProofPayload {
    const secret = this.configService.get<string>('CRM_HERMES_PROOF_SECRET');
    const operatorEmail = this.configService
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException('La autenticación CRM no está configurada');
    }

    const parts = proof.split('.');
    if (parts.length !== 3) this.invalidCrmProof();
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    if (!this.safeEqual(signature, expectedSignature)) this.invalidCrmProof();

    let header: { alg?: string; typ?: string };
    let payload: Partial<CrmProofPayload>;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      this.invalidCrmProof();
    }

    const now = Math.floor(Date.now() / 1000);
    const email = typeof payload!.sub === 'string' ? payload!.sub.trim().toLowerCase() : '';
    if (
      header!.alg !== 'HS256' ||
      header!.typ !== 'JWT' ||
      payload!.iss !== 'undercodeec-admin' ||
      payload!.aud !== 'hermes-crm' ||
      payload!.role !== 'ADMIN' ||
      email !== operatorEmail ||
      typeof payload!.jti !== 'string' ||
      payload!.jti.length < 16 ||
      typeof payload!.iat !== 'number' ||
      typeof payload!.exp !== 'number' ||
      payload!.iat > now + 30 ||
      payload!.exp <= now ||
      payload!.exp - payload!.iat > 180
    ) {
      this.invalidCrmProof();
    }

    return { ...payload!, sub: email } as CrmProofPayload;
  }

  private safeEqual(value: string, expected: string): boolean {
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private invalidCrmProof(): never {
    throw new UnauthorizedException('Prueba de acceso inválida o vencida');
  }
}

interface CrmProofPayload {
  iss: 'undercodeec-admin';
  aud: 'hermes-crm';
  sub: string;
  role: 'ADMIN';
  jti: string;
  iat: number;
  exp: number;
}

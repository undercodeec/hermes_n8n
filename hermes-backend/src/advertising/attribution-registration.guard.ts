import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';

type RequestLike = {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

@Injectable()
export class AttributionRegistrationGuard implements CanActivate {
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    this.assertIntegrationKey(this.header(request, 'x-hermes-attribution-key'));
    this.assertAllowedOrigin(this.header(request, 'origin'));
    await this.assertRateLimit(request.ip || 'unknown');
    return true;
  }

  private assertIntegrationKey(received?: string): void {
    const expected = this.config.get<string>(
      'AD_ATTRIBUTION_INTEGRATION_KEY',
      '',
    );
    if (!received || expected.length < 32) {
      throw new UnauthorizedException('Invalid integration credentials');
    }
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid integration credentials');
    }
  }

  private assertAllowedOrigin(origin?: string): void {
    if (!origin) return;
    const allowed = this.config
      .get<string>('AD_ATTRIBUTION_ALLOWED_ORIGINS', '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!allowed.includes(origin)) {
      throw new UnauthorizedException('Origin not allowed');
    }
  }

  private async assertRateLimit(ip: string): Promise<void> {
    const limit = Math.max(
      1,
      Number(this.config.get('AD_ATTRIBUTION_RATE_LIMIT_PER_MINUTE') || 30),
    );
    const bucket = Math.floor(Date.now() / 60_000);
    const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 24);
    const key = `advertising:intent:${bucket}:${ipHash}`;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 70);
      if (count > limit) {
        throw new HttpException(
          'Rate limit exceeded',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Attribution service unavailable');
    }
  }

  private header(request: RequestLike, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}

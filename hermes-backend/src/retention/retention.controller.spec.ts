import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { Server } from 'node:http';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

describe('retention ADMIN API', () => {
  let app: INestApplication;
  const secret = 'isolated-retention-test-secret';
  const jwt = new JwtService({ secret });
  const user = {
    id: 'operator-1',
    email: 'operator@example.test',
    name: 'Operator',
    role: UserRole.ADMIN,
    isActive: true,
  };
  const service = {
    get: jest.fn().mockResolvedValue({ policy: { backupEnabled: false } }),
    update: jest.fn().mockResolvedValue({ policy: { backupEnabled: false } }),
    preview: jest.fn().mockResolvedValue({ deleteCount: 0 }),
    backupNow: jest.fn().mockResolvedValue({ id: 'artifact' }),
    restoreNow: jest.fn().mockResolvedValue({ passed: true }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [RetentionController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn().mockResolvedValue(user) } },
        },
        { provide: RetentionService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects missing JWT', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/admin/retention-recovery-policy')
      .expect(401);
  });

  it('rejects a non ADMIN user', async () => {
    user.role = UserRole.SALES_AGENT;
    await request(app.getHttpServer() as Server)
      .get('/api/admin/retention-recovery-policy')
      .set('Authorization', `Bearer ${jwt.sign({ sub: user.id })}`)
      .expect(403);
    user.role = UserRole.ADMIN;
  });

  it('allows ADMIN and delegates policy update', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/admin/retention-recovery-policy')
      .set('Authorization', `Bearer ${jwt.sign({ sub: user.id })}`)
      .expect(200);
    await request(app.getHttpServer() as Server)
      .put('/api/admin/retention-recovery-policy')
      .set('Authorization', `Bearer ${jwt.sign({ sub: user.id })}`)
      .send({ backupEnabled: false })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(
      { backupEnabled: false },
      user.id,
    );
  });
});

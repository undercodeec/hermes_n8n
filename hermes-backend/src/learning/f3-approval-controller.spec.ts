import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { Server } from 'node:http';
import request from 'supertest';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationReviewService } from './conversation-review.service';
import { LearningController } from './learning.controller';
import { LearningDecisionAction } from './dto/learning-decision.dto';

describe('F3 approval HTTP authority', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const decision = jest
    .fn()
    .mockResolvedValue({ id: 'synthetic-item', status: 'ACTIVE' });
  const itemPath = '/api/learning/candidates/synthetic-item/decision';
  const reason = 'Motivo sintético suficiente';
  const body = {
    action: LearningDecisionAction.APPROVE,
    reason,
    validUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const user = { findUnique: jest.fn() };

  beforeAll(async () => {
    const secret = 'synthetic-f3-approval-jwt-secret';
    const module = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret })],
      controllers: [LearningController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        { provide: PrismaService, useValue: { user } },
        { provide: ConversationReviewService, useValue: { decide: decision } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    jwt = module.get(JwtService);
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    decision.mockClear();
    user.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        email: `${where.id}@example.invalid`,
        name: 'Synthetic user',
        role: where.id === 'admin-1' ? UserRole.ADMIN : UserRole.SALES_AGENT,
        isActive: where.id !== 'inactive-1',
      }),
    );
  });

  const tokenFor = (id: string) =>
    jwt.sign({ sub: id, email: `${id}@example.invalid`, role: UserRole.ADMIN });

  it('returns 401 without a JWT or with an invalid JWT; no decision runs', async () => {
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .send(body)
      .expect(401);
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', 'Bearer invalid-token')
      .send(body)
      .expect(401);
    expect(decision).not.toHaveBeenCalled();
  });

  it('returns 403 for SALES_AGENT and 401 for inactive user', async () => {
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('agent-1')}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('inactive-1')}`)
      .send(body)
      .expect(401);
    expect(decision).not.toHaveBeenCalled();
  });

  it('derives ADMIN actor from the validated JWT, not request body or token role', async () => {
    const forgedRole = jwt.sign({
      sub: 'agent-1',
      email: 'agent-1@example.invalid',
      role: UserRole.ADMIN,
    });
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${forgedRole}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('admin-1')}`)
      .send({ ...body, approvedById: 'agent-1' })
      .expect(400);
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('admin-1')}`)
      .send(body)
      .expect(201);
    expect(decision).toHaveBeenCalledTimes(1);
    expect(decision).toHaveBeenCalledWith('synthetic-item', body, 'admin-1');
  });

  it.each([
    ['', 400],
    ['   ', 400],
    ['corto', 400],
    ['a'.repeat(10), 201],
    ['a'.repeat(500), 201],
    ['a'.repeat(501), 400],
    ['Motivo sintético válido', 201],
  ])('validates reason DTO length for %s', async (reasonValue, status) => {
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('admin-1')}`)
      .send({ ...body, reason: reasonValue })
      .expect(status);
    expect(decision).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
  });

  it('rejects malformed ISO date in the DTO before invoking the service', async () => {
    await request(app.getHttpServer() as Server)
      .post(itemPath)
      .set('Authorization', `Bearer ${tokenFor('admin-1')}`)
      .send({ ...body, validUntil: 'not-a-date' })
      .expect(400);
    expect(decision).not.toHaveBeenCalled();
  });
});

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

describe('manual reviewer canary authorization', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const triggerCanary = jest.fn().mockResolvedValue({
    feedbackId: '10000000-0000-4000-8000-000000000001',
    reviewId: 'review-1',
    status: 'PENDING',
    scheduled: true,
    reused: false,
  });
  const feedbackId = '10000000-0000-4000-8000-000000000001';
  const requestKey = '20000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const secret = 'synthetic-review-canary-test-secret';
    const module = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret })],
      controllers: [LearningController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(({ where }: { where: { id: string } }) =>
                Promise.resolve({
                  id: where.id,
                  email: 'synthetic@example.test',
                  name: 'Synthetic operator',
                  role:
                    where.id === 'admin-1'
                      ? UserRole.ADMIN
                      : UserRole.SALES_AGENT,
                  isActive: true,
                }),
              ),
            },
          },
        },
        { provide: ConversationReviewService, useValue: { triggerCanary } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    jwt = module.get(JwtService);
  });

  afterAll(async () => app.close());

  beforeEach(() => triggerCanary.mockClear());

  it('returns 401 without JWT', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/learning/reviews/canary')
      .send({ feedbackId, requestKey })
      .expect(401);
    expect(triggerCanary).not.toHaveBeenCalled();
  });

  it('returns 403 to SALES_AGENT', async () => {
    const token = jwt.sign({
      sub: 'agent-1',
      email: 'synthetic@example.test',
      role: UserRole.SALES_AGENT,
    });
    await request(app.getHttpServer() as Server)
      .post('/api/learning/reviews/canary')
      .set('Authorization', `Bearer ${token}`)
      .send({ feedbackId, requestKey })
      .expect(403);
    expect(triggerCanary).not.toHaveBeenCalled();
  });

  it('allows ADMIN and returns only the operational result', async () => {
    const token = jwt.sign({
      sub: 'admin-1',
      email: 'synthetic@example.test',
      role: UserRole.ADMIN,
    });
    const response = await request(app.getHttpServer() as Server)
      .post('/api/learning/reviews/canary')
      .set('Authorization', `Bearer ${token}`)
      .send({ feedbackId, requestKey })
      .expect(201);
    expect(response.body).toEqual({
      feedbackId,
      reviewId: 'review-1',
      status: 'PENDING',
      scheduled: true,
      reused: false,
    });
    expect(triggerCanary).toHaveBeenCalledWith(
      { feedbackId, requestKey },
      'admin-1',
    );
  });
});

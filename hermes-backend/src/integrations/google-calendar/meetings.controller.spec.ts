import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { Server } from 'node:http';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { MeetingReadService } from './meeting-read.service';
import { MeetingsController } from './meetings.controller';

describe('GET /api/meetings', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'calendar-test-only-secret' });
  const from = '2026-09-28T05:00:00.000Z';
  const to = '2026-10-05T05:00:00.000Z';
  const findMany = jest.fn().mockResolvedValue([]);
  const token = (role: UserRole) =>
    jwt.sign({ sub: role, email: 'test@example.test', role });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MeetingsController],
      providers: [
        MeetingReadService,
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: 'calendar-test-only-secret',
          }),
        },
        {
          provide: PrismaService,
          useValue: {
            meeting: { findMany },
            user: {
              findUnique: ({ where }: { where: { id: UserRole } }) =>
                Promise.resolve({
                  id: where.id,
                  role: where.id,
                  isActive: true,
                }),
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => findMany.mockClear());

  it.each([UserRole.ADMIN, UserRole.SALES_AGENT])(
    'allows %s and returns normalized range and data',
    async (role) => {
      const response = await request(app.getHttpServer() as Server)
        .get('/api/meetings')
        .auth(token(role), { type: 'bearer' })
        .query({ from, to, status: 'PENDING', timezone: 'Europe/Madrid' })
        .expect(200);
      expect(response.body).toEqual({ data: [], range: { from, to } });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            startAt: { lt: new Date(to) },
            endAt: { gt: new Date(from) },
            status: 'PENDING',
            timezone: 'Europe/Madrid',
          },
        }),
      );
    },
  );
  it('rejects a viewer without reading meetings', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/meetings')
      .auth(token(UserRole.VIEWER), { type: 'bearer' })
      .query({ from, to })
      .expect(403);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('requires a valid bearer token', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/meetings')
      .query({ from, to })
      .expect(401);
    await request(app.getHttpServer() as Server)
      .get('/api/meetings')
      .auth('invalid', { type: 'bearer' })
      .query({ from, to })
      .expect(401);
    expect(findMany).not.toHaveBeenCalled();
  });
  it.each([
    { from: undefined },
    { to: undefined },
    { from: 'not-a-date' },
    { from: '2026-09-28' },
    { from: '2026-09-28T05:00:00' },
    { from: '2026-02-30T05:00:00Z' },
    { to: from },
    { to: '2026-09-27T05:00:00Z' },
    { to: '2026-11-10T05:00:00Z' },
    { status: 'SCHEDULED' },
    { status: '' },
    { timezone: 'Mars/Olympus' },
    { timezone: '' },
    { timezone: ['Europe/Madrid', 'America/Guayaquil'] },
    { from: [from, from] },
    { unexpected: 'true' },
  ])('rejects malformed query %j before reading meetings', async (changes) => {
    await request(app.getHttpServer() as Server)
      .get('/api/meetings')
      .auth(token(UserRole.ADMIN), { type: 'bearer' })
      .query({ from, to, ...changes })
      .expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('accepts exactly 42 days and explicit offsets', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/meetings')
      .auth(token(UserRole.SALES_AGENT), { type: 'bearer' })
      .query({ from: '2026-09-28T00:00:00-05:00', to: '2026-11-09T05:00:00Z' })
      .expect(200);
    expect((response.body as { range: { from: string } }).range.from).toBe(
      from,
    );
  });
});

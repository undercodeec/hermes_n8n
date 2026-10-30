import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { PriceListsController } from '../src/price-lists/price-lists.controller';
import { PriceListsService } from '../src/price-lists/price-lists.service';

describe('Price lists HTTP access (synthetic)', () => {
  let app: INestApplication<App>;
  const secret = 'local-synthetic-test-secret';
  const jwt = new JwtService({ secret });
  const update = jest.fn().mockResolvedValue({ id: 'promo-1', isActive: true });
  const priceLists = {
    update,
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    audit: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    remove: jest.fn(),
  };
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) => ({
          id: where.id,
          email: `${where.id}@example.test`,
          name: where.id,
          isActive: true,
          role: where.id === 'admin' ? UserRole.ADMIN : UserRole.SALES_AGENT,
        })),
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [PriceListsController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        { provide: PriceListsService, useValue: priceLists },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { getOrThrow: () => secret } },
      ],
    }).compile();
    app = module.createNestApplication<App>();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    update.mockClear();
  });

  const token = (sub: string, expiresIn: string | number = '1h') =>
    jwt.sign(
      {
        sub,
        email: `${sub}@example.test`,
        role: sub === 'admin' ? UserRole.ADMIN : UserRole.SALES_AGENT,
      },
      { expiresIn: expiresIn as never },
    );

  it('allows an ADMIN to activate with only isActive', async () => {
    await request(app.getHttpServer())
      .put('/api/price-lists/promo-1')
      .auth(token('admin'), { type: 'bearer' })
      .send({ isActive: true })
      .expect(200);
    expect(update).toHaveBeenCalledWith('promo-1', { isActive: true }, 'admin');
  });

  it('rejects a non-admin without invoking the service', async () => {
    await request(app.getHttpServer())
      .put('/api/price-lists/promo-1')
      .auth(token('agent'), { type: 'bearer' })
      .send({ isActive: true })
      .expect(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects invalid and expired tokens without invoking the service', async () => {
    await request(app.getHttpServer())
      .put('/api/price-lists/promo-1')
      .auth('invalid-token', { type: 'bearer' })
      .send({ isActive: true })
      .expect(401);
    await request(app.getHttpServer())
      .put('/api/price-lists/promo-1')
      .auth(token('admin', -1), { type: 'bearer' })
      .send({ isActive: true })
      .expect(401);
    expect(update).not.toHaveBeenCalled();
  });
});

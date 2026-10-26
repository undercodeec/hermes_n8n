import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  InboundTurnService,
  NORMAL_NOUS_GENERATION_ENGINE,
} from './inbound-turn.service';

describe('normal Nous pilot reservation', () => {
  it('checks the UTC daily budget under a database lock before reserving', async () => {
    const steps: string[] = [];
    let reservations = 0;
    const tx = {
      $executeRaw: jest.fn().mockImplementation(() => {
        steps.push('lock');
        return Promise.resolve(1);
      }),
      inboundTurn: {
        count: jest.fn().mockImplementation(() => {
          steps.push('count');
          return Promise.resolve(reservations);
        }),
        updateMany: jest.fn().mockImplementation(() => {
          steps.push('reserve');
          reservations += 1;
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    } as unknown as ConfigService;
    const service = new InboundTurnService(prisma, config);
    const input = {
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      sourceMessageId: 'message-1',
      generationToken: 'token-1',
      normal: true,
      pilotBudget: {
        dailyRequestLimit: 1,
        dailyEstimatedUsdLimit: 0.02,
        estimatedUsdPerRequest: 0.02,
      },
    };

    expect(await service.reserveNousDispatch(input)).toBe(true);
    expect(await service.reserveNousDispatch(input)).toBe(false);
    expect(steps).toEqual(['lock', 'count', 'reserve', 'lock', 'count']);
    expect(tx.inboundTurn.count).toHaveBeenCalledWith({
      where: {
        generationEngine: NORMAL_NOUS_GENERATION_ENGINE,
        providerDispatchReservedAt: { gte: expect.any(Date) as Date },
      },
    });
    expect(tx.inboundTurn.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a reservation when the next estimated request crosses the spend cap', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      inboundTurn: {
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    } as unknown as ConfigService;
    const service = new InboundTurnService(prisma, config);

    expect(
      await service.reserveNousDispatch({
        turnId: 'turn-2',
        conversationId: 'conversation-1',
        sourceMessageId: 'message-2',
        generationToken: 'token-2',
        normal: true,
        pilotBudget: {
          dailyRequestLimit: 100,
          dailyEstimatedUsdLimit: 0.03,
          estimatedUsdPerRequest: 0.02,
        },
      }),
    ).toBe(false);
    expect(tx.inboundTurn.updateMany).not.toHaveBeenCalled();
  });
});

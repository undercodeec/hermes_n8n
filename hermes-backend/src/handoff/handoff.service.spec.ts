/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConversationStatus,
  HandoffReason,
  HandoffStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import {
  HandoffResolutionAction,
  ResolveHandoffDto,
} from './dto/handoff-actions.dto';
import { HandoffService } from './handoff.service';

describe('HandoffService', () => {
  const tx = {
    humanHandoff: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    conversation: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const service = new HandoffService(
    prisma,
    { emit: jest.fn() } as unknown as EventEmitter2,
    { isActive: jest.fn().mockReturnValue(false) } as unknown as ClsService,
    { get: jest.fn() } as unknown as ConfigService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.humanHandoff.findUnique.mockResolvedValue({
      id: 'handoff-1',
      conversationId: 'conversation-1',
      status: HandoffStatus.IN_PROGRESS,
      assignedAgentId: 'user-1',
    });
    tx.humanHandoff.update.mockResolvedValue({ id: 'handoff-1' });
  });

  it('keeps a durable handoff when event publication fails', async () => {
    const handoff = {
      id: 'handoff-1',
      conversationId: 'conversation-1',
      reason: HandoffReason.SUPPORT,
      reasonDetail: 'Soporte solicitado',
      assignedAgentId: null,
      conversation: {
        contact: { id: 'contact-1', name: 'Ana', waId: '593991234567' },
      },
    };
    const createTx = {
      $executeRaw: jest.fn(),
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          status: ConversationStatus.ACTIVE,
          contact: handoff.conversation.contact,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      humanHandoff: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(handoff),
      },
      auditLog: { create: jest.fn() },
    };
    const createPrisma = {
      $transaction: jest.fn((callback: (client: typeof createTx) => unknown) =>
        callback(createTx),
      ),
    } as unknown as PrismaService;
    const events = {
      emit: jest.fn().mockImplementation(() => {
        throw new Error('n8n queue unavailable');
      }),
    };
    const createService = new HandoffService(
      createPrisma,
      events as unknown as EventEmitter2,
      { isActive: jest.fn().mockReturnValue(false) } as unknown as ClsService,
      { get: jest.fn() } as unknown as ConfigService,
    );

    await expect(
      createService.create({
        conversationId: 'conversation-1',
        reason: HandoffReason.SUPPORT,
        reasonDetail: 'Soporte solicitado',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'handoff-1' }));
    expect(createTx.humanHandoff.create).toHaveBeenCalledTimes(1);
  });

  it('devuelve explícitamente el control a Hermes al resolver', async () => {
    const dto: ResolveHandoffDto = {
      resolution: 'Consulta resuelta',
      action: HandoffResolutionAction.RETURN_TO_HERMES,
    };

    await service.resolve('handoff-1', dto, 'user-1');

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: { status: ConversationStatus.ACTIVE, closedAt: null },
    });
    expect(tx.humanHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: HandoffStatus.RESOLVED }),
      }),
    );
  });

  it('mantiene abierto el handoff cuando el humano conserva el control', async () => {
    const dto: ResolveHandoffDto = {
      resolution: 'Seguimiento manual pendiente',
      action: HandoffResolutionAction.KEEP_HUMAN,
    };

    await service.resolve('handoff-1', dto, 'user-1');

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: {
        status: ConversationStatus.HANDED_OFF,
        closedAt: null,
      },
    });
    expect(tx.humanHandoff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: HandoffStatus.IN_PROGRESS }),
      }),
    );
  });
});

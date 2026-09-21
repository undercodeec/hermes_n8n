/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  ConversationStatus,
  MessageSender,
  TaskStatus,
  TaskType,
} from '@prisma/client';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    message: { create: jest.fn() },
    conversation: { findUnique: jest.fn(), update: jest.fn() },
    humanHandoff: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    conversation: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    message: { findFirst: jest.fn(), groupBy: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
  const service = new ConversationsService(prisma, meta);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.conversation.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'conversation-1',
      contactId: 'contact-1',
      contact: { waId: '593999999999' },
    });
  });

  it('rechaza texto libre fuera de la ventana de 24 horas', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(
      service.reply('conversation-1', { content: 'Hola' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('registra un mensaje humano y su auditoría dentro de la ventana', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    (meta.sendTextMessage as jest.Mock).mockResolvedValue({
      messages: [{ id: 'wamid-1' }],
    });
    tx.message.create.mockResolvedValue({ id: 'message-1' });

    await service.reply(
      'conversation-1',
      { content: 'Te ayudo con tu cotización' },
      'user-1',
    );

    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sender: MessageSender.HUMAN,
          sentByUserId: 'user-1',
          wamid: 'wamid-1',
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'HUMAN_MESSAGE_SENT' }),
      }),
    );
  });

  it('no registra como enviado un mensaje que Meta no confirmó', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(),
    });
    (meta.sendTextMessage as jest.Mock).mockResolvedValue(null);

    await expect(
      service.reply('conversation-1', { content: 'Hola' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it('rechaza respuestas manuales en una conversación cerrada', async () => {
    (prisma.conversation.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'conversation-1',
      status: ConversationStatus.CLOSED,
      contact: { waId: '593999999999' },
    });

    await expect(
      service.reply('conversation-1', { content: 'Hola' }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('reabre manualmente, limpia closedAt y registra auditoría', async () => {
    const closedAt = new Date('2026-09-18T18:00:00Z');
    tx.conversation.findUnique.mockResolvedValue({
      id: 'conversation-1',
      status: ConversationStatus.CLOSED,
      closedAt,
    });
    tx.humanHandoff.findFirst.mockResolvedValue(null);
    tx.conversation.update.mockResolvedValue({
      id: 'conversation-1',
      status: ConversationStatus.ACTIVE,
      closedAt: null,
    });

    await service.reopen('conversation-1', 'user-1');

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: { status: ConversationStatus.ACTIVE, closedAt: null },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          action: 'CONVERSATION_REOPENED',
          changes: expect.objectContaining({ source: 'CRM' }),
        }),
      }),
    );
  });

  it('no devuelve a Hermes una conversación con handoff abierto', async () => {
    tx.conversation.findUnique.mockResolvedValue({
      id: 'conversation-1',
      status: ConversationStatus.CLOSED,
      closedAt: new Date(),
    });
    tx.humanHandoff.findFirst.mockResolvedValue({ id: 'handoff-1' });

    await expect(
      service.reopen('conversation-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.conversation.update).not.toHaveBeenCalled();
  });

  it('exposes the last Hermes incident and open review task in conversation detail', async () => {
    const occurredAt = '2026-09-20T18:00:00.000Z';
    (prisma.conversation.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'conversation-1',
      metadata: {
        otherField: 'preserved internally',
        lastHermesIncident: {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          summary: 'HTTP 503 secret=provider-value',
          attempts: 2,
          recovered: false,
          requiresHumanReview: true,
          sourceMessageId: 'inbound-1',
          taskId: 'task-1',
          occurredAt,
          providerStack: 'must not leave the server',
        },
      },
      messages: [],
      tasks: [
        {
          id: 'task-1',
          title: 'Revisar incidencia de Hermes',
          type: TaskType.GENERAL,
          status: TaskStatus.PENDING,
          createdAt: new Date(occurredAt),
          metadata: {
            actionStatus: 'PENDING_REVIEW',
            providerStack: 'must not leave the server',
          },
        },
      ],
    });
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue(null);

    const result = await service.findOne('conversation-1');

    expect(result.hermesIncident).toEqual(
      expect.objectContaining({
        category: 'PROVIDER_ERROR',
        code: 'HERMES_PROVIDER_UNAVAILABLE',
        summary: 'HTTP 503 secret=[REDACTED]',
      }),
    );
    expect(result.hermesReviewTask).toEqual(
      expect.objectContaining({ status: TaskStatus.PENDING }),
    );
    expect(JSON.stringify(result.hermesIncident)).not.toContain(
      'providerStack',
    );
    expect(JSON.stringify(result.hermesReviewTask)).not.toContain('metadata');
  });

  it('returns a safe Hermes incident summary and review task in the conversation list', async () => {
    (prisma.conversation.findMany as unknown as jest.Mock).mockResolvedValue([
      {
        id: 'conversation-1',
        updatedAt: new Date('2026-09-20T18:00:00.000Z'),
        metadata: {
          lastHermesIncident: {
            category: 'OUTPUT_BLOCKED',
            code: 'HERMES_OUTPUT_STRUCTURED_PAYLOAD',
            summary: 'token=private-value',
            attempts: 1,
            recovered: false,
            requiresHumanReview: false,
            sourceMessageId: 'inbound-1',
            occurredAt: '2026-09-20T18:00:00.000Z',
            rawPayload: '{"token":"private-value"}',
          },
        },
        handoffs: [],
        messages: [],
        tasks: [
          {
            id: 'task-1',
            title: 'Revisar incidencia de Hermes',
            type: TaskType.GENERAL,
            status: TaskStatus.IN_PROGRESS,
            createdAt: new Date('2026-09-20T18:00:00.000Z'),
            metadata: { actionStatus: 'PENDING_REVIEW', secret: 'private' },
          },
        ],
      },
    ]);
    (prisma.conversation.count as unknown as jest.Mock).mockResolvedValue(1);
    (prisma.message.groupBy as unknown as jest.Mock).mockResolvedValue([]);

    const result = await service.findAll({ page: 1, limit: 20 });

    expect(result.data[0].hermesIncident).toEqual(
      expect.objectContaining({
        category: 'OUTPUT_BLOCKED',
        summary: 'token=[REDACTED]',
      }),
    );
    expect(result.data[0].hermesReviewTask).toEqual(
      expect.objectContaining({ status: TaskStatus.IN_PROGRESS }),
    );
    expect(JSON.stringify(result.data[0])).not.toContain('rawPayload');
    expect(JSON.stringify(result.data[0])).not.toContain('private-value');
  });
});

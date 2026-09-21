import { TaskStatus, TaskType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

describe('TasksService callback requests', () => {
  it('creates one pending Hermes review task per source message', async () => {
    const created = {
      id: 'review-task-1',
      conversationId: 'conversation-1',
      leadId: null,
      type: TaskType.GENERAL,
      status: TaskStatus.PENDING,
      metadata: { sourceMessageIds: ['message-1'] },
    };
    const task = {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue(created),
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      task,
    };
    const prisma = {
      task,
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new TasksService(prisma);
    const params = {
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      sourceMessageId: 'message-1',
      category: 'PROVIDER_ERROR' as const,
      code: 'HERMES_PROVIDER_UNAVAILABLE',
      summary: 'HTTP 503',
    };

    const first = await service.requestHermesReview(params);
    const second = await service.requestHermesReview(params);

    expect(second.id).toBe(first.id);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: TaskType.GENERAL,
          status: TaskStatus.PENDING,
          title: 'Revisar incidencia de Hermes',
          metadata: expect.objectContaining({
            actionStatus: 'PENDING_REVIEW',
            sourceMessageIds: ['message-1'],
          }),
        }),
      }),
    );
  });

  it('does not duplicate a callback task when the same inbound message is retried', async () => {
    const existing = {
      id: 'task-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      type: TaskType.CALLBACK,
      status: TaskStatus.PENDING,
      dueAt: null,
      description: null,
      metadata: { sourceMessageIds: ['inbound-1'] },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      task: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new TasksService(prisma);

    const result = await service.requestCallback({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      leadId: 'lead-1',
      sourceMessageId: 'inbound-1',
    });

    expect(result).toBe(existing);
    expect(tx.task.update).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it('updates the open task with a later requested time instead of confirming it', async () => {
    const requestedAt = new Date('2026-09-18T20:20:00Z');
    const existing = {
      id: 'task-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      type: TaskType.CALLBACK,
      status: TaskStatus.PENDING,
      dueAt: null,
      description: null,
      metadata: { sourceMessageIds: ['inbound-1'] },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      task: {
        findFirst: jest.fn().mockResolvedValue(existing),
        update: jest
          .fn()
          .mockResolvedValue({ ...existing, dueAt: requestedAt }),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new TasksService(prisma);

    await service.requestCallback({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      leadId: 'lead-1',
      sourceMessageId: 'inbound-2',
      requestedAt,
    });

    expect(tx.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: expect.objectContaining({ dueAt: requestedAt }),
      }),
    );
    expect(tx.task.create).not.toHaveBeenCalled();
    const metadata = tx.task.update.mock.calls[0][0].data.metadata;
    expect(metadata.actionStatus).toBe('PENDING_CONFIRMATION');
  });
});

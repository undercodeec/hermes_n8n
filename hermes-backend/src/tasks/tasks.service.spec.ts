import { TaskStatus, TaskType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

describe('TasksService callback requests', () => {
  it('creates one pending Hermes review task per source message', async () => {
    type CreateArgs = {
      data: {
        type: TaskType;
        status: TaskStatus;
        title: string;
        description: string;
        metadata: {
          actionStatus: string;
          sourceMessageIds: string[];
          category: string;
          code: string;
          summary: string;
        };
      };
    };
    let capturedCreateArgs: CreateArgs | undefined;
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
      create: jest.fn((args: CreateArgs) => {
        capturedCreateArgs = args;
        return Promise.resolve(created);
      }),
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
      summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
    };

    const first = await service.requestHermesReview(params);
    const second = await service.requestHermesReview(params);

    expect(second.id).toBe(first.id);
    expect(task.create).toHaveBeenCalledTimes(1);
    expect(capturedCreateArgs?.data.type).toBe(TaskType.GENERAL);
    expect(capturedCreateArgs?.data.status).toBe(TaskStatus.PENDING);
    expect(capturedCreateArgs?.data.title).toBe('Revisar incidencia de Hermes');
    expect(capturedCreateArgs?.data.description).toBe(
      'Revisar incidencia de Hermes: No se pudo completar la respuesta del proveedor.',
    );
    expect(capturedCreateArgs?.data.metadata).toEqual(
      expect.objectContaining({
        actionStatus: 'PENDING_REVIEW',
        category: 'PROVIDER_ERROR',
        code: 'HERMES_PROVIDER_UNAVAILABLE',
        summary: 'No se pudo completar la respuesta del proveedor.',
        sourceMessageIds: ['message-1'],
      }),
    );
    expect(JSON.stringify(capturedCreateArgs)).not.toContain(
      'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
    );
  });

  it('does not expose old provider text through task list or detail', async () => {
    const stored = {
      id: 'review-task-1',
      type: TaskType.GENERAL,
      title: 'Revisar incidencia de Hermes',
      description: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
      metadata: {
        actionStatus: 'PENDING_REVIEW',
        category: 'PROVIDER_ERROR',
        code: 'FAKE_PROVIDER_CODE_DO_NOT_USE',
        summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
        nested: { provider: 'FAKE_NESTED_PROVIDER_TEXT_DO_NOT_USE' },
      },
      conversation: {
        metadata: {
          lastHermesIncident: {
            category: 'PROVIDER_ERROR',
            code: 'FAKE_PROVIDER_CODE_DO_NOT_USE',
            summary: 'FAKE_UNEXPECTED_PROVIDER_TEXT_DO_NOT_USE',
          },
        },
      },
    };
    const { conversation: _conversation, ...listed } = stored;
    const prisma = {
      task: {
        findMany: jest.fn().mockResolvedValue([listed]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue(stored),
      },
    } as unknown as PrismaService;
    const service = new TasksService(prisma);

    const list = await service.findAll();
    const detail = await service.findOne(stored.id);

    for (const output of [list.data[0], detail]) {
      expect(JSON.stringify(output)).not.toContain('FAKE_');
      expect(output).toMatchObject({
        description:
          'Revisar incidencia de Hermes: No se pudo completar la respuesta del proveedor.',
        metadata: {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          summary: 'No se pudo completar la respuesta del proveedor.',
        },
      });
    }
    expect(detail.conversation).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          lastHermesIncident: expect.objectContaining({
            summary: 'No se pudo completar la respuesta del proveedor.',
          }),
        }),
      }),
    );
  });

  it('keeps a user task description outside the provider review flow', async () => {
    const task = {
      id: 'user-task-1',
      type: TaskType.GENERAL,
      title: 'Nota manual',
      description: 'Texto legítimo del usuario.',
      metadata: { source: 'manual' },
    };
    const prisma = {
      task: { findUnique: jest.fn().mockResolvedValue(task) },
    } as unknown as PrismaService;

    expect(await new TasksService(prisma).findOne(task.id)).toEqual(task);
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
    type UpdateArgs = {
      where: { id: string };
      data: { dueAt: Date; metadata: { actionStatus: string } };
    };
    let capturedUpdateArgs: UpdateArgs | undefined;
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
        update: jest.fn((args: UpdateArgs) => {
          capturedUpdateArgs = args;
          return Promise.resolve({ ...existing, dueAt: requestedAt });
        }),
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

    expect(capturedUpdateArgs?.where.id).toBe('task-1');
    expect(capturedUpdateArgs?.data.dueAt).toEqual(requestedAt);
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(capturedUpdateArgs?.data.metadata.actionStatus).toBe(
      'PENDING_CONFIRMATION',
    );
  });
});

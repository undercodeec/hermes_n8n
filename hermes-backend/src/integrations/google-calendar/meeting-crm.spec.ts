/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Prisma payload assertions use Jest asymmetric matchers. */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Meeting, Prisma } from '@prisma/client';
import { TasksService } from '../../tasks/tasks.service';
import { LeadsService } from '../../leads/leads.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('Confirmed meeting CRM policy', () => {
  it.each([
    'NEW',
    'CONTACTED',
    'QUALIFIED',
    'PROPOSAL',
    'NEGOTIATION',
    'WON',
    'LOST',
  ])('never degrades %s', async (stage) => {
    const tx = {
      $executeRaw: jest.fn(),
      lead: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'lead', stage, contactId: 'contact' }),
        update: jest.fn().mockResolvedValue({
          id: 'lead',
          stage: 'QUALIFIED',
          contactId: 'contact',
        }),
      },
      contact: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ name: 'Cliente', waId: 'test' }),
      },
      auditLog: { create: jest.fn() },
    };
    const service = new LeadsService(
      {} as PrismaService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { isActive: () => false } as ClsService,
      new ConfigService({}),
    );
    await service.recordConfirmedMeeting(
      tx as unknown as Prisma.TransactionClient,
      {
        id: 'meeting',
        leadId: 'lead',
        contactId: 'contact',
        conversationId: 'conversation',
        status: 'CONFIRMED',
      } as Meeting,
    );
    expect(tx.lead.update).toHaveBeenCalledTimes(
      ['NEW', 'CONTACTED'].includes(stage) ? 1 : 0,
    );
  });
  it('creates appointment task and updates same task on cancellation', async () => {
    const tx = {
      task: {
        create: jest.fn().mockResolvedValue({ id: 'task' }),
        update: jest.fn().mockResolvedValue({ id: 'task' }),
      },
    };
    const service = new TasksService({} as PrismaService);
    const meeting = {
      id: 'meeting',
      conversationId: 'conversation',
      leadId: 'lead',
      status: 'CONFIRMED',
      startAt: new Date('2026-09-28T14:00:00Z'),
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    } as Meeting;
    await service.syncMeeting(
      tx as unknown as Prisma.TransactionClient,
      meeting,
    );
    expect(tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'APPOINTMENT', status: 'PENDING' }),
    });
    await service.syncMeeting(tx as unknown as Prisma.TransactionClient, {
      ...meeting,
      taskId: 'task',
      status: 'CANCELLED',
    });
    expect(tx.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task' },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
  });
});

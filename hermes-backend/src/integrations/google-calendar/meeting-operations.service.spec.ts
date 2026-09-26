/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- State-preserving database double; real PostgreSQL exercised by integration suite. */
import { ConfigService } from '@nestjs/config';
import { MeetingOperationsService } from './meeting-operations.service';
import { GoogleCalendarService } from './google-calendar.service';
import { TasksService } from '../../tasks/tasks.service';
import { LeadsService } from '../../leads/leads.service';

export function operationFixture() {
  let meeting: any, operation: any;
  const tx: any = {
    $executeRaw: jest.fn(),
    conversation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status: 'ACTIVE',
        contactId: 'contact',
        lead: { id: 'lead' },
      }),
    },
    meeting: {
      findUnique: jest.fn(async () => meeting ?? null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }) => {
        meeting = { ...data, taskId: null, status: 'PENDING' };
        return meeting;
      }),
      update: jest.fn(async ({ data }) => {
        meeting = { ...meeting, ...data };
        return meeting;
      }),
    },
    meetingOperation: {
      findUnique: jest.fn(async () => operation ?? null),
      findFirst: jest.fn(async () =>
        operation &&
        ['PREPARED', 'APPLYING', 'RETRY'].includes(operation.status as string)
          ? operation
          : null,
      ),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }) => {
        operation = {
          ...data,
          id: 'operation',
          status: 'PREPARED',
          attempts: 0,
          claimExpiresAt: null,
        };
        return operation;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (
          !operation ||
          (where.claimToken && where.claimToken !== operation.claimToken)
        )
          return { count: 0 };
        operation = { ...operation, ...data, attempts: operation.attempts + 1 };
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }) => {
        operation = { ...operation, ...data };
        return operation;
      }),
    },
    conversationState: { upsert: jest.fn() },
    automatedDelivery: { upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  tx.meeting.findUniqueOrThrow = tx.meeting.findUnique;
  tx.meetingOperation.findUniqueOrThrow = tx.meetingOperation.findUnique;
  const prisma = { ...tx, $transaction: jest.fn(async (work) => work(tx)) };
  const google = {
    config: {
      enabled: true,
      calendarId: 'primary',
      timezone: 'America/Guayaquil',
      durationMinutes: 30,
      bufferMinutes: 15,
      businessStart: '09:00',
      businessEnd: '18:00',
      businessDays: [1, 2, 3, 4, 5],
    },
    getAvailability: jest.fn().mockResolvedValue([]),
    getEvent: jest.fn().mockResolvedValue(null),
    createEvent: jest.fn().mockResolvedValue({
      pending: false,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }),
    rescheduleEvent: jest.fn().mockResolvedValue({
      pending: false,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    }),
    cancelEvent: jest.fn(),
  };
  const tasks = { syncMeeting: jest.fn().mockResolvedValue({ id: 'task' }) };
  const leads = {
    recordConfirmedMeeting: jest.fn().mockResolvedValue(null),
    publishMeetingQualification: jest.fn(),
  };
  const service = new MeetingOperationsService(
    prisma,
    google as unknown as GoogleCalendarService,
    tasks as unknown as TasksService,
    leads as unknown as LeadsService,
    new ConfigService({ NODE_ENV: 'development' }),
    {
      deliverPreparedBatch: jest.fn().mockResolvedValue({ terminal: true }),
    } as any,
  );
  return {
    service,
    google,
    prisma,
    tx,
    getMeeting: () => meeting,
    getOperation: () => operation,
  };
}
describe('Durable meeting operations', () => {
  const turn = {
    conversationId: 'conversation',
    contactId: 'contact',
    sourceMessageId: 'message',
    text: 'sí',
    now: new Date('2026-09-27T12:00:00Z'),
  };
  const input = {
    key: 'selection',
    slot: { start: '2026-09-28T14:00:00Z', end: '2026-09-28T14:30:00Z' },
    email: 'client@example.com',
  };
  it('reserves once and returns the same operation for repeated confirmation', async () => {
    const f = operationFixture();
    const first = await f.service.prepare('CREATE', turn, input);
    const second = await f.service.prepare('CREATE', turn, input);
    expect(second.id).toBe(first.id);
    expect(f.tx.meeting.create).toHaveBeenCalledTimes(1);
  });
  it('revalidates before Google insert and confirms after local persistence', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    expect((await f.service.apply(op.id)).status).toBe('CONFIRMED');
    expect(f.google.getAvailability).toHaveBeenCalled();
    expect(f.getMeeting().taskId).toBe('task');
  });
  it('does not insert when slot becomes busy', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.google.getAvailability.mockResolvedValue([input.slot]);
    await expect(f.service.apply(op.id)).rejects.toMatchObject({
      code: 'MEETING_SLOT_OCCUPIED',
    });
    expect(f.google.createEvent).not.toHaveBeenCalled();
    expect(f.getMeeting().status).toBe('FAILED');
  });
  it('recovers an already created event without counting itself busy', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.google.getEvent.mockResolvedValue({
      start: { dateTime: input.slot.start },
      end: { dateTime: input.slot.end },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });
    f.google.resolveEvent = jest.fn().mockResolvedValue({
      pending: false,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    });
    expect((await f.service.apply(op.id)).status).toBe('CONFIRMED');
    expect(f.google.createEvent).not.toHaveBeenCalled();
    expect(f.google.getAvailability).not.toHaveBeenCalled();
  });
  it('keeps pending conference durable without a false confirmation', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.google.createEvent.mockResolvedValue({ pending: true });
    await expect(f.service.apply(op.id)).rejects.toMatchObject({
      code: 'MEETING_OPERATION_PENDING',
    });
    expect(f.getMeeting().status).toBe('PENDING');
    expect(f.getOperation().status).toBe('RETRY');
  });
  it('never creates remotely after human takeover', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.tx.conversation.findUniqueOrThrow.mockResolvedValue({
      status: 'HANDED_OFF',
    });
    await expect(f.service.apply(op.id)).rejects.toBeDefined();
    expect(f.google.createEvent).not.toHaveBeenCalled();
    expect(f.getOperation().status).toBe('FAILED');
  });
  it('persists one completion notice on recovered success', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.tx.meetingOperation.findMany.mockResolvedValue([op]);
    await f.service.recover();
    expect(f.tx.automatedDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { operationKey: 'message:SYSTEM_NOTICE:1000' },
        create: expect.objectContaining({
          allowHandedOff: false,
          content: expect.stringContaining(
            'https://meet.google.com/abc-defg-hij',
          ),
        }),
      }),
    );
    await f.service.recover();
    expect(f.tx.automatedDelivery.upsert).toHaveBeenCalledTimes(1);
  });
  it('reconciles already applied action even after takeover without new mutations', async () => {
    const f = operationFixture();
    const op = await f.service.prepare('CREATE', turn, input);
    f.tx.conversation.findUniqueOrThrow.mockResolvedValue({
      status: 'HANDED_OFF',
    });
    f.google.getEvent.mockResolvedValue({
      start: { dateTime: input.slot.start },
      end: { dateTime: input.slot.end },
    });
    f.google.resolveEvent = jest.fn().mockResolvedValue({
      pending: false,
      meetUrl: 'https://meet.google.com/abc-defg-hij',
    });
    expect((await f.service.apply(op.id)).status).toBe('CONFIRMED');
    expect(f.google.createEvent).not.toHaveBeenCalled();
  });
});

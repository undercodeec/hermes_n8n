import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MeetingOperationsService } from '../src/integrations/google-calendar/meeting-operations.service';
import { GoogleCalendarService } from '../src/integrations/google-calendar/google-calendar.service';
import { TasksService } from '../src/tasks/tasks.service';
import { LeadsService } from '../src/leads/leads.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MeetingTurn } from '../src/integrations/google-calendar/calendar.types';
import { AutomatedDeliveryService } from '../src/automated-deliveries/automated-delivery.service';
import { MetaService } from '../src/meta/meta.service';

const databaseUrl = process.env.CALENDAR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
describeDatabase(
  'Calendar persistence with real PostgreSQL and mocked Google',
  () => {
    const schemas = [
      `calendar_clean_${randomUUID().replace(/-/g, '')}`,
      `calendar_upgrade_${randomUUID().replace(/-/g, '')}`,
    ];
    let admin: PrismaClient;
    let prisma: PrismaClient;
    let operations: MeetingOperationsService;
    let tasks: TasksService;
    let leads: LeadsService;
    const migrationPath = join(__dirname, '../prisma/migrations');
    const migrations = readdirSync(migrationPath)
      .filter((n) => n !== 'migration_lock.toml')
      .sort();
    const psql = process.env.CALENDAR_TEST_PSQL ?? 'psql';
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
      getEvent: jest.fn(),
      resolveEvent: jest.fn(),
      getAvailability: jest.fn().mockResolvedValue([]),
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
    const turn: MeetingTurn = {
      conversationId: 'conversation',
      contactId: 'contact',
      sourceMessageId: 'message',
      text: 'sí',
      now: new Date(),
    };
    // Next Monday avoids coupling fixtures to the machine's wall-clock weekday.
    const future = new Date();
    future.setUTCDate(
      future.getUTCDate() + ((8 - future.getUTCDay()) % 7 || 7),
    );
    future.setUTCHours(14, 0, 0, 0);
    const input = {
      key: 'fixture-reservation',
      slot: {
        start: future.toISOString(),
        end: new Date(future.getTime() + 1800000).toISOString(),
      },
      email: 'client@example.com',
    };
    function applySql(schema: string, sql: string): void {
      const url = new URL(databaseUrl!);
      const result = spawnSync(
        psql,
        [
          '-h',
          url.hostname,
          '-p',
          url.port || '5432',
          '-U',
          decodeURIComponent(url.username),
          '-d',
          url.pathname.slice(1),
          '--no-password',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          input: `SET search_path TO "${schema}";\n${sql}`,
          env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Temporary-schema migration failed: ${result.stderr?.slice(0, 1000)}`,
        );
    }
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new Error(
          'Calendar DB tests require explicit local temporary infrastructure',
        );
      admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      for (const schema of schemas)
        await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const name of migrations)
        applySql(
          schemas[0],
          readFileSync(join(migrationPath, name, 'migration.sql'), 'utf8'),
        );
      for (const name of migrations.slice(0, -1))
        applySql(
          schemas[1],
          readFileSync(join(migrationPath, name, 'migration.sql'), 'utf8'),
        );
      applySql(
        schemas[1],
        `INSERT INTO contacts (id,"waId",email,"updatedAt") VALUES ('contact','test-contact','client@example.com',NOW()); INSERT INTO conversations (id,"contactId","updatedAt") VALUES ('conversation','contact',NOW()); INSERT INTO leads (id,"contactId","conversationId","updatedAt") VALUES ('lead','contact','conversation',NOW()); INSERT INTO tasks (id,"leadId","conversationId",title,"updatedAt") VALUES ('legacy-task','lead','conversation','Existing follow-up',NOW());`,
      );
      applySql(
        schemas[1],
        readFileSync(
          join(migrationPath, migrations.at(-1)!, 'migration.sql'),
          'utf8',
        ),
      );
      url.searchParams.set('schema', schemas[1]);
      prisma = new PrismaClient({
        datasources: { db: { url: url.toString() } },
      });
      tasks = new TasksService(prisma as PrismaService);
      leads = new LeadsService(
        prisma as PrismaService,
        new EventEmitter2(),
        { isActive: () => false } as ClsService,
        new ConfigService({}),
      );
      operations = new MeetingOperationsService(
        prisma as PrismaService,
        google as unknown as GoogleCalendarService,
        tasks,
        leads,
        new ConfigService({ NODE_ENV: 'test' }),
      );
    }, 60000);
    afterAll(async () => {
      await prisma?.$disconnect();
      if (admin) {
        for (const schema of schemas) {
          if (!/^calendar_(clean|upgrade)_[a-f0-9]{32}$/.test(schema))
            throw new Error('Unsafe cleanup');
          await admin.$executeRawUnsafe(
            `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
          );
        }
        await admin.$disconnect();
      }
    });
    it('migrates clean schema and upgrade preserving CRM fixtures', async () => {
      expect(
        await prisma.task.findUnique({ where: { id: 'legacy-task' } }),
      ).toMatchObject({ title: 'Existing follow-up' });
      expect(await prisma.conversationState.count()).toBe(0);
      expect(await prisma.meeting.count()).toBe(0);
    });
    it('reserves once under concurrent duplicate confirmations', async () => {
      const [a, b] = await Promise.all([
        operations.prepare('CREATE', turn, input),
        operations.prepare('CREATE', turn, input),
      ]);
      expect(a.id).toBe(b.id);
      expect(await prisma.meeting.count()).toBe(1);
    });
    it('rejects a competing conversation for the same buffered slot', async () => {
      await prisma.contact.create({
        data: { id: 'contact-other', waId: 'other' },
      });
      await prisma.conversation.create({
        data: { id: 'conversation-other', contactId: 'contact-other' },
      });
      await expect(
        operations.prepare(
          'CREATE',
          {
            ...turn,
            conversationId: 'conversation-other',
            contactId: 'contact-other',
          },
          { ...input, key: 'competing' },
        ),
      ).rejects.toMatchObject({ code: 'MEETING_SLOT_OCCUPIED' });
    });
    it('serializes simultaneous reservations from distinct conversations', async () => {
      const raceSlot = {
        start: new Date(future.getTime() + 14400000).toISOString(),
        end: new Date(future.getTime() + 16200000).toISOString(),
      };
      const outcomes = await Promise.allSettled([
        operations.prepare('CREATE', turn, {
          ...input,
          key: 'race-first',
          slot: raceSlot,
        }),
        operations.prepare(
          'CREATE',
          {
            ...turn,
            conversationId: 'conversation-other',
            contactId: 'contact-other',
          },
          { ...input, key: 'race-second', slot: raceSlot },
        ),
      ]);
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await prisma.meetingOperation.updateMany({
        where: { operationKey: { in: ['race-first', 'race-second'] } },
        data: { status: 'FAILED' },
      });
      await prisma.meeting.updateMany({
        where: { idempotencyKey: { in: ['race-first', 'race-second'] } },
        data: { status: 'FAILED' },
      });
    });
    it('reconciles event created remotely before SQL completion and qualifies CRM once', async () => {
      const operation = await prisma.meetingOperation.findUniqueOrThrow({
        where: { operationKey: input.key },
      });
      const remote = {
        start: { dateTime: input.slot.start },
        end: { dateTime: input.slot.end },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      };
      google.getEvent.mockResolvedValue(null);
      google.createEvent.mockImplementationOnce(() => {
        google.getEvent.mockResolvedValue(remote);
        return Promise.resolve({
          pending: false,
          meetUrl: 'https://meet.google.com/abc-defg-hij',
        });
      });
      google.resolveEvent.mockResolvedValue({
        pending: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      });
      const actualSync = tasks.syncMeeting.bind(tasks);
      const failure = jest
        .spyOn(tasks, 'syncMeeting')
        .mockImplementationOnce(async (tx, m) => {
          await actualSync(tx, m);
          throw new Error('Injected SQL completion rollback');
        });
      await expect(operations.apply(operation.id)).rejects.toBeDefined();
      expect(await prisma.task.count({ where: { type: 'APPOINTMENT' } })).toBe(
        0,
      );
      expect(
        await prisma.meeting.findUnique({ where: { id: operation.meetingId } }),
      ).toMatchObject({ status: 'PENDING' });
      failure.mockRestore();
      await prisma.meetingOperation.update({
        where: { id: operation.id },
        data: { claimExpiresAt: new Date(0) },
      });
      const meeting = await operations.apply(operation.id);
      expect(meeting.status).toBe('CONFIRMED');
      expect(google.createEvent).toHaveBeenCalledTimes(1);
      expect(await prisma.task.count({ where: { type: 'APPOINTMENT' } })).toBe(
        1,
      );
      expect(
        await prisma.lead.findUnique({ where: { id: 'lead' } }),
      ).toMatchObject({ stage: 'QUALIFIED' });
      await operations.apply(operation.id);
      expect(await prisma.task.count({ where: { type: 'APPOINTMENT' } })).toBe(
        1,
      );
    });
    it('reprograms the same event and task then cancels without downgrading the lead', async () => {
      const meeting = await prisma.meeting.findUniqueOrThrow({
        where: { idempotencyKey: input.key },
      });
      const newSlot = {
        start: new Date(future.getTime() + 7200000).toISOString(),
        end: new Date(future.getTime() + 9000000).toISOString(),
      };
      const move = await operations.prepare('RESCHEDULE', turn, {
        key: 'reschedule',
        slot: newSlot,
        email: input.email,
        meetingId: meeting.id,
      });
      const moved = await operations.apply(move.id);
      expect(moved.googleEventId).toBe(meeting.googleEventId);
      expect(moved.taskId).toBe(meeting.taskId);
      expect(moved.startAt.toISOString()).toBe(newSlot.start);
      expect(google.rescheduleEvent).toHaveBeenCalledTimes(1);
      const cancel = await operations.prepare('CANCEL', turn, {
        key: 'cancel',
        slot: newSlot,
        email: input.email,
        meetingId: meeting.id,
      });
      const cancelled = await operations.apply(cancel.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(
        await prisma.task.findUnique({ where: { id: meeting.taskId! } }),
      ).toMatchObject({ status: 'CANCELLED' });
      expect(
        await prisma.lead.findUnique({ where: { id: 'lead' } }),
      ).toMatchObject({ stage: 'QUALIFIED' });
    });
    it('delivers exactly one durable confirmation when pending Meet becomes ready', async () => {
      const source = await prisma.message.create({
        data: {
          conversationId: turn.conversationId,
          contactId: turn.contactId,
          direction: 'INBOUND',
          content: 'confirmo reunión',
        },
      });
      const slot = {
        start: new Date(future.getTime() + 86400000).toISOString(),
        end: new Date(future.getTime() + 88200000).toISOString(),
      };
      const op = await operations.prepare(
        'CREATE',
        { ...turn, sourceMessageId: source.id },
        { ...input, key: 'recovered-notice', slot },
      );
      google.getEvent.mockResolvedValue(null);
      google.createEvent.mockImplementationOnce(() => {
        google.getEvent.mockResolvedValue({
          start: { dateTime: slot.start },
          end: { dateTime: slot.end },
        });
        return Promise.resolve({ pending: true, meetUrl: '' });
      });
      await expect(operations.apply(op.id)).rejects.toMatchObject({
        code: 'MEETING_OPERATION_PENDING',
      });
      await prisma.meetingOperation.update({
        where: { id: op.id },
        data: { claimExpiresAt: new Date(0) },
      });
      google.resolveEvent.mockResolvedValue({
        pending: false,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      });
      const meta = {
        sendTextMessage: jest
          .fn()
          .mockResolvedValue({ messages: [{ id: 'mock-confirmation-wamid' }] }),
      };
      const deliveries = new AutomatedDeliveryService(
        prisma as PrismaService,
        meta as unknown as MetaService,
      );
      const recovery = new MeetingOperationsService(
        prisma as PrismaService,
        google as unknown as GoogleCalendarService,
        tasks,
        leads,
        new ConfigService({ NODE_ENV: 'development' }),
        deliveries,
      );
      await recovery.recover();
      await recovery.recover();
      expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(meta.sendTextMessage).toHaveBeenCalledWith(
        'test-contact',
        expect.stringContaining('https://meet.google.com/abc-defg-hij'),
      );
      const notice = await prisma.automatedDelivery.findUniqueOrThrow({
        where: { operationKey: `${source.id}:SYSTEM_NOTICE:1000` },
      });
      expect(notice.status).toBe('CONFIRMED');
      expect(notice.content).toContain('America/Guayaquil');
    });
  },
);

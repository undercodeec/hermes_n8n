import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Meeting, MeetingOperationKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TasksService } from '../../tasks/tasks.service';
import { LeadsService } from '../../leads/leads.service';
import { GoogleCalendarService } from './google-calendar.service';
import { CalendarError } from './calendar.errors';
import { CalendarSlot, MeetingDraft, MeetingTurn } from './calendar.types';
import { generateSlots, overlaps, validRange } from './slot-engine';
import { AutomatedDeliveryService } from '../../automated-deliveries/automated-delivery.service';

const ACTIVE = ['PREPARED', 'APPLYING', 'RETRY'] as const;
export interface PrepareMeeting {
  key: string;
  slot: CalendarSlot;
  email: string;
  meetingId?: string;
}

@Injectable()
export class MeetingOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleCalendarService,
    private readonly tasks: TasksService,
    private readonly leads: LeadsService,
    private readonly config: ConfigService,
    @Optional() private readonly deliveries?: AutomatedDeliveryService,
  ) {}
  async interrupt(conversationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`;
      await tx.meetingOperation.updateMany({
        where: { meeting: { conversationId }, status: { in: [...ACTIVE] } },
        data: { errorCode: 'MEETING_INTERRUPTED' },
      });
    });
  }
  async localBusy(
    from: string,
    to: string,
    excludeMeetingId?: string,
  ): Promise<CalendarSlot[]> {
    const buffer = this.google.config.bufferMinutes * 60000;
    const meetings = await this.prisma.meeting.findMany({
      where: {
        calendarId: this.google.config.calendarId,
        id: excludeMeetingId ? { not: excludeMeetingId } : undefined,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startAt: { lt: new Date(Date.parse(to) + buffer) },
        endAt: { gt: new Date(Date.parse(from) - buffer) },
      },
    });
    const ops = await this.prisma.meetingOperation.findMany({
      where: {
        kind: 'RESCHEDULE',
        status: { in: [...ACTIVE] },
        meeting: {
          calendarId: this.google.config.calendarId,
          id: excludeMeetingId ? { not: excludeMeetingId } : undefined,
        },
        targetStartAt: { lt: new Date(Date.parse(to) + buffer) },
        targetEndAt: { gt: new Date(Date.parse(from) - buffer) },
      },
    });
    return [
      ...meetings.map((m) => ({
        start: m.startAt.toISOString(),
        end: m.endAt.toISOString(),
      })),
      ...ops.map((o) => ({
        start: o.targetStartAt.toISOString(),
        end: o.targetEndAt.toISOString(),
      })),
    ];
  }
  async prepare(
    kind: MeetingOperationKind,
    turn: MeetingTurn,
    input: PrepareMeeting,
  ) {
    if (!this.google.config.enabled)
      throw new CalendarError('GOOGLE_CALENDAR_DISABLED');
    if (
      !validRange({ from: input.slot.start, to: input.slot.end }) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    )
      throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`calendar:${this.google.config.calendarId}`}))`;
      const existing = await tx.meetingOperation.findUnique({
        where: { operationKey: input.key },
      });
      if (existing) {
        const owner = await tx.meeting.findUnique({
          where: { id: existing.meetingId },
        });
        if (
          owner?.conversationId !== turn.conversationId ||
          owner.contactId !== turn.contactId
        )
          throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
        return existing;
      }
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: turn.conversationId },
        include: { lead: true },
      });
      if (
        conversation.contactId !== turn.contactId ||
        conversation.status !== 'ACTIVE'
      )
        throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
      let meeting = input.meetingId
        ? await tx.meeting.findUnique({ where: { id: input.meetingId } })
        : null;
      if (
        kind !== 'CREATE' &&
        (!meeting ||
          meeting.conversationId !== turn.conversationId ||
          meeting.contactId !== turn.contactId ||
          meeting.status !== 'CONFIRMED')
      )
        throw new CalendarError('GOOGLE_CALENDAR_EVENT_UPDATE_FAILED');
      if (meeting) {
        const active = await tx.meetingOperation.findFirst({
          where: { meetingId: meeting.id, status: { in: [...ACTIVE] } },
        });
        if (active) throw new CalendarError('MEETING_OPERATION_PENDING', true);
      }
      if (kind !== 'CANCEL') {
        const valid = generateSlots(
          { from: input.slot.start, to: input.slot.end },
          [],
          this.google.config,
          turn.now,
        );
        if (
          !valid.some(
            (s) => Date.parse(s.start) === Date.parse(input.slot.start),
          )
        )
          throw new CalendarError('MEETING_SLOT_OCCUPIED');
        const buffer = this.google.config.bufferMinutes * 60000;
        const conflicts = await tx.meeting.findMany({
          where: {
            calendarId: this.google.config.calendarId,
            id: meeting ? { not: meeting.id } : undefined,
            status: { in: ['PENDING', 'CONFIRMED'] },
            startAt: { lt: new Date(Date.parse(input.slot.end) + buffer) },
            endAt: { gt: new Date(Date.parse(input.slot.start) - buffer) },
          },
        });
        const pending = await tx.meetingOperation.findMany({
          where: {
            kind: 'RESCHEDULE',
            status: { in: [...ACTIVE] },
            meeting: {
              calendarId: this.google.config.calendarId,
              id: meeting ? { not: meeting.id } : undefined,
            },
            targetStartAt: {
              lt: new Date(Date.parse(input.slot.end) + buffer),
            },
            targetEndAt: {
              gt: new Date(Date.parse(input.slot.start) - buffer),
            },
          },
        });
        if (conflicts.length || pending.length)
          throw new CalendarError('MEETING_SLOT_OCCUPIED');
      }
      if (!meeting) {
        const id = randomUUID();
        meeting = await tx.meeting.create({
          data: {
            id,
            conversationId: turn.conversationId,
            contactId: turn.contactId,
            leadId: conversation.lead?.id,
            calendarId: this.google.config.calendarId,
            googleEventId: createHash('sha256').update(input.key).digest('hex'),
            attendeeEmail: input.email,
            startAt: new Date(input.slot.start),
            endAt: new Date(input.slot.end),
            timezone: this.google.config.timezone,
            idempotencyKey: input.key,
            serviceContext: turn.serviceContext?.slice(0, 240),
          },
        });
      }
      return tx.meetingOperation.create({
        data: {
          meetingId: meeting.id,
          operationKey: input.key,
          sourceMessageId: turn.sourceMessageId,
          kind,
          targetStartAt: new Date(input.slot.start),
          targetEndAt: new Date(input.slot.end),
        },
      });
    });
  }
  async apply(operationId: string, notify = false): Promise<Meeting> {
    const operation = await this.prisma.meetingOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    let meeting = await this.prisma.meeting.findUniqueOrThrow({
      where: { id: operation.meetingId },
    });
    if (operation.status === 'COMPLETED') return meeting;
    if (operation.status === 'FAILED')
      throw new CalendarError('MEETING_SLOT_OCCUPIED');
    const token = randomUUID(),
      now = new Date();
    const claimed = await this.prisma.meetingOperation.updateMany({
      where: {
        id: operationId,
        OR: [
          { status: 'PREPARED' },
          { status: 'RETRY', claimExpiresAt: { lte: now } },
          { status: 'APPLYING', claimExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'APPLYING',
        claimToken: token,
        claimExpiresAt: new Date(now.getTime() + 180000),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count)
      throw new CalendarError('MEETING_OPERATION_PENDING', true);
    const draft: MeetingDraft = {
      meetingId: meeting.id,
      eventId: meeting.googleEventId,
      calendarId: meeting.calendarId,
      slot: {
        start: operation.targetStartAt.toISOString(),
        end: operation.targetEndAt.toISOString(),
      },
      timezone: meeting.timezone,
      email: meeting.attendeeEmail,
      serviceContext: meeting.serviceContext ?? undefined,
    };
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: meeting.conversationId },
    });
    let interrupted =
      operation.errorCode === 'MEETING_INTERRUPTED' ||
      conversation.status !== 'ACTIVE';
    let mutationBlocked = false;
    const mutate = async <T>(action: () => Promise<T>): Promise<T> =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${meeting.conversationId}))`;
          const conversation = await tx.conversation.findUniqueOrThrow({
            where: { id: meeting.conversationId },
          });
          const current = await tx.meetingOperation.findUniqueOrThrow({
            where: { id: operationId },
          });
          if (
            conversation.status !== 'ACTIVE' ||
            current.errorCode === 'MEETING_INTERRUPTED'
          ) {
            interrupted = true;
            mutationBlocked = true;
            throw new CalendarError('MEETING_OPERATION_PENDING');
          }
          return action();
        },
        { timeout: 120000 },
      );
    try {
      const remote = await this.google.getEvent(draft);
      let meetUrl = meeting.meetUrl;
      if (operation.kind === 'CANCEL') {
        if (remote)
          await mutate(() =>
            this.google.cancelEvent(meeting.calendarId, meeting.googleEventId),
          );
      } else {
        const alreadyApplied =
          remote &&
          Date.parse(remote.start?.dateTime ?? '') ===
            Date.parse(draft.slot.start) &&
          Date.parse(remote.end?.dateTime ?? '') === Date.parse(draft.slot.end);
        let result;
        if (alreadyApplied)
          result = await this.google.resolveEvent(draft, remote);
        else {
          if (operation.kind === 'CREATE' && remote)
            throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
          const buffer = this.google.config.bufferMinutes * 60000;
          const busy = await this.google.getAvailability({
            from: new Date(Date.parse(draft.slot.start) - buffer).toISOString(),
            to: new Date(Date.parse(draft.slot.end) + buffer).toISOString(),
            excludeEventId:
              operation.kind === 'RESCHEDULE'
                ? meeting.googleEventId
                : undefined,
          });
          if (
            Date.parse(draft.slot.start) <= Date.now() ||
            busy.some((b) =>
              overlaps(draft.slot, b, this.google.config.bufferMinutes),
            )
          )
            throw new CalendarError('MEETING_SLOT_OCCUPIED');
          result =
            operation.kind === 'CREATE'
              ? await mutate(() => this.google.createEvent(draft))
              : await mutate(() => this.google.rescheduleEvent(draft));
        }
        if (result.pending || !result.meetUrl)
          throw new CalendarError('MEETING_OPERATION_PENDING', true);
        meetUrl = result.meetUrl;
      }
      const final = await this.prisma.$transaction(async (tx) => {
        const fenced = await tx.meetingOperation.updateMany({
          where: { id: operationId, status: 'APPLYING', claimToken: token },
          data: {
            status: 'COMPLETED',
            errorCode: interrupted ? 'MEETING_INTERRUPTED' : null,
            claimExpiresAt: null,
          },
        });
        if (!fenced.count)
          throw new CalendarError('MEETING_OPERATION_PENDING', true);
        const previous = await tx.meeting.findUniqueOrThrow({
          where: { id: meeting.id },
        });
        meeting = await tx.meeting.update({
          where: { id: meeting.id },
          data: {
            status: operation.kind === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
            startAt: new Date(draft.slot.start),
            endAt: new Date(draft.slot.end),
            meetUrl,
            cancelledAt: operation.kind === 'CANCEL' ? new Date() : null,
          },
        });
        const task = await this.tasks.syncMeeting(tx, meeting);
        meeting = await tx.meeting.update({
          where: { id: meeting.id },
          data: { taskId: task.id },
        });
        await tx.auditLog.create({
          data: {
            action: `MEETING_${operation.kind}`,
            entity: 'meetings',
            entityId: meeting.id,
            changes: {
              before: {
                startAt: previous.startAt.toISOString(),
                endAt: previous.endAt.toISOString(),
                status: previous.status,
              },
              after: {
                startAt: meeting.startAt.toISOString(),
                endAt: meeting.endAt.toISOString(),
                status: meeting.status,
              },
              operationId,
            },
          },
        });
        const qualification = await this.leads.recordConfirmedMeeting(
          tx,
          meeting,
        );
        if (notify && !interrupted) {
          const date = new Intl.DateTimeFormat('es-EC', {
            timeZone: meeting.timezone,
            dateStyle: 'full',
            timeStyle: 'short',
          }).format(meeting.startAt);
          await tx.automatedDelivery.upsert({
            where: {
              operationKey: `${operation.sourceMessageId}:SYSTEM_NOTICE:1000`,
            },
            create: {
              operationKey: `${operation.sourceMessageId}:SYSTEM_NOTICE:1000`,
              deliveryKind: 'SYSTEM_NOTICE',
              partIndex: 1000,
              conversationId: meeting.conversationId,
              contactId: meeting.contactId,
              sourceMessageId: operation.sourceMessageId,
              sender: 'SYSTEM',
              allowHandedOff: false,
              content:
                operation.kind === 'CANCEL'
                  ? 'Su reunión quedó cancelada. La invitación del calendario fue actualizada.'
                  : `Su reunión quedó agendada para ${date} (${meeting.timezone}). La invitación fue enviada al correo indicado. Google Meet: ${meeting.meetUrl}`,
              metadata: {
                action: 'GOOGLE_CALENDAR_RECOVERED',
                meetingId: meeting.id,
                operationId,
              },
            },
            update: {},
          });
          await tx.meetingOperation.update({
            where: { id: operationId },
            data: { errorCode: 'MEETING_NOTIFICATION_PENDING' },
          });
        }
        return { meeting, qualification };
      });
      this.leads.publishMeetingQualification(final.qualification);
      return final.meeting;
    } catch (error) {
      const code =
        error instanceof CalendarError
          ? error.code
          : 'GOOGLE_CALENDAR_EVENT_CREATE_FAILED';
      const slotConflict = code === 'MEETING_SLOT_OCCUPIED' || mutationBlocked;
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.meetingOperation.updateMany({
          where: { id: operationId, status: 'APPLYING', claimToken: token },
          data: {
            status: slotConflict ? 'FAILED' : 'RETRY',
            errorCode: interrupted ? 'MEETING_INTERRUPTED' : code,
            claimExpiresAt: new Date(Date.now() + 60000),
          },
        });
        if (updated.count && slotConflict && operation.kind === 'CREATE')
          await tx.meeting.update({
            where: { id: meeting.id },
            data: { status: 'FAILED' },
          });
      });
      throw error instanceof CalendarError
        ? error
        : new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED', true);
    }
  }
  async recover(): Promise<void> {
    if (!this.google.config.enabled || this.config.get('NODE_ENV') === 'test')
      return;
    const operations = await this.prisma.meetingOperation.findMany({
      where: {
        OR: [
          { status: 'COMPLETED', errorCode: 'MEETING_NOTIFICATION_PENDING' },
          { status: 'PREPARED' },
          {
            status: { in: ['RETRY', 'APPLYING'] },
            claimExpiresAt: { lte: new Date() },
          },
        ],
      },
      take: 10,
      orderBy: { createdAt: 'asc' },
    });
    for (const op of operations) {
      try {
        await this.apply(op.id, true);
        const current = await this.prisma.meetingOperation.findUniqueOrThrow({
          where: { id: op.id },
        });
        if (
          current.errorCode === 'MEETING_NOTIFICATION_PENDING' &&
          this.deliveries
        ) {
          const delivery = await this.deliveries.deliverPreparedBatch(
            op.sourceMessageId,
          );
          if (delivery.terminal)
            await this.prisma.meetingOperation.updateMany({
              where: { id: op.id, errorCode: 'MEETING_NOTIFICATION_PENDING' },
              data: { errorCode: null },
            });
        }
      } catch {
        /* Structured error persisted; retry next scan. */
      }
    }
  }
}

import { MeetingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MeetingReadService } from './meeting-read.service';

describe('CRM meeting read model', () => {
  const from = '2026-09-28T05:00:00.000Z';
  const to = '2026-10-05T05:00:00.000Z';
  const contact = {
    id: 'contact',
    name: 'Ana',
    company: 'Demo',
    email: null,
    phone: null,
    waId: '593999999999',
  };
  const record = (id: string, startAt: string, endAt: string) => ({
    id,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    status: MeetingStatus.CONFIRMED,
    timezone: 'America/Guayaquil',
    meetUrl: null,
    serviceContext: 'Demo',
    cancelledAt: null,
    contact,
    lead: null,
    conversation: null,
    task: null,
  });

  it('returns overlapping meetings, excludes adjacent records and preserves nullable summaries', async () => {
    const records = [
      record('before', '2026-09-28T04:00:00Z', from),
      record('overlap-start', '2026-09-28T04:45:00Z', '2026-09-28T05:15:00Z'),
      record('overlap-end', '2026-10-05T04:45:00Z', '2026-10-05T05:15:00Z'),
      record('after', to, '2026-10-05T06:00:00Z'),
    ];
    const prisma = {
      meeting: {
        findMany: ({ where, select, orderBy }: Prisma.MeetingFindManyArgs) => {
          expect(where).toEqual({
            startAt: { lt: new Date(to) },
            endAt: { gt: new Date(from) },
          });
          expect(orderBy).toEqual({ startAt: 'asc' });
          expect(select).not.toHaveProperty('googleEventId');
          expect(select).not.toHaveProperty('calendarId');
          expect(select).not.toHaveProperty('attendeeEmail');
          const bounds = where as {
            startAt: { lt: Date };
            endAt: { gt: Date };
          };
          return Promise.resolve(
            records.filter(
              (r) => r.startAt < bounds.startAt.lt && r.endAt > bounds.endAt.gt,
            ),
          );
        },
      },
    };
    const result = await new MeetingReadService(
      prisma as unknown as PrismaService,
    ).listForCrm({ from, to });
    expect(result.range).toEqual({ from, to });
    expect(result.data).toEqual([
      {
        ...records[1],
        startAt: '2026-09-28T04:45:00.000Z',
        endAt: '2026-09-28T05:15:00.000Z',
      },
      {
        ...records[2],
        startAt: '2026-10-05T04:45:00.000Z',
        endAt: '2026-10-05T05:15:00.000Z',
      },
    ]);
  });

  it('applies optional stored-timezone and status filters and normalizes instants', async () => {
    const meeting = {
      ...record('confirmed', '2026-09-28T16:00:00Z', '2026-09-28T16:30:00Z'),
      cancelledAt: new Date('2026-09-28T15:00:00Z'),
      lead: { id: 'lead', stage: 'QUALIFIED', productOfInterest: null },
      conversation: { id: 'conversation', status: 'OPEN' },
      task: { id: 'task', status: 'PENDING', title: 'Demo' },
    };
    const prisma = {
      meeting: {
        findMany: (args: Prisma.MeetingFindManyArgs) => {
          expect(args.where).toMatchObject({
            status: MeetingStatus.CONFIRMED,
            timezone: 'Europe/Madrid',
          });
          return Promise.resolve([meeting]);
        },
      },
    };
    const result = await new MeetingReadService(
      prisma as unknown as PrismaService,
    ).listForCrm({
      from: '2026-09-28T00:00:00-05:00',
      to,
      status: MeetingStatus.CONFIRMED,
      timezone: 'Europe/Madrid',
    });
    expect(result.range.from).toBe(from);
    expect(result.data[0]).toMatchObject({
      cancelledAt: '2026-09-28T15:00:00.000Z',
      lead: meeting.lead,
      conversation: meeting.conversation,
      task: meeting.task,
    });
  });
});

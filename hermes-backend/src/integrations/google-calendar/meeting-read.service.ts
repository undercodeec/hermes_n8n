import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QueryMeetingsDto } from './dto/query-meetings.dto';

const crmMeetingSelect = {
  id: true,
  status: true,
  startAt: true,
  endAt: true,
  timezone: true,
  meetUrl: true,
  serviceContext: true,
  cancelledAt: true,
  contact: {
    select: {
      id: true,
      name: true,
      company: true,
      email: true,
      phone: true,
      waId: true,
    },
  },
  lead: { select: { id: true, stage: true, productOfInterest: true } },
  conversation: { select: { id: true, status: true } },
  task: { select: { id: true, status: true, title: true } },
} satisfies Prisma.MeetingSelect;

@Injectable()
export class MeetingReadService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCrm(query: QueryMeetingsDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    const meetings = await this.prisma.meeting.findMany({
      where: {
        startAt: { lt: to },
        endAt: { gt: from },
        ...(query.status ? { status: query.status } : {}),
        ...(query.timezone ? { timezone: query.timezone } : {}),
      },
      select: crmMeetingSelect,
      orderBy: { startAt: 'asc' },
    });
    return {
      data: meetings.map((meeting) => ({
        ...meeting,
        startAt: meeting.startAt.toISOString(),
        endAt: meeting.endAt.toISOString(),
        cancelledAt: meeting.cancelledAt?.toISOString() ?? null,
        lead: meeting.lead ?? null,
        conversation: meeting.conversation ?? null,
        task: meeting.task ?? null,
      })),
      range: { from: from.toISOString(), to: to.toISOString() },
    };
  }
}

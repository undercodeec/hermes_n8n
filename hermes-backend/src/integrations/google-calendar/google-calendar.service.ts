import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  auth,
  calendar,
  calendar_v3,
} from 'googleapis/build/src/apis/calendar';
import { calendarConfigFromService } from './calendar.config';
import {
  AvailabilityRequest,
  CalendarConfig,
  CalendarSlot,
  MeetingDraft,
} from './calendar.types';
import {
  CalendarError,
  CalendarErrorCode,
  classifyCalendarError,
} from './calendar.errors';
import { validRange, zonedDate } from './slot-engine';

export const GOOGLE_CALENDAR_CLIENT = Symbol('GOOGLE_CALENDAR_CLIENT');
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
export interface CalendarEventResult {
  eventId: string;
  meetUrl?: string;
  pending: boolean;
  start?: string;
  end?: string;
}
export function createCalendarOAuth(
  config: Pick<CalendarConfig, 'clientId' | 'clientSecret' | 'redirectUri'>,
): InstanceType<typeof auth.OAuth2> {
  return new auth.OAuth2({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    transporterOptions: { timeout: 8000, retry: false },
  });
}

@Injectable()
export class GoogleCalendarService {
  readonly config: CalendarConfig;
  private readonly client: calendar_v3.Calendar;
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly options = { timeout: 8000, retry: false };
  constructor(
    config: ConfigService,
    @Optional() @Inject(GOOGLE_CALENDAR_CLIENT) client?: calendar_v3.Calendar,
    @Optional() private readonly cls?: ClsService,
  ) {
    this.config = calendarConfigFromService(config);
    const auth = createCalendarOAuth(this.config);
    if (this.config.refreshToken)
      auth.setCredentials({ refresh_token: this.config.refreshToken });
    this.client = client ?? calendar({ version: 'v3', auth });
  }
  private async call<T>(
    operation: string,
    code: CalendarErrorCode,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!this.config.enabled)
      throw new CalendarError('GOOGLE_CALENDAR_DISABLED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CalendarError(code, true)),
            10000,
          );
        }),
      ]);
    } catch (error) {
      const safe = classifyCalendarError(error, code);
      this.logger.warn(
        JSON.stringify({
          operation,
          traceId: this.cls?.isActive()
            ? (this.cls.get<string>('traceId') ?? randomUUID())
            : randomUUID(),
          code: safe.code,
          httpStatus: safe.httpStatus,
          transient: safe.transient,
        }),
      );
      throw safe;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async getAvailability(range: AvailabilityRequest): Promise<CalendarSlot[]> {
    if (!validRange(range))
      throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
    const busy = await this.call(
      'freeBusy',
      'GOOGLE_CALENDAR_FREEBUSY_FAILED',
      async () => {
        const result = await this.client.freebusy.query(
          {
            requestBody: {
              timeMin: range.from,
              timeMax: range.to,
              timeZone: this.config.timezone,
              items: [{ id: this.config.calendarId }],
            },
          },
          this.options,
        );
        const entry = result.data.calendars?.[this.config.calendarId];
        if (!entry || entry.errors?.length || !Array.isArray(entry.busy))
          throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
        return entry.busy.map((b) => {
          if (!b.start || !b.end || !validRange({ from: b.start, to: b.end }))
            throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
          return { start: b.start, end: b.end };
        });
      },
    );
    if (!range.excludeEventId) return busy;
    // FreeBusy cannot exclude an event. Expand actual calendar events for reschedule,
    // retaining every other opaque event (including recurring/all-day events).
    return this.call(
      'availabilityExcludingSelf',
      'GOOGLE_CALENDAR_FREEBUSY_FAILED',
      async () => {
        const intervals: CalendarSlot[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = await this.client.events.list(
            {
              calendarId: this.config.calendarId,
              timeMin: range.from,
              timeMax: range.to,
              singleEvents: true,
              maxResults: 2500,
              pageToken,
            },
            this.options,
          );
          if (!response.data.items)
            throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
          for (const event of response.data.items) {
            if (
              event.id === range.excludeEventId ||
              event.status === 'cancelled' ||
              event.transparency === 'transparent'
            )
              continue;
            const dateTime = (
              value: calendar_v3.Schema$EventDateTime | null | undefined,
            ) => {
              if (value?.dateTime) return value.dateTime;
              if (value?.date) {
                const [y, m, d] = value.date.split('-').map(Number);
                return zonedDate(
                  y,
                  m,
                  d,
                  0,
                  0,
                  value.timeZone ?? this.config.timezone,
                ).toISOString();
              }
              throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
            };
            intervals.push({
              start: dateTime(event.start),
              end: dateTime(event.end),
            });
          }
          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken) return intervals;
        }
        throw new CalendarError('GOOGLE_CALENDAR_FREEBUSY_FAILED');
      },
    );
  }
  async getEvent(
    draft: MeetingDraft,
  ): Promise<calendar_v3.Schema$Event | null> {
    try {
      const response = await this.call(
        'getEvent',
        'GOOGLE_CALENDAR_EVENT_CREATE_FAILED',
        () =>
          this.client.events.get(
            { calendarId: draft.calendarId, eventId: draft.eventId },
            this.options,
          ),
      );
      if (response.data.status === 'cancelled') return null;
      if (
        response.data.extendedProperties?.private?.hermesMeetingId !==
        draft.meetingId
      )
        throw new CalendarError('GOOGLE_CALENDAR_EVENT_CREATE_FAILED');
      return response.data;
    } catch (error) {
      if (
        error instanceof CalendarError &&
        [404, 410].includes(error.httpStatus ?? 0)
      )
        return null;
      throw error;
    }
  }
  async resolveEvent(
    draft: MeetingDraft,
    event: calendar_v3.Schema$Event,
  ): Promise<CalendarEventResult> {
    let current = event;
    for (let i = 0; i < 3 && !this.meetUrl(current); i++) {
      if (
        current.conferenceData?.createRequest?.status?.statusCode === 'failure'
      )
        throw new CalendarError('GOOGLE_MEET_CREATION_FAILED');
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 150));
      const refreshed = await this.getEvent(draft);
      if (!refreshed) throw new CalendarError('GOOGLE_MEET_CREATION_FAILED');
      current = refreshed;
    }
    if (current.conferenceData?.createRequest?.status?.statusCode === 'failure')
      throw new CalendarError('GOOGLE_MEET_CREATION_FAILED');
    const meetUrl = this.meetUrl(current);
    return {
      eventId: draft.eventId,
      meetUrl,
      pending: !meetUrl,
      start: current.start?.dateTime ?? undefined,
      end: current.end?.dateTime ?? undefined,
    };
  }
  private meetUrl(event: calendar_v3.Schema$Event): string | undefined {
    const url =
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find(
        (e) => e.entryPointType === 'video',
      )?.uri;
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' &&
        parsed.hostname === 'meet.google.com'
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  }
  async createEvent(draft: MeetingDraft): Promise<CalendarEventResult> {
    let event: calendar_v3.Schema$Event;
    try {
      const response = await this.call(
        'insert',
        'GOOGLE_CALENDAR_EVENT_CREATE_FAILED',
        () =>
          this.client.events.insert(
            {
              calendarId: draft.calendarId,
              conferenceDataVersion: 1,
              sendUpdates: 'all',
              requestBody: {
                id: draft.eventId,
                summary: 'Reunión comercial - Undercodeec',
                description: `Referencia CRM: ${draft.meetingId}${draft.serviceContext ? `\nServicio: ${draft.serviceContext.replace(/[<>]/g, '').slice(0, 240)}` : ''}`,
                start: { dateTime: draft.slot.start, timeZone: draft.timezone },
                end: { dateTime: draft.slot.end, timeZone: draft.timezone },
                attendees: [{ email: draft.email }],
                extendedProperties: {
                  private: { hermesMeetingId: draft.meetingId },
                },
                conferenceData: {
                  createRequest: {
                    requestId: draft.eventId,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
              },
            },
            this.options,
          ),
      );
      event = response.data;
    } catch (error) {
      if (
        !(error instanceof CalendarError) ||
        (!error.transient && error.httpStatus !== 409)
      )
        throw error;
      const found = await this.getEvent(draft);
      if (!found) throw error;
      event = found;
    }
    return this.resolveEvent(draft, event);
  }
  async rescheduleEvent(draft: MeetingDraft): Promise<CalendarEventResult> {
    const existing = await this.getEvent(draft);
    if (!existing)
      throw new CalendarError('GOOGLE_CALENDAR_EVENT_UPDATE_FAILED');
    const response = await this.call(
      'patch',
      'GOOGLE_CALENDAR_EVENT_UPDATE_FAILED',
      () =>
        this.client.events.patch(
          {
            calendarId: draft.calendarId,
            eventId: draft.eventId,
            conferenceDataVersion: 1,
            sendUpdates: 'all',
            requestBody: {
              start: { dateTime: draft.slot.start, timeZone: draft.timezone },
              end: { dateTime: draft.slot.end, timeZone: draft.timezone },
            },
          },
          this.options,
        ),
    );
    return this.resolveEvent(draft, response.data);
  }
  async cancelEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.call('delete', 'GOOGLE_CALENDAR_EVENT_DELETE_FAILED', () =>
        this.client.events.delete(
          { calendarId, eventId, sendUpdates: 'all' },
          this.options,
        ),
      );
    } catch (error) {
      if (
        error instanceof CalendarError &&
        [404, 410].includes(error.httpStatus ?? 0)
      )
        return;
      throw error;
    }
  }
}

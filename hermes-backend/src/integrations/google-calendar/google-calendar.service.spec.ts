/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Assertions inspect Google API payloads through Jest matchers. */
import { ConfigService } from '@nestjs/config';
import { GoogleCalendarService } from './google-calendar.service';
import { MeetingDraft } from './calendar.types';

describe('Google Calendar boundary', () => {
  const env = {
    GOOGLE_CALENDAR_ENABLED: 'true',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh',
  };
  const draft: MeetingDraft = {
    meetingId: 'meeting-1',
    eventId: 'abc123',
    calendarId: 'primary',
    email: 'client@example.com',
    timezone: 'America/Guayaquil',
    slot: { start: '2026-09-28T14:00:00Z', end: '2026-09-28T14:30:00Z' },
  };
  const event = {
    id: 'abc123',
    status: 'confirmed',
    extendedProperties: { private: { hermesMeetingId: 'meeting-1' } },
    start: { dateTime: draft.slot.start },
    end: { dateTime: draft.slot.end },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  };
  const setup = () => {
    const api = {
      freebusy: {
        query: jest.fn().mockResolvedValue({
          data: { calendars: { primary: { busy: [] } } },
        }),
      },
      events: {
        insert: jest.fn().mockResolvedValue({ data: event }),
        get: jest.fn().mockResolvedValue({ data: event }),
        patch: jest.fn().mockResolvedValue({ data: event }),
        delete: jest.fn().mockResolvedValue({}),
        list: jest.fn(),
      },
    };
    const service = new GoogleCalendarService(
      new ConfigService(env),
      api as never,
    );
    return { api, service };
  };
  it('gets actual busy intervals', async () => {
    const { api, service } = setup();
    api.freebusy.query.mockResolvedValue({
      data: { calendars: { primary: { busy: [draft.slot] } } },
    });
    expect(
      await service.getAvailability({
        from: draft.slot.start,
        to: draft.slot.end,
      }),
    ).toEqual([draft.slot]);
  });
  it('fails closed for a partial FreeBusy error', async () => {
    const { api, service } = setup();
    api.freebusy.query.mockResolvedValue({
      data: { calendars: { primary: { errors: [{ reason: 'notFound' }] } } },
    });
    await expect(
      service.getAvailability({ from: draft.slot.start, to: draft.slot.end }),
    ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_FREEBUSY_FAILED' });
  });
  it('requests Meet and emails the invitation with stable event id', async () => {
    const { api, service } = setup();
    expect(await service.createEvent(draft)).toMatchObject({
      eventId: 'abc123',
      meetUrl: event.hangoutLink,
      pending: false,
    });
    expect(api.events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        conferenceDataVersion: 1,
        sendUpdates: 'all',
        requestBody: expect.objectContaining({
          id: 'abc123',
          attendees: [{ email: 'client@example.com' }],
          conferenceData: {
            createRequest: {
              requestId: 'abc123',
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }),
      }),
      expect.anything(),
    );
  });
  it.each([{ code: 409 }, { code: 'ETIMEDOUT' }, { code: 503 }])(
    'reconciles ambiguous insert %j without a second event',
    async (error) => {
      const { api, service } = setup();
      api.events.insert.mockRejectedValue(error);
      expect(await service.createEvent(draft)).toMatchObject({
        eventId: 'abc123',
      });
      expect(api.events.insert).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects another CRM event with the same id', async () => {
    const { api, service } = setup();
    api.events.insert.mockRejectedValue({ code: 409 });
    api.events.get.mockResolvedValue({
      data: {
        ...event,
        extendedProperties: { private: { hermesMeetingId: 'other' } },
      },
    });
    await expect(service.createEvent(draft)).rejects.toMatchObject({
      code: 'GOOGLE_CALENDAR_EVENT_CREATE_FAILED',
    });
  });
  it('polls pending conference without inserting twice', async () => {
    const { api, service } = setup();
    api.events.insert.mockResolvedValue({
      data: {
        ...event,
        hangoutLink: undefined,
        conferenceData: {
          createRequest: { status: { statusCode: 'pending' } },
        },
      },
    });
    expect(await service.createEvent(draft)).toMatchObject({
      meetUrl: event.hangoutLink,
    });
    expect(api.events.insert).toHaveBeenCalledTimes(1);
  });
  it('does not confirm a permanently pending Meet', async () => {
    const { api, service } = setup();
    const pending = { ...event, hangoutLink: undefined };
    api.events.insert.mockResolvedValue({ data: pending });
    api.events.get.mockResolvedValue({ data: pending });
    expect(await service.createEvent(draft)).toMatchObject({ pending: true });
    expect(api.events.get).toHaveBeenCalledTimes(3);
  });
  it.each([
    [
      { response: { status: 400, data: { error: 'invalid_grant' } } },
      'GOOGLE_CALENDAR_REAUTH_REQUIRED',
    ],
    [{ code: 401 }, 'GOOGLE_CALENDAR_AUTH_FAILED'],
  ])('classifies OAuth errors without secrets', async (error, code) => {
    const { api, service } = setup();
    api.freebusy.query.mockRejectedValue(error);
    await expect(
      service.getAvailability({ from: draft.slot.start, to: draft.slot.end }),
    ).rejects.toMatchObject({ code });
  });
  it('patches the same event when rescheduling', async () => {
    const { api, service } = setup();
    await service.rescheduleEvent(draft);
    expect(api.events.patch).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'abc123', sendUpdates: 'all' }),
      expect.anything(),
    );
    expect(api.events.insert).not.toHaveBeenCalled();
  });
  it.each([404, 410])('treats delete %s as already cancelled', async (code) => {
    const { api, service } = setup();
    api.events.delete.mockRejectedValue({ code });
    await expect(
      service.cancelEvent('primary', 'abc123'),
    ).resolves.toBeUndefined();
  });
  it('never contacts Google when disabled', async () => {
    const { api } = setup();
    const service = new GoogleCalendarService(
      new ConfigService({}),
      api as never,
    );
    await expect(
      service.getAvailability({ from: draft.slot.start, to: draft.slot.end }),
    ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_DISABLED' });
    expect(api.freebusy.query).not.toHaveBeenCalled();
  });
});

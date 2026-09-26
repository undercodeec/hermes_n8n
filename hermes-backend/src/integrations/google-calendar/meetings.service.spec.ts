/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- Persisted conversational state double. */
import { MeetingsService } from './meetings.service';
import { GoogleCalendarService } from './google-calendar.service';
import { MeetingOperationsService } from './meeting-operations.service';
import { CalendarError } from './calendar.errors';

describe('Meeting conversation A–J', () => {
  it('retains initial meeting intent after a date clarification', async () => {
    const f = setup();
    await f.service.handleTurn({
      ...turn,
      text: 'Quiero una reunión mañana a las 4',
    });
    expect(
      (
        await f.service.handleTurn({
          ...turn,
          text: 'mañana a las 4 de la tarde',
        })
      ).content,
    ).toContain('1.');
  });
  it('does not mistake a spoken hour for an option number', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'mañana a las 2 de la tarde' });
    expect(f.operations.prepare).not.toHaveBeenCalled();
    expect(f.google.getAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-09-29T19:00:00.000Z' }),
    );
  });
  const turn = {
    conversationId: 'conversation',
    contactId: 'contact',
    sourceMessageId: 'message',
    text: 'Quiero agendar una reunión',
    now: new Date('2026-09-28T12:00:00Z'),
    serviceContext: 'Sitio web del proyecto actual',
  };
  const setup = () => {
    let state: any = null;
    let email: string | null = null;
    let confirmed: any = null;
    const tx: any = {
      conversationState: {
        findUnique: jest.fn(async () => ({ meetingState: state })),
        upsert: jest.fn(async ({ create, update }) => {
          state = update.meetingState ?? create.meetingState;
        }),
      },
      contact: {
        findUniqueOrThrow: jest.fn(async () => ({ id: 'contact', email })),
        update: jest.fn(async ({ data }) => {
          email = data.email;
        }),
      },
      meeting: {
        findMany: jest.fn(async () =>
          Array.isArray(confirmed) ? confirmed : confirmed ? [confirmed] : [],
        ),
        findUnique: jest.fn(async () => confirmed),
      },
      $executeRaw: jest.fn(),
    };
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
    };
    const operations = {
      interrupt: jest.fn().mockResolvedValue(undefined),
      localBusy: jest.fn().mockResolvedValue([]),
      prepare: jest.fn().mockResolvedValue({ id: 'operation' }),
      apply: jest.fn(async () => {
        confirmed = {
          id: 'meeting',
          conversationId: 'conversation',
          contactId: 'contact',
          attendeeEmail: email,
          status: 'CONFIRMED',
          startAt: new Date(state.selected.start as string),
          endAt: new Date(state.selected.end as string),
          timezone: 'America/Guayaquil',
          meetUrl: 'https://meet.google.com/abc-defg-hij',
        };
        return confirmed;
      }),
    };
    const service = new MeetingsService(
      prisma,
      google as unknown as GoogleCalendarService,
      operations as unknown as MeetingOperationsService,
    );
    return {
      service,
      google,
      operations,
      setEmail: (v: string) => {
        email = v;
      },
      getState: () => state,
      setMeeting: (v: any) => {
        confirmed = v;
      },
    };
  };
  it('A: offers at most three slots without booking', async () => {
    const f = setup();
    const reply = await f.service.handleTurn(turn);
    expect(reply.handled).toBe(true);
    expect(reply.content).toContain('1.');
    expect(f.getState().slots).toHaveLength(3);
    expect(f.operations.prepare).not.toHaveBeenCalled();
  });
  it.each(['no quiero la primera', 'no quiero una reunión'])(
    'rejects proposal: %s',
    async (text) => {
      const f = setup();
      f.setEmail('client@example.com');
      await f.service.handleTurn(turn);
      await f.service.handleTurn({ ...turn, text });
      expect(f.operations.prepare).not.toHaveBeenCalled();
      expect(f.getState().phase).toBe('CANCELLED');
    },
  );
  it('leaves email collection on rejection', async () => {
    const f = setup();
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    await f.service.handleTurn({ ...turn, text: 'ya no quiero la reunión' });
    expect(f.getState().phase).toBe('CANCELLED');
    expect(f.operations.prepare).not.toHaveBeenCalled();
  });
  it('interrupts uncertain booking instead of applying it on rejection', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    f.operations.apply.mockRejectedValue(
      new CalendarError('MEETING_OPERATION_PENDING', true),
    );
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    f.operations.apply.mockClear();
    await f.service.handleTurn({
      ...turn,
      text: 'no, ya no quiero la reunión',
    });
    expect(f.operations.interrupt).toHaveBeenCalledWith(turn.conversationId);
    expect(f.operations.apply).not.toHaveBeenCalled();
  });
  it('resolves a time-only answer against tomorrow proposal', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn({
      ...turn,
      text: 'quiero una reunión mañana a las 4 de la tarde',
    });
    await f.service.handleTurn({ ...turn, text: 'a las 4 de la tarde' });
    expect(f.operations.prepare).toHaveBeenCalledWith(
      'CREATE',
      expect.anything(),
      expect.objectContaining({
        slot: expect.objectContaining({ start: '2026-09-29T21:00:00.000Z' }),
      }),
    );
  });
  it('consumes affirmative response to changing the existing meeting', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    await f.service.handleTurn(turn);
    const reply = await f.service.handleTurn({ ...turn, text: 'sí' });
    expect(reply.content).toContain('1.');
    expect(f.getState().mode).toBe('RESCHEDULE');
  });
  it('keeps requested day while clarifying only meridiem', async () => {
    const f = setup();
    await f.service.handleTurn({ ...turn, text: 'reunión mañana a las 4' });
    await f.service.handleTurn({ ...turn, text: 'a las 4 de la tarde' });
    expect(f.google.getAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-09-29T21:00:00.000Z' }),
    );
  });
  it('consumes selection when several active meetings exist', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    const m = {
      id: 'meeting',
      attendeeEmail: 'client@example.com',
      startAt: new Date('2026-09-29T14:00:00Z'),
      endAt: new Date('2026-09-29T14:30:00Z'),
    };
    f.setMeeting([
      m,
      { ...m, id: 'other', startAt: new Date('2026-09-30T14:00:00Z') },
    ]);
    await f.service.handleTurn({ ...turn, text: 'cambiar reunión' });
    const reply = await f.service.handleTurn({ ...turn, text: '1' });
    expect(reply.content).toContain('1.');
    expect(f.getState().meetingId).toBe('meeting');
    expect(f.getState().phase).toBe('OFFERING');
  });
  it('B: tomorrow afternoon queries the actual requested range', async () => {
    const f = setup();
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'Mañana por la tarde' });
    expect(f.google.getAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: '2026-09-29T17:00:00.000Z',
        to: '2026-09-30T05:00:00.000Z',
      }),
    );
  });
  it('C/D: asks email only after selection, then books with project context', async () => {
    const f = setup();
    await f.service.handleTurn(turn);
    expect(
      (await f.service.handleTurn({ ...turn, text: 'la primera' })).content,
    ).toMatch(/correo/);
    expect(f.operations.prepare).not.toHaveBeenCalled();
    const reply = await f.service.handleTurn({
      ...turn,
      text: 'client@example.com',
    });
    expect(reply.content).toContain('https://meet.google.com/abc-defg-hij');
    expect(f.operations.prepare).toHaveBeenCalledWith(
      'CREATE',
      expect.objectContaining({ serviceContext: turn.serviceContext }),
      expect.objectContaining({ email: 'client@example.com' }),
    );
  });
  it('uses existing valid email without asking again', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    expect(
      (await f.service.handleTurn({ ...turn, text: 'opción 2' })).content,
    ).toContain('agendada');
  });
  it('rejects malformed email without booking', async () => {
    const f = setup();
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    expect(
      (await f.service.handleTurn({ ...turn, text: 'client@invalid' })).content,
    ).toMatch(/correo/);
    expect(f.operations.prepare).not.toHaveBeenCalled();
  });
  it('E: occupied selection produces fresh options', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    f.operations.apply.mockRejectedValue(
      new CalendarError('MEETING_SLOT_OCCUPIED'),
    );
    expect(
      (await f.service.handleTurn({ ...turn, text: 'la primera' })).content,
    ).toContain('1.');
  });
  it('H: repeated yes after confirmation does not book another event', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    await f.service.handleTurn({ ...turn, text: 'sí, ese horario' });
    expect(f.operations.prepare).toHaveBeenCalledTimes(1);
  });
  it.each([
    'GOOGLE_CALENDAR_FREEBUSY_FAILED',
    'GOOGLE_CALENDAR_REAUTH_REQUIRED',
  ] as const)('I/J: %s never produces a false reservation', async (code) => {
    const f = setup();
    f.google.getAvailability.mockRejectedValue(new CalendarError(code));
    const reply = await f.service.handleTurn(turn);
    expect(reply.errorCode).toBe(code);
    expect(reply.content).not.toMatch(/agendada|meet.google/);
  });
  it('F: changing a meeting uses RESCHEDULE with its id', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    await f.service.handleTurn({ ...turn, text: 'Quiero cambiar mi reunión' });
    await f.service.handleTurn({ ...turn, text: 'la segunda' });
    expect(f.operations.prepare).toHaveBeenLastCalledWith(
      'RESCHEDULE',
      expect.anything(),
      expect.objectContaining({ meetingId: 'meeting' }),
    );
  });
  it('G: cancellation needs contextual confirmation', async () => {
    const f = setup();
    f.setEmail('client@example.com');
    await f.service.handleTurn(turn);
    await f.service.handleTurn({ ...turn, text: 'la primera' });
    const count = f.operations.prepare.mock.calls.length;
    expect(
      (await f.service.handleTurn({ ...turn, text: 'Quiero cancelar' }))
        .content,
    ).toMatch(/Confirma/);
    expect(f.operations.prepare).toHaveBeenCalledTimes(count);
    await f.service.handleTurn({ ...turn, text: 'sí' });
    expect(f.operations.prepare).toHaveBeenLastCalledWith(
      'CANCEL',
      expect.anything(),
      expect.objectContaining({ meetingId: 'meeting' }),
    );
  });
  it('does not treat unrelated cancellation as a meeting operation', async () => {
    expect(
      (
        await setup().service.handleTurn({
          ...turn,
          text: 'quiero cancelar mi suscripción',
        })
      ).handled,
    ).toBe(false);
  });
  it('asks before assuming an ambiguous hour', async () => {
    const f = setup();
    await f.service.handleTurn(turn);
    expect(
      (await f.service.handleTurn({ ...turn, text: 'mañana a las 4' })).content,
    ).toMatch(/fecha y hora/);
    expect(f.operations.prepare).not.toHaveBeenCalled();
  });
});

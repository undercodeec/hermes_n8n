export type CalendarErrorCode =
  | 'GOOGLE_CALENDAR_DISABLED'
  | 'GOOGLE_CALENDAR_AUTH_FAILED'
  | 'GOOGLE_CALENDAR_REAUTH_REQUIRED'
  | 'GOOGLE_CALENDAR_FREEBUSY_FAILED'
  | 'GOOGLE_CALENDAR_EVENT_CREATE_FAILED'
  | 'GOOGLE_CALENDAR_EVENT_UPDATE_FAILED'
  | 'GOOGLE_CALENDAR_EVENT_DELETE_FAILED'
  | 'GOOGLE_MEET_CREATION_FAILED'
  | 'MEETING_SLOT_OCCUPIED'
  | 'MEETING_OPERATION_PENDING';
export class CalendarError extends Error {
  constructor(
    readonly code: CalendarErrorCode,
    readonly transient = false,
    readonly httpStatus?: number,
  ) {
    super(code);
  }
}
export function classifyCalendarError(
  error: unknown,
  fallback: CalendarErrorCode,
): CalendarError {
  if (error instanceof CalendarError) return error;
  const e = error as {
    code?: string | number;
    response?: {
      status?: number;
      data?: { error?: string | { status?: string } };
    };
  };
  const status =
    e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  if (e?.response?.data?.error === 'invalid_grant')
    return new CalendarError('GOOGLE_CALENDAR_REAUTH_REQUIRED', false, status);
  if (status === 401)
    return new CalendarError('GOOGLE_CALENDAR_AUTH_FAILED', false, status);
  return new CalendarError(
    fallback,
    status === 429 ||
      (status ?? 0) >= 500 ||
      ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'DEADLINE_EXCEEDED'].includes(
        String(e?.code),
      ),
    status,
  );
}

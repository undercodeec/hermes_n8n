import {
  AvailabilityRequest,
  CalendarPolicy,
  CalendarSlot,
} from './calendar.types';

export function localParts(date: Date, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) =>
    Number(parts.find((p) => p.type === key)?.value),
  );
}
export function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let result = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(result), timezone);
    const difference =
      target - Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
    result += difference;
    if (!difference) break;
  }
  const p = localParts(new Date(result), timezone);
  if (
    p[0] !== year ||
    p[1] !== month ||
    p[2] !== day ||
    p[3] !== hour ||
    p[4] !== minute
  )
    throw new Error('Invalid local date');
  return new Date(result);
}
export function validRange(range: AvailabilityRequest): boolean {
  return (
    [range.from, range.to].every(
      (s) =>
        /T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s)),
    ) &&
    Date.parse(range.to) > Date.parse(range.from) &&
    Date.parse(range.to) - Date.parse(range.from) <= 32 * 86400000
  );
}
export function overlaps(
  a: CalendarSlot,
  b: CalendarSlot,
  bufferMinutes = 0,
): boolean {
  const buffer = bufferMinutes * 60000;
  return (
    Date.parse(a.start) < Date.parse(b.end) + buffer &&
    Date.parse(a.end) > Date.parse(b.start) - buffer
  );
}
export function generateSlots(
  range: AvailabilityRequest,
  busy: CalendarSlot[],
  policy: CalendarPolicy,
  now: Date,
): CalendarSlot[] {
  if (
    !validRange(range) ||
    busy.some((b) => !validRange({ from: b.start, to: b.end }))
  )
    throw new Error('Invalid availability range');
  const start = localParts(new Date(range.from), policy.timezone);
  const cursor = new Date(Date.UTC(start[0], start[1] - 1, start[2]));
  const slots: CalendarSlot[] = [];
  for (
    let day = 0;
    day < 33;
    day++, cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const y = cursor.getUTCFullYear(),
      m = cursor.getUTCMonth() + 1,
      d = cursor.getUTCDate();
    const midnight = zonedDate(y, m, d, 0, 0, policy.timezone);
    if (midnight.getTime() >= Date.parse(range.to)) break;
    if (!policy.businessDays.includes(cursor.getUTCDay() || 7)) continue;
    const [sh, sm] = policy.businessStart.split(':').map(Number),
      [eh, em] = policy.businessEnd.split(':').map(Number);
    const open = zonedDate(y, m, d, sh, sm, policy.timezone).getTime(),
      close = zonedDate(y, m, d, eh, em, policy.timezone).getTime();
    for (
      let t = open;
      t + policy.durationMinutes * 60000 <= close;
      t += 15 * 60000
    ) {
      const slot = {
        start: new Date(t).toISOString(),
        end: new Date(t + policy.durationMinutes * 60000).toISOString(),
      };
      if (
        t > now.getTime() &&
        t >= Date.parse(range.from) &&
        Date.parse(slot.end) <= Date.parse(range.to) &&
        !busy.some((b) => overlaps(slot, b, policy.bufferMinutes))
      )
        slots.push(slot);
    }
  }
  return slots;
}

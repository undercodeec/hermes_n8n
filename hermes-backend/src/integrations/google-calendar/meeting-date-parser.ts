import { AvailabilityRequest } from './calendar.types';
import { localParts, zonedDate } from './slot-engine';

export function normalizeMeetingText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
export function parseMeetingDate(
  text: string,
  now: Date,
  timezone: string,
): { range?: AvailabilityRequest; ambiguous: boolean; exact?: string } {
  const s = normalizeMeetingText(text);
  const p = localParts(now, timezone);
  const day = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  let hasDate = false;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    day.setUTCFullYear(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    hasDate = true;
    if (day.toISOString().slice(0, 10) !== iso[0]) return { ambiguous: true };
  } else if (/\bpasado manana\b/.test(s)) {
    day.setUTCDate(day.getUTCDate() + 2);
    hasDate = true;
  } else if (/\bmanana\b/.test(s.replace(/\b(?:por|de) la manana\b/g, ''))) {
    day.setUTCDate(day.getUTCDate() + 1);
    hasDate = true;
  } else if (/\bhoy\b/.test(s)) hasDate = true;
  else {
    const days = [
      'domingo',
      'lunes',
      'martes',
      'miercoles',
      'jueves',
      'viernes',
      'sabado',
    ];
    const weekday = days.findIndex((d) => new RegExp(`\\b${d}\\b`).test(s));
    if (weekday >= 0) {
      let delta = (weekday - day.getUTCDay() + 7) % 7;
      if (delta === 0) delta = 7;
      day.setUTCDate(day.getUTCDate() + delta);
      hasDate = true;
    }
  }
  const hour = s.match(
    /\b(a las?|despues de las?|desde las?)\s+(\d{1,2})(?::(\d{2}))?(?:\s*(de la tarde|de la manana|de la noche|am|pm))?/,
  );
  let startHour = 0,
    startMinute = 0,
    endHour = 24,
    exact = false;
  if (hour) {
    startHour = Number(hour[2]);
    startMinute = Number(hour[3] ?? 0);
    const meridiem =
      hour[4] ?? (/\b(?:por|de) la tarde\b/.test(s) ? 'pm' : undefined);
    if (startHour > 23 || startMinute > 59) return { ambiguous: true };
    if (startHour < 12 && !meridiem) {
      if (hour[1].startsWith('despues') || hour[1].startsWith('desde'))
        startHour += 12;
      else return { ambiguous: true };
    }
    if (meridiem && /tarde|noche|pm/.test(meridiem) && startHour < 12)
      startHour += 12;
    if (meridiem && /manana|am/.test(meridiem) && startHour === 12)
      startHour = 0;
    exact = hour[1].startsWith('a ');
  } else if (/\b(?:por|de) la tarde\b/.test(s)) startHour = 12;
  else if (/\b(?:por|de) la manana\b/.test(s)) endHour = 12;
  if (!hasDate && !hour && startHour === 0 && endHour === 24) {
    if (
      /\b(?:\d{1,2}[/-]\d{1,2}|septiembre|octubre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|noviembre|diciembre)\b/.test(
        s,
      )
    )
      return { ambiguous: true };
    return { ambiguous: false };
  }
  try {
    const y = day.getUTCFullYear(),
      m = day.getUTCMonth() + 1,
      d = day.getUTCDate();
    const start = zonedDate(y, m, d, startHour, startMinute, timezone);
    const next = new Date(day);
    next.setUTCDate(next.getUTCDate() + 1);
    const end =
      endHour === 24
        ? zonedDate(
            next.getUTCFullYear(),
            next.getUTCMonth() + 1,
            next.getUTCDate(),
            0,
            0,
            timezone,
          )
        : zonedDate(y, m, d, endHour, 0, timezone);
    const from = hasDate
      ? start
      : new Date(Math.max(start.getTime(), now.getTime()));
    return {
      ambiguous: false,
      range: { from: from.toISOString(), to: end.toISOString() },
      exact: exact ? start.toISOString() : undefined,
    };
  } catch {
    return { ambiguous: true };
  }
}

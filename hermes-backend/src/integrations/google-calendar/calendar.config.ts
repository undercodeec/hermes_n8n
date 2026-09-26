import { CalendarConfig } from './calendar.types';
import { ConfigService } from '@nestjs/config';

export function calendarConfigFromService(
  config: ConfigService,
): CalendarConfig {
  const keys = [
    'GOOGLE_CALENDAR_ENABLED',
    'GOOGLE_CALENDAR_ID',
    'GOOGLE_CALENDAR_TIMEZONE',
    'GOOGLE_MEETING_DURATION_MINUTES',
    'GOOGLE_MEETING_BUFFER_MINUTES',
    'GOOGLE_MEETING_BUSINESS_START',
    'GOOGLE_MEETING_BUSINESS_END',
    'GOOGLE_MEETING_BUSINESS_DAYS',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_OAUTH_REDIRECT_URI',
  ];
  return readCalendarConfig(
    Object.fromEntries(keys.map((k) => [k, config.get(k)])),
  );
}

export function readCalendarConfig(
  env: Record<string, unknown>,
): CalendarConfig {
  const value = (key: string, fallback = '') => {
    const raw = env[key] ?? fallback;
    if (
      typeof raw !== 'string' &&
      typeof raw !== 'number' &&
      typeof raw !== 'boolean'
    )
      throw new Error(`Invalid ${key}`);
    return String(raw).trim();
  };
  const flag = value('GOOGLE_CALENDAR_ENABLED', 'false');
  if (!['true', 'false'].includes(flag))
    throw new Error('Invalid GOOGLE_CALENDAR_ENABLED');
  const integer = (key: string, fallback: number, min: number) => {
    const raw = value(key, String(fallback));
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > 1440)
      throw new Error(`Invalid ${key}`);
    return n;
  };
  const config: CalendarConfig = {
    enabled: flag === 'true',
    calendarId: value('GOOGLE_CALENDAR_ID', 'primary'),
    timezone: value('GOOGLE_CALENDAR_TIMEZONE', 'America/Guayaquil'),
    durationMinutes: integer('GOOGLE_MEETING_DURATION_MINUTES', 30, 1),
    bufferMinutes: integer('GOOGLE_MEETING_BUFFER_MINUTES', 15, 0),
    businessStart: value('GOOGLE_MEETING_BUSINESS_START', '09:00'),
    businessEnd: value('GOOGLE_MEETING_BUSINESS_END', '18:00'),
    businessDays: value('GOOGLE_MEETING_BUSINESS_DAYS', '1,2,3,4,5')
      .split(',')
      .map(Number),
    clientId: value('GOOGLE_CLIENT_ID'),
    clientSecret: value('GOOGLE_CLIENT_SECRET'),
    refreshToken: value('GOOGLE_REFRESH_TOKEN'),
    redirectUri: value(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'http://localhost:3003/api/integrations/google/callback',
    ),
  };
  if (!config.calendarId) throw new Error('Invalid GOOGLE_CALENDAR_ID');
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone }).format();
  if (
    ![config.businessStart, config.businessEnd].every((v) =>
      /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    ) ||
    config.businessStart >= config.businessEnd
  )
    throw new Error('Invalid Google business hours');
  if (
    !config.businessDays.length ||
    config.businessDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
    new Set(config.businessDays).size !== config.businessDays.length
  )
    throw new Error('Invalid GOOGLE_MEETING_BUSINESS_DAYS');
  const redirect = new URL(config.redirectUri);
  if (
    !['http:', 'https:'].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error('Invalid GOOGLE_OAUTH_REDIRECT_URI');
  if (
    config.enabled &&
    (!config.clientId || !config.clientSecret || !config.refreshToken)
  )
    throw new Error('Google Calendar credentials required when enabled');
  return config;
}

import { readCalendarConfig } from './calendar.config';

describe('Calendar configuration', () => {
  it('starts disabled without credentials', () => {
    expect(readCalendarConfig({}).enabled).toBe(false);
  });
  it('requires credentials only for enabled scheduling', () => {
    expect(() =>
      readCalendarConfig({ GOOGLE_CALENDAR_ENABLED: 'true' }),
    ).toThrow();
  });
  it.each([
    ['GOOGLE_MEETING_DURATION_MINUTES', '0'],
    ['GOOGLE_MEETING_BUFFER_MINUTES', '-1'],
    ['GOOGLE_MEETING_BUSINESS_START', '19:00'],
    ['GOOGLE_MEETING_BUSINESS_END', '25:00'],
    ['GOOGLE_MEETING_BUSINESS_DAYS', '0,8'],
    ['GOOGLE_CALENDAR_TIMEZONE', 'invalid/zone'],
    ['GOOGLE_CALENDAR_ID', ''],
    ['GOOGLE_CALENDAR_ENABLED', 'maybe'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => readCalendarConfig({ [key]: value })).toThrow();
  });
});

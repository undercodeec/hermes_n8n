import { readCalendarConfig } from './calendar.config';
import { generateSlots } from './slot-engine';
import {
  meetingPolicy,
  resolveMeetingLocation,
  meetingDualTime,
} from './meeting-region';

describe('Regional meeting policy', () => {
  it.each([
    ['2026-09-28', '2026-09-28T12:00:00.000Z', '2026-09-28T18:00:00.000Z'],
    ['2026-10-26', '2026-10-26T13:00:00.000Z', '2026-10-26T19:00:00.000Z'],
  ])(
    'keeps 14:00–20:00 Spanish hours across seasonal offsets on %s',
    (day, first, lastEnd) => {
      const slots = generateSlots(
        { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` },
        [],
        meetingPolicy(readCalendarConfig({}), 'Europe/Madrid'),
        new Date('2026-09-27T00:00:00Z'),
      );
      expect(slots).toHaveLength(23);
      expect(slots[0].start).toBe(first);
      expect(slots.at(-1)?.end).toBe(lastEnd);
    },
  );
  it('asks for mainland or Canary clarification for an unlisted Spanish municipality', () => {
    expect(resolveMeetingLocation('Adeje, España')).toBeUndefined();
    expect(resolveMeetingLocation('Adeje, España, Canarias')).toMatchObject({
      timezone: 'Atlantic/Canary',
    });
    expect(
      resolveMeetingLocation('Alcalá la Real, España peninsular'),
    ).toMatchObject({ timezone: 'Europe/Madrid' });
  });
  it('does not classify a city in another explicitly stated country as Spanish', () => {
    expect(resolveMeetingLocation('Cartagena, Colombia')).toBeUndefined();
    expect(resolveMeetingLocation('Valladolid, México')).toBeUndefined();
  });
  it('does not classify origin cities mentioned in a non-location statement', () => {
    expect(
      resolveMeetingLocation('mi correo es madrid@example.com'),
    ).toBeUndefined();
  });
  it('formats legacy zones without calling them Ecuador time', () => {
    expect(
      meetingDualTime(
        { start: '2026-09-28T12:00:00Z', end: '2026-09-28T12:30:00Z' },
        'America/New_York',
      ),
    ).toContain('hora de la reunión');
  });
});

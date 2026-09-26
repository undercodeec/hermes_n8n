import { generateSlots } from './slot-engine';
import { readCalendarConfig } from './calendar.config';

describe('Calendar slots', () => {
  const policy = readCalendarConfig({});
  const now = new Date('2026-09-27T00:00:00Z');
  const range = { from: '2026-09-28T14:00:00Z', to: '2026-09-28T23:00:00Z' };
  it('returns business hours in the configured timezone', () => {
    const slots = generateSlots(range, [], policy, now);
    expect(slots[0]).toEqual({
      start: '2026-09-28T14:00:00.000Z',
      end: '2026-09-28T14:30:00.000Z',
    });
    expect(slots.at(-1)?.end).toBe('2026-09-28T23:00:00.000Z');
  });
  it('excludes a busy interval and its buffer on both sides', () => {
    const slots = generateSlots(
      range,
      [{ start: '2026-09-28T15:00:00Z', end: '2026-09-28T16:00:00Z' }],
      policy,
      now,
    );
    expect(slots.map((s) => s.start)).not.toContain('2026-09-28T14:30:00.000Z');
    expect(slots.map((s) => s.start)).not.toContain('2026-09-28T16:00:00.000Z');
    expect(slots.map((s) => s.start)).toContain('2026-09-28T16:15:00.000Z');
  });
  it('merges consecutive busy periods and handles no availability', () => {
    expect(
      generateSlots(
        range,
        [
          { start: range.from, end: '2026-09-28T18:00:00Z' },
          { start: '2026-09-28T18:00:00Z', end: range.to },
        ],
        policy,
        now,
      ),
    ).toEqual([]);
  });
  it('skips weekends and changes days', () => {
    const slots = generateSlots(
      { from: '2026-09-26T00:00:00Z', to: '2026-09-30T00:00:00Z' },
      [],
      policy,
      now,
    );
    expect(slots[0].start).toBe('2026-09-28T14:00:00.000Z');
    expect(slots.some((s) => s.start.startsWith('2026-09-29'))).toBe(true);
  });
  it('never offers a past start', () => {
    expect(
      generateSlots(range, [], policy, new Date('2026-09-28T20:01:00Z'))[0]
        .start,
    ).toBe('2026-09-28T20:15:00.000Z');
  });
  it('uses IANA offset after daylight saving transition', () => {
    expect(
      generateSlots(
        { from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z' },
        [],
        { ...policy, timezone: 'America/New_York' },
        new Date('2026-11-01T00:00:00Z'),
      )[0].start,
    ).toBe('2026-11-02T14:00:00.000Z');
  });
});

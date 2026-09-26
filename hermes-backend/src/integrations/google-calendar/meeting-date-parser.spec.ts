import { parseMeetingDate } from './meeting-date-parser';

describe('Spanish meeting dates', () => {
  const now = new Date('2026-09-28T15:00:00Z');
  it.each([
    ['mañana por la tarde', '2026-09-29T17:00:00.000Z'],
    ['el próximo martes', '2026-09-29T05:00:00.000Z'],
    ['el lunes', '2026-10-05T05:00:00.000Z'],
    ['mañana después de las 3', '2026-09-29T20:00:00.000Z'],
    ['mañana a las 4 de la tarde', '2026-09-29T21:00:00.000Z'],
  ])('structures %s', (text, from) => {
    expect(parseMeetingDate(text, now, 'America/Guayaquil').range?.from).toBe(
      from,
    );
  });
  it('asks about an ambiguous hour', () => {
    expect(
      parseMeetingDate('mañana a las 4', now, 'America/Guayaquil').ambiguous,
    ).toBe(true);
  });
  it('separates tomorrow from morning when both occur', () => {
    expect(
      parseMeetingDate('mañana por la mañana', now, 'America/Guayaquil').range,
    ).toEqual({
      from: '2026-09-29T05:00:00.000Z',
      to: '2026-09-29T17:00:00.000Z',
    });
  });
  it('rejects an invalid explicit date', () => {
    expect(
      parseMeetingDate('2026-02-30', now, 'America/Guayaquil').ambiguous,
    ).toBe(true);
  });
});

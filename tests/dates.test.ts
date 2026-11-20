import { describe, expect, it } from 'vitest';
import { arrived, heard, period } from '../web/src/lib/format.ts';

// Thursday, Nov 19 2026, 3:30 PM, in the tests' zone (UTC).
const NOW = Date.UTC(2026, 10, 19, 15, 30);
const daysBack = (days: number, hour = 9) => Date.UTC(2026, 10, 19 - days, hour, 5);

describe('a list of mail, by when it came', () => {
  it('falls under Today, Yesterday, This week, Last week, then its month, with the year once it is another', () => {
    expect([0, 1, 2, 6, 7, 13, 14, 40].map((days) => period(daysBack(days), NOW))).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'This week',
      'Last week',
      'Last week',
      'November',
      'October',
    ]);
    expect(period(Date.UTC(2025, 11, 30), NOW)).toBe('December 2025');
  });

  it('goes by the day, not 24 hours: just before midnight was yesterday', () => {
    expect(period(Date.UTC(2026, 10, 18, 23, 59), Date.UTC(2026, 10, 19, 0, 1))).toBe('Yesterday');
  });

  it('says the time of day until yesterday, then the weekday, then the date', () => {
    expect([0, 1, 3, 9].map((days) => arrived(daysBack(days, 14), NOW))).toEqual(['2:05 PM', '2:05 PM', 'Mon', 'Nov 10']);
    expect(arrived(Date.UTC(2025, 11, 30), NOW)).toBe('Dec 30, 2025');
  });
});

describe('a message in a conversation, by when it came', () => {
  it('says the time today, then the day and the time, and the year only when it is another', () => {
    expect([0, 1, 9].map((days) => heard(daysBack(days, 14), NOW))).toEqual(['2:05 PM', 'Nov 18, 2:05 PM', 'Nov 10, 2:05 PM']);
    expect(heard(Date.UTC(2025, 11, 30, 14, 5), NOW)).toBe('Dec 30, 2025');
  });
});

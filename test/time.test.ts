import { expect, test } from 'vitest';

import { formatConversationDate } from '../src/time';

test('date badges switch from days to weeks to full dates using the local calendar', () => {
  const now = new Date(2026, 10, 8, 0);
  const relativeDays = [
    [0, '0d'], [7, '7d'], [8, '1w'], [13, '1w'], [14, '2w'], [20, '2w'],
    [21, '3w'], [27, '3w'], [28, '4w'], [34, '4w'],
  ] as const;
  for (const [daysAgo, badge] of relativeDays) {
    expect(formatConversationDate(new Date(2026, 10, 8 - daysAgo, 23, 59), now)?.badge).toBe(badge);
  }
  expect(formatConversationDate(new Date(2026, 10, 7, 23, 59), now)).toEqual({ text: '11-07', badge: '1d' });
  expect(formatConversationDate(new Date(2026, 9, 4, 23, 59), now)).toEqual({ text: '2026-10-04' });
  expect(formatConversationDate(new Date(2026, 10, 9), now)).toEqual({ text: '2026-11-09' });
  expect(formatConversationDate(new Date(2025, 11, 31, 23, 59), new Date(2026, 0, 1))).toEqual({ text: '2025-12-31' });
});

test('invalid timestamps have no calendar date', () => {
  expect(formatConversationDate(new Date(NaN))).toBeUndefined();
  expect(formatConversationDate(new Date(1e20))).toBeUndefined();
});

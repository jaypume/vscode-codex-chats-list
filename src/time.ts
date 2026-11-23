const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const MAX_BADGE_WEEKS = 4;

export function formatConversationDate(
  date: Date,
  now = new Date(),
): { text: string; badge?: string } | undefined {
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const short = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const absolute = `${year}-${short}`;
  if (year !== now.getFullYear()) return { text: absolute };
  // Compare calendar days across daylight-saving changes.
  const today = Date.UTC(year, now.getMonth(), now.getDate());
  const days = (today - Date.UTC(year, month, day)) / DAY_MS;
  const weeks = Math.floor(days / DAYS_PER_WEEK);
  if (days < 0 || weeks > MAX_BADGE_WEEKS) return { text: absolute };
  return { text: short, badge: days <= DAYS_PER_WEEK ? `${days}d` : `${weeks}w` };
}

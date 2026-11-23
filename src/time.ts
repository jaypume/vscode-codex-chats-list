const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const MAX_BADGE_WEEKS = 4;

export function formatConversationDate(
  date: Date,
  now = new Date(),
): { text: string; relative?: string } | undefined {
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const short = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const absolute = `${year}-${short}`;
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDay = now.getDate();
  // Compare calendar days across daylight-saving changes.
  const today = Date.UTC(currentYear, currentMonth, currentDay);
  const days = (today - Date.UTC(year, month, day)) / DAY_MS;
  if (days < 0) return { text: absolute };
  const weeks = Math.floor(days / DAYS_PER_WEEK);
  if (weeks <= MAX_BADGE_WEEKS) {
    return {
      text: year === currentYear ? short : absolute,
      relative: days <= DAYS_PER_WEEK ? `${days}d` : `${weeks}w`,
    };
  }
  // An activity on the 31st reaches its anniversary at the end of a shorter month.
  const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const pendingMonth = currentDay < Math.min(day, lastDayOfMonth);
  const months = (currentYear - year) * 12 + currentMonth - month - Number(pendingMonth);
  return { text: absolute, relative: months < 12 ? `${months}m` : `${Math.floor(months / 12)}y` };
}

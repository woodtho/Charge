import { DateTime } from 'luxon';

export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  return DateTime.now().setZone(tz).isValid;
}

export function parseTimeToday(timeStr: string, tz: string): DateTime | null {
  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  const timePattern = /^\d{1,2}:\d{2}$/;
  if (!timePattern.test(trimmed)) return null;

  const [hStr, mStr] = trimmed.split(':');
  const hours = Number(hStr);
  const minutes = Number(mStr);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  const anchor = DateTime.now().setZone(tz);
  if (!anchor.isValid) return null;

  return anchor.startOf('day').plus({ hours, minutes }).set({ second: 0, millisecond: 0 });
}

export function formatClock(dt: DateTime, tz: string): string {
  return dt.setZone(tz).toFormat('HH:mm');
}

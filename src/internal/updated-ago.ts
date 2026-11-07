const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

export const updatedAgo = (lastActiveAt: string, now: number) => {
  const timestamp = Date.parse(lastActiveAt);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  const elapsed = now - timestamp;
  if (elapsed < 0) {
    return "in future";
  }
  const seconds = Math.floor(elapsed / MILLISECONDS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / HOURS_PER_DAY)}d ago`;
};

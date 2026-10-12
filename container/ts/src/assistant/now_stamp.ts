/** Returns the current SGT time as a formatted stamp like "[now: Sat 3 Oct 2026, 11:57 SGT]" */
export function sgtNowStamp(now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Singapore",
  });
  const parts = formatter.formatToParts(now);
  const partsByName = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const { weekday, day, month, year, hour, minute } = partsByName as Record<string, string>;
  return `[now: ${weekday} ${day} ${month} ${year}, ${hour}:${minute} SGT]`;
}

/** Code-rendered message title: `Label Ddd D Mon HH:MM` in Asia/Singapore, 24h (CLAUDE.md, Daily Maintenance). */
export function titleLine(label: string, now: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${label} ${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

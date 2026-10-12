import { readFileSync } from "node:fs";
import { turnRouteCountsSince } from "../assistant/conversation_store.js";
import { braveUsage } from "../assistant/search_router.js";
import { webQuotaLine } from "../assistant/web_quota.js";
import { kagiStatus } from "../assistant/providers/kagi_search.js";
import { runDoctor } from "../doctor.js";
import { sgtToday } from "../reminders/format.js";
import { alertsSentSince } from "../reminders/store.js";
import { reminderTickerState } from "../reminders/ticker.js";
import { withTimeout } from "./intercept_log.js";

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function botVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    const commit = process.env.MELVBOT_COMMIT?.trim();
    return `${pkg.version ?? "?"}${commit ? ` (${commit.slice(0, 7)})` : ""}`;
  } catch {
    return "unknown";
  }
}

/** Body of `,status`: at most 8 lines, no model, no doctor network probes. */
export async function statusText(bootMs: number, now = new Date()): Promise<string> {
  const lines = [`melvbot ${botVersion()}, up ${formatUptime(now.getTime() - bootMs)}`];

  try {
    const { checks } = await withTimeout(runDoctor({ probe: false }), 10_000, "doctor");
    const bad = checks.filter((check) => check.status === "error" || check.status === "warning");
    const ok = checks.filter((check) => check.status === "ok").length;
    const errors = bad.filter((check) => check.status === "error").length;
    lines.push(`doctor: ${ok} ok, ${bad.length - errors} warn, ${errors} fail`);
    if (bad.length) {
      lines.push(`  not ok: ${bad.map((check) => check.label).join(", ")}`);
    }
  } catch (error) {
    lines.push(`doctor: unavailable (${error instanceof Error ? error.message : String(error)})`);
  }

  try {
    lines.push(`kagi ${kagiStatus()}`);
    const brave = braveUsage(now);
    lines.push(`brave ${brave.used}/${brave.quota} (pace ${Math.round(brave.pace)})`);
    lines.push(`web quota ${webQuotaLine(now)}`);
  } catch (error) {
    lines.push(`brave: ${error instanceof Error ? error.message : String(error)}`);
  }

  const since = `${sgtToday(now)}T00:00:00+08:00`;
  try {
    lines.push(`reminders: ticker ${reminderTickerState() ? "running" : "stopped"}, ${alertsSentSince(since)} alerts sent today`);
  } catch (error) {
    lines.push(`reminders: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    let claude = 0;
    let intercept = 0;
    let fallback = 0;
    for (const [route, n] of Object.entries(turnRouteCountsSince(since))) {
      if (route.startsWith("intercept:")) intercept += n;
      else if (route.startsWith("fallback")) fallback += n;
      else claude += n;
    }
    lines.push(`turns today: ${claude} claude, ${intercept} intercept, ${fallback} fallback`);
  } catch (error) {
    lines.push(`turns: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines.join("\n");
}

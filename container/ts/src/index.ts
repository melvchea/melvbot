import { runTurnsCli } from "./assistant/turns_cli.js";
import { startSessionIdleSweep, stopSessionIdleSweep } from "./assistant/claude_session.js";
import { stopReminderTicker } from "./reminders/ticker.js";
import { startPromptCacheRefresh, stopPromptCacheRefresh } from "./assistant/system_prompt.js";
import { TelegramApi } from "./telegram/api.js";
import { pollLoop, resolveBotToken } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { runCronCli } from "./cron/cli.js";
import { runGoogleCli } from "./google/cli.js";
import { runSheetCli } from "./sheet/cli.js";
import { runMemoryCli } from "./memory/cli.js";
import { runNoteCli } from "./note/cli.js";
import { runOutlookCli } from "./outlook/cli.js";
import { runNotifyCli } from "./telegram/notify_cli.js";

const CLI_USAGE = "usage: melvbot doctor | sheet | note | memory | google | outlook | cron | turns | notify";

export function isTelegramPollArgv(args: readonly string[]): boolean {
  return args.length === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "doctor") {
    const probe = args.includes("--probe");
    const { checks, ok } = await runDoctor({ probe });
    for (const check of checks) {
      const detail = check.detail ? `\n  (${check.detail})` : "";
      console.log(`${check.label}: ${check.status}${detail}`);
    }
    process.exit(ok ? 0 : 1);
  }
  if (args[0] === "sheet") {
    process.exit(await runSheetCli(args.slice(1)));
  }
  if (args[0] === "note") {
    process.exit(await runNoteCli(args.slice(1)));
  }
  if (args[0] === "memory") {
    process.exit(await runMemoryCli(args.slice(1)));
  }
  if (args[0] === "google") {
    process.exit(await runGoogleCli(args.slice(1)));
  }
  if (args[0] === "outlook") {
    process.exit(await runOutlookCli(args.slice(1)));
  }
  if (args[0] === "turns") {
    process.exit(runTurnsCli(args.slice(1)));
  }
  if (args[0] === "notify") {
    process.exit(await runNotifyCli(args.slice(1)));
  }
  if (args[0] === "cron") {
    process.exit(await runCronCli(args.slice(1)));
  }
  if (!isTelegramPollArgv(args)) {
    const help = args[0] === "--help" || args[0] === "-h";
    console.error(CLI_USAGE);
    process.exit(help ? 0 : 2);
  }
  const token = resolveBotToken();
  const api = new TelegramApi(token);
  const live = process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN === "1";
  console.log(live ? "melvbot TS daemon polling on live token" : "melvbot TS daemon polling on test token");

  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      stopSessionIdleSweep();
      stopPromptCacheRefresh();
      stopReminderTicker();
      process.exit(0);
    });
  }

  startSessionIdleSweep();
  startPromptCacheRefresh();
  await pollLoop(api);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

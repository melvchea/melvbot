import { recentTurns, type TurnLogEntry } from "./conversation_store.js";

const USAGE = "usage: melvbot turns [days=7] [--route <prefix>] [--chains]   (one line per assistant turn: time, route, status, timing, tools, prompt)\n";

const REDO_WINDOW_MS = 2 * 60_000;
const REDO_RE = /\b(differently|wrong|no,|actually|instead|undo|again|amend)\b/i;

/** Claude turns whose next turn in the same chat came within 2 minutes and reads like a correction. */
export function countRedos(turns: TurnLogEntry[]): number {
  let redos = 0;
  turns.forEach((turn, index) => {
    if (turn.route !== "claude" || turn.chatKey === null) {
      return;
    }
    const next = turns.slice(index + 1).find((later) => later.chatKey === turn.chatKey);
    if (next && Date.parse(next.createdAt) - Date.parse(turn.createdAt) <= REDO_WINDOW_MS && REDO_RE.test(next.prompt)) {
      redos += 1;
    }
  });
  return redos;
}

/** Claude turns grouped by melvbot_cli subcommand sequence, costliest (summed input tokens) first. */
export function chainStats(turns: TurnLogEntry[]): { chain: string; count: number; avgRoundTrips: number; inputTokens: number }[] {
  const groups = new Map<string, { count: number; trips: number; inputTokens: number }>();
  for (const turn of turns) {
    if (turn.cliCmds == null) {
      continue;
    }
    const key = turn.cliCmds.join(" > ") || "-";
    const group = groups.get(key) ?? { count: 0, trips: 0, inputTokens: 0 };
    group.count += 1;
    group.trips += turn.roundTrips ?? 0;
    group.inputTokens += turn.inputTokens;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([chain, g]) => ({ chain, count: g.count, avgRoundTrips: Math.round((g.trips / g.count) * 10) / 10, inputTokens: g.inputTokens }))
    .sort((a, b) => b.inputTokens - a.inputTokens);
}

/** `melvbot turns`: recent assistant turns with their prompt text, for finding requests worth a non-LLM intercept. */
export function runTurnsCli(args: string[]): number {
  let days = 7;
  let route: string | null = null;
  let chains = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--route") {
      route = args[index + 1] ?? null;
      index += 1;
    } else if (arg === "--chains") {
      chains = true;
    } else if (/^\d+$/.test(arg)) {
      days = Number(arg);
    } else {
      process.stderr.write(USAGE);
      return 2;
    }
  }
  const turns = recentTurns(days).filter((turn) => route === null || turn.route.startsWith(route));
  if (chains) {
    for (const row of chainStats(turns)) {
      process.stdout.write(`${row.count}\t${row.avgRoundTrips}\t${row.inputTokens}\t${row.chain}\n`);
    }
    return 0;
  }
  const counts = new Map<string, number>();
  for (const turn of turns) {
    counts.set(turn.route, (counts.get(turn.route) ?? 0) + 1);
    const prompt = turn.prompt.replace(/\s+/g, " ").slice(0, 300);
    const timing = `${turn.ms}ms ttft=${turn.ttftMs ?? "-"} spawn=${turn.spawnMs ?? "-"} rt=${turn.roundTrips ?? "-"} ctx=${turn.contextTokens ?? "-"} cr=${turn.cacheReadTokens ?? "-"} cw=${turn.cacheWriteTokens ?? "-"} pre=${turn.preMs ?? "-"} tool=${turn.toolMs ?? "-"}/${turn.toolCalls ?? "-"} think=${turn.thinking ? "y" : "n"}${turn.thinkRule ? `:${turn.thinkRule}` : ""}${turn.recallMiss === 1 ? " recall_miss" : ""}`;
    process.stdout.write(`${turn.createdAt.slice(0, 16)}\t${turn.route}\t${turn.status}\t${timing}\t${turn.tools.join(",") || "-"}\t${prompt}\n`);
  }
  const summary = [...counts.entries()].map(([name, count]) => `${name}=${count}`).join(" ");
  const claudeTurns = turns.filter((turn) => turn.route === "claude").length;
  const redos = countRedos(turns);
  const redoText = ` redo=${redos} (${claudeTurns ? Math.round((redos / claudeTurns) * 100) : 0}%)`;
  process.stdout.write(`# ${turns.length} turns in ${days}d${summary ? `: ${summary}${redoText}` : ""}\n`);
  return 0;
}

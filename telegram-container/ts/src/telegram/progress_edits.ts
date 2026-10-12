import { assembleTelegram, formatTopicHeader, type AssembledTelegram } from "./envelope.js";
import { PRIVATE_CHAT_INTERVAL_S } from "./outbox.js";

export const WORKING_LABEL = "working...";
export const QUEUING_LABEL = "queued";

export function initialProgressLabel(queueBusy: boolean): string {
  return queueBusy ? QUEUING_LABEL : WORKING_LABEL;
}

export const MAX_DRAFT_CHARS = 2500;
export const EMPTY_INLINE_KEYBOARD = { inline_keyboard: [] as never[] };
export const PROGRESS_EDIT_INTERVAL_S = PRIVATE_CHAT_INTERVAL_S;

export type ProgressDisplayOptions = {
  header?: string;
  label?: string;
  completedSteps?: readonly string[];
  currentAction?: string;
  elapsedS?: number;
};

export type ProgressEditFn = (assembled: AssembledTelegram) => Promise<unknown>;

export function clipDraft(text: string): string {
  if (text.length <= MAX_DRAFT_CHARS) {
    return text;
  }
  return text.slice(-MAX_DRAFT_CHARS);
}

export function formatElapsedSuffix(elapsedS: number): string {
  return elapsedS > 0 ? ` · ${elapsedS}s` : "";
}

export function formatToolStep(name: string, args?: unknown): string {
  if (name === "mcp" && args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const tool = record.tool ?? record.name;
    if (typeof tool === "string" && tool) {
      return `mcp: ${tool}`;
    }
  }
  return name;
}

export function formatToolAction(name: string, args?: unknown): string {
  return `using ${formatToolStep(name, args)}…`;
}

function formatStatusBody(options: ProgressDisplayOptions): string {
  const label = options.label ?? WORKING_LABEL;
  const timer = formatElapsedSuffix(options.elapsedS ?? 0);
  const lines: string[] = [];
  if (options.completedSteps?.length) {
    lines.push(options.completedSteps.map((step) => `✓ ${step}`).join("  "));
  }
  if (options.currentAction) {
    lines.push(`${options.currentAction}${timer}`);
    return lines.join("\n");
  }
  lines.push(`${label}${timer}`);
  return lines.join("\n");
}

export function formatProgress(draft: string, options?: ProgressDisplayOptions) {
  const label = options?.label ?? WORKING_LABEL;
  const clipped = clipDraft(draft).trim();
  const timer = formatElapsedSuffix(options?.elapsedS ?? 0);
  if (clipped) {
    return assembleTelegram({
      header: formatTopicHeader(options?.header),
      body: `${label}${timer}\n\n${clipped}`,
    });
  }
  return assembleTelegram({
    header: formatTopicHeader(options?.header),
    body: formatStatusBody(options ?? {}),
  });
}

export function createProgressPump(
  edit: ProgressEditFn,
  options?: {
    intervalS?: number;
    snapshot?: () => AssembledTelegram | null;
    sleep?: (seconds: number) => Promise<void>;
  },
) {
  const intervalS = options?.intervalS ?? 0;
  const sleep =
    options?.sleep ??
    ((seconds) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  let latest: AssembledTelegram | null = null;
  let lastText = "";
  let running: Promise<void> | null = null;
  let stopped = false;
  let wake: (() => void) | null = null;

  const apply = async (assembled: AssembledTelegram) => {
    if (assembled.text === lastText) {
      return;
    }
    lastText = assembled.text;
    try {
      await edit(assembled);
    } catch {
      lastText = "";
    }
  };

  const waitTick = async () => {
    if (intervalS <= 0) {
      return;
    }
    await Promise.race([
      sleep(intervalS),
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]);
    wake = null;
  };

  const drain = async () => {
    while (latest && !stopped) {
      const assembled = latest;
      latest = null;
      await apply(assembled);
    }
    running = null;
  };

  const heartbeat = async () => {
    while (!stopped) {
      const assembled = options?.snapshot?.() ?? latest;
      latest = null;
      if (assembled) {
        await apply(assembled);
      }
      if (stopped) {
        break;
      }
      await waitTick();
    }
    running = null;
  };

  const ensureLoop = () => {
    if (intervalS > 0) {
      running ??= heartbeat();
      return;
    }
    running ??= drain();
  };

  return {
    push(assembled: AssembledTelegram) {
      if (stopped) {
        return;
      }
      latest = assembled;
      ensureLoop();
      wake?.();
    },
    /** Like push, but does not wake the loop: the next interval tick shows it. For high-rate draft text. */
    schedule(assembled: AssembledTelegram) {
      if (stopped) {
        return;
      }
      latest = assembled;
      ensureLoop();
    },
    start() {
      if (stopped) {
        return;
      }
      ensureLoop();
    },
    async stop() {
      stopped = true;
      wake?.();
      await running;
      const pending = options?.snapshot?.() ?? latest;
      latest = null;
      if (pending) {
        await apply(pending);
      }
    },
  };
}

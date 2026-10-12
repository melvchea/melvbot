export const PRIVATE_CHAT_RPS = 1;
export const PRIVATE_CHAT_INTERVAL_S = 1 / PRIVATE_CHAT_RPS;
export const GROUP_CHAT_MESSAGES_PER_MIN = 20;
export const SECONDS_PER_MINUTE = 60;
export const GROUP_CHAT_INTERVAL_S = SECONDS_PER_MINUTE / GROUP_CHAT_MESSAGES_PER_MIN;
export const DEFAULT_EDIT_MIN_INTERVAL_S = PRIVATE_CHAT_INTERVAL_S;
export const FALLBACK_RETRY_AFTER_S = 5;
export const MAX_RETRY_AFTER_S = 60;
export const FLOOD_COOLDOWN_S = 60;
export const SEND_PRIORITY = 0;
export const EDIT_PRIORITY = 2;

export class RetryAfter extends Error {
  constructor(readonly retryAfterS: number) {
    super(`retry after ${retryAfterS}`);
  }
}

export function intervalForChatId(chatId: number | null): number {
  if (chatId !== null && chatId < 0) {
    return GROUP_CHAT_INTERVAL_S;
  }
  return PRIVATE_CHAT_INTERVAL_S;
}

export type OutboxClock = () => number;
export type OutboxSleep = (seconds: number) => Promise<void>;

export type OutboxOp = {
  execute: () => Promise<unknown>;
  priority: number;
  queuedAt: number;
  chatId: number | null;
  retainDuringFlood?: boolean;
};

type Pending = {
  key: string;
  op: OutboxOp;
  resolve: (value: unknown) => void;
};

export class TelegramOutbox {
  private readonly intervalForChat: (chatId: number | null) => number;
  private readonly clock: OutboxClock;
  private readonly sleep: OutboxSleep;
  private readonly editMinIntervalS: number;
  private readonly pending = new Map<string, Pending>();
  private nextAt = 0;
  private worker: Promise<void> | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(options?: {
    intervalForChat?: (chatId: number | null) => number;
    clock?: OutboxClock;
    sleep?: OutboxSleep;
    editMinIntervalS?: number;
  }) {
    this.intervalForChat =
      options?.intervalForChat ?? intervalForChatId;
    this.clock = options?.clock ?? (() => performance.now() / 1000);
    this.sleep =
      options?.sleep ??
      ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
    this.editMinIntervalS =
      options?.editMinIntervalS ?? DEFAULT_EDIT_MIN_INTERVAL_S;
  }

  intervalForOp(op: OutboxOp): number {
    return Math.max(PRIVATE_CHAT_INTERVAL_S, this.intervalForChat(op.chatId), this.editMinIntervalS);
  }

  drop(key: string): void {
    const previous = this.pending.get(key);
    if (!previous) {
      return;
    }
    this.pending.delete(key);
    previous.resolve(null);
  }

  async enqueue(key: string, op: OutboxOp): Promise<unknown> {
    this.ensureWorker();
    return new Promise((resolve) => {
      const previous = this.pending.get(key);
      if (previous) {
        previous.resolve(null);
        op.queuedAt = previous.op.queuedAt;
      }
      this.pending.set(key, { key, op, resolve });
      this.wake?.();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.pending.values()) {
      item.resolve(null);
    }
    this.pending.clear();
    this.wake?.();
    if (this.worker) {
      await this.worker;
    }
  }

  private ensureWorker(): void {
    if (this.worker || this.closed) {
      return;
    }
    this.worker = this.run();
  }

  private pick(): Pending | undefined {
    let chosen: Pending | undefined;
    for (const item of this.pending.values()) {
      if (
        !chosen ||
        item.op.priority < chosen.op.priority ||
        (item.op.priority === chosen.op.priority &&
          item.op.queuedAt < chosen.op.queuedAt)
      ) {
        chosen = item;
      }
    }
    return chosen;
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    while (!this.closed || this.pending.size > 0) {
      if (this.pending.size === 0) {
        if (this.closed) {
          return;
        }
        await this.waitForWork();
        continue;
      }
      const now = this.clock();
      if (now < this.nextAt) {
        await this.sleep(this.nextAt - now);
        continue;
      }
      const picked = this.pick();
      if (!picked) {
        continue;
      }
      this.pending.delete(picked.key);
      const startedAt = this.clock();
      try {
        picked.resolve(await picked.op.execute());
        this.nextAt = startedAt + this.intervalForOp(picked.op);
      } catch (error) {
        if (error instanceof RetryAfter) {
          const waitS =
            error.retryAfterS > MAX_RETRY_AFTER_S
              ? error.retryAfterS + FLOOD_COOLDOWN_S
              : error.retryAfterS;
          this.nextAt = this.clock() + waitS;
          if (error.retryAfterS <= MAX_RETRY_AFTER_S && !this.closed) {
            this.pending.set(picked.key, picked);
            continue;
          }
          console.error("telegram outbox op dropped", picked.key, `retry after ${error.retryAfterS}s`);
          picked.resolve(null);
          continue;
        }
        console.error("telegram outbox op failed", picked.key, error);
        picked.resolve(null);
        this.nextAt = startedAt + this.intervalForOp(picked.op);
      }
    }
  }
}

import { newQueueCancelId } from "../telegram/queue_cancel.js";
import { releaseTurnLock, tryAcquireTurnLock } from "./turn_lock.js";

export const QUEUED_FOOTER_TOKEN = "q";
export const LOCK_RETRY_MS = 500;
export const LOCK_MAX_RETRIES = 120;

export type AssistantPromptJob = {
  id: string;
  chatId: number;
  chatKey: string;
  prompt: string;
  /** Untrusted text (e.g. OCR of an attached image) shown to the model but never counted as the user's own words. */
  untrustedImageText?: string;
  progressMessageId: number | null;
  incomingVoice: boolean;
  ownerId: number | null;
};

export type AssistantPromptJobInput = Omit<AssistantPromptJob, "id">;

export type AssistantPromptQueueHandlers = {
  execute: (job: AssistantPromptJob, signal: AbortSignal) => Promise<void>;
  onLockExhausted: (job: AssistantPromptJob) => Promise<void>;
  onCleared: (job: AssistantPromptJob) => Promise<void>;
  onDequeued?: (job: AssistantPromptJob) => void;
  onIdle?: () => void;
};

export type TurnLockOps = {
  tryAcquire: () => number | null;
  release: (fd: number) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FIFO queue for assistant turns, cancelable via AbortController rather than an SDK Run handle. */
export class AssistantPromptQueue {
  private readonly jobs: AssistantPromptJob[] = [];
  private running = false;
  private inflightController: AbortController | null = null;
  private active: AssistantPromptJob | null = null;

  constructor(
    private readonly handlers: AssistantPromptQueueHandlers,
    private readonly lockOps: TurnLockOps = {
      tryAcquire: tryAcquireTurnLock,
      release: releaseTurnLock,
    },
  ) {}

  enqueue(job: AssistantPromptJobInput): string {
    const id = newQueueCancelId();
    this.jobs.push({ ...job, id });
    void this.pump();
    return id;
  }

  isPending(id: string): boolean {
    return this.jobs.some((job) => job.id === id);
  }

  findPending(id: string): AssistantPromptJob | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  drop(id: string): boolean {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index === -1) {
      return false;
    }
    const [removed] = this.jobs.splice(index, 1);
    void this.handlers.onCleared(removed);
    return true;
  }

  clear(): AssistantPromptJob[] {
    const dropped = this.jobs.splice(0);
    for (const job of dropped) {
      void this.handlers.onCleared(job);
    }
    return dropped;
  }

  activeJob(): AssistantPromptJob | null {
    return this.active;
  }

  hasInflight(): boolean {
    return this.inflightController !== null;
  }

  /** Aborts the currently running turn, if any. Idempotent. */
  cancelInflight(): boolean {
    if (!this.inflightController) {
      return false;
    }
    this.inflightController.abort();
    return true;
  }

  /** Cancels the job if it's the one currently running; otherwise a no-op (the caller should `drop` a pending job instead). */
  requestInflightStop(id: string): boolean {
    if (this.active?.id !== id) {
      return false;
    }
    return this.cancelInflight();
  }

  pendingCount(): number {
    return this.jobs.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        this.active = job;
        try {
          this.handlers.onDequeued?.(job);
          let fd: number | null = null;
          for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
            fd = this.lockOps.tryAcquire();
            if (fd !== null) {
              break;
            }
            await sleep(LOCK_RETRY_MS);
          }
          if (fd === null) {
            await this.handlers.onLockExhausted(job);
            continue;
          }
          const controller = new AbortController();
          this.inflightController = controller;
          try {
            await this.handlers.execute(job, controller.signal);
          } finally {
            this.lockOps.release(fd);
          }
        } finally {
          this.inflightController = null;
          if (this.active?.id === job.id) {
            this.active = null;
          }
        }
      }
    } finally {
      this.running = false;
      if (this.jobs.length > 0) {
        void this.pump();
      } else {
        this.handlers.onIdle?.();
      }
    }
  }
}

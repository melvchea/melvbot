import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RETRY_AFTER_S,
  RetryAfter,
  SEND_PRIORITY,
  TelegramOutbox,
} from "../src/telegram/outbox.js";

class AutoClock {
  now = 0;
  async sleep(seconds: number): Promise<void> {
    this.now += Math.max(0, seconds);
  }
}

test("outbox waits retry_after then retries a short 429", async () => {
  const clock = new AutoClock();
  let attempts = 0;
  const outbox = new TelegramOutbox({
    clock: () => clock.now,
    sleep: (seconds) => clock.sleep(seconds),
  });
  const retryAfterS = 3;
  const result = await outbox.enqueue("send:1:hi", {
    execute: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RetryAfter(retryAfterS);
      }
      return "ok";
    },
    priority: SEND_PRIORITY,
    queuedAt: 0,
    chatId: 1,
  });
  await outbox.close();
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.ok(clock.now >= retryAfterS);
});

test("outbox drops a flood-limited send past the retry cap and returns null", async () => {
  const clock = new AutoClock();
  const outbox = new TelegramOutbox({
    clock: () => clock.now,
    sleep: (seconds) => clock.sleep(seconds),
  });
  const result = await outbox.enqueue("send:1:hi", {
    execute: async () => {
      throw new RetryAfter(MAX_RETRY_AFTER_S + 1);
    },
    priority: SEND_PRIORITY,
    queuedAt: 0,
    chatId: 1,
  });
  await outbox.close();
  assert.equal(result, null);
});

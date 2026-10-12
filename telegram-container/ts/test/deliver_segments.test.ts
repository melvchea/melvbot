import assert from "node:assert/strict";
import test from "node:test";

import { deliverSegments } from "../src/telegram/deliver_segments.js";

test("entity rejection retries once with the raw text and no entities", async () => {
  const calls: string[] = [];
  const api = {
    async sendMessage(_c: number, text: string, extra?: { entities?: unknown[] }) {
      if (extra?.entities) throw new Error("can't parse entities");
      calls.push(`send:${text}`);
      return { message_id: 1 };
    },
  };
  await deliverSegments(api as never, 1, "**Hi** there", null);
  assert.deepEqual(calls, ["send:**Hi** there"]);
});

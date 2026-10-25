import assert from "node:assert/strict";
import test from "node:test";

import { sendEphemeral } from "../src/telegram/ephemeral.js";

test("sendEphemeral deletes the sent message after the TTL, and a failed delete is swallowed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deleted: Array<[number, number]> = [];
  const api = {
    sendMessage: async () => ({ message_id: 42 }),
    deleteMessage: async (chatId: number, messageId: number) => {
      deleted.push([chatId, messageId]);
      throw new Error("message to delete not found");
    },
  };
  await sendEphemeral(api, 7, "Started fresh.", 10_000);
  t.mock.timers.tick(9_999);
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  assert.deepEqual(deleted, [[7, 42]]);
});

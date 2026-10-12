import assert from "node:assert/strict";
import test from "node:test";

import { tempDbPath } from "./helpers/temp.js";
import { stubFetch } from "./helpers/fetch.js";

process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath();

import { TelegramApi, type TelegramMessage } from "../src/telegram/api.js";
import { TelegramOutbox } from "../src/telegram/outbox.js";
import { clearAllConfirmations, createConfirmation, latestPendingConfirmationCode } from "../src/assistant/confirm.js";
import { handleCallback, handleIncoming, withReplyContext } from "../src/daemon.js";
import { isConfirmYes } from "../src/telegram/prose_intercept.js";
import { EMPTY_INLINE_KEYBOARD } from "../src/telegram/progress_edits.js";

const CONFIRM_YES_PREFIX = "cfy:";

test("expired confirm callback replaces the message with an expiry note and no keyboard", async () => {
  const calls: unknown[][] = [];
  const api = {
    editMessageText: async (...args: unknown[]) => void calls.push(["edit", ...args]),
    answerCallback: async (...args: unknown[]) => void calls.push(["answer", ...args]),
  } as unknown as TelegramApi;
  await handleCallback(api, {
    id: "cb1",
    from: { id: 7 },
    data: `${CONFIRM_YES_PREFIX}nosuchcode`,
    message: { message_id: 9, chat: { id: 42 } },
  });
  assert.deepEqual(calls, [
    ["edit", 42, 9, "Expired, ask me again.", { reply_markup: EMPTY_INLINE_KEYBOARD }],
    ["answer", "cb1", "expired"],
  ]);
});

test("final edit with a keyboard is not clobbered by a stale queued markup edit", async () => {
  const sent: Record<string, unknown>[] = [];
  const stub = stubFetch((url, init) => {
    sent.push({ method: url.pathname.split("/").pop(), ...JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  });
  const clock = { now: 0 };
  const outbox = new TelegramOutbox({
    clock: () => clock.now,
    sleep: async (s) => void (clock.now += s),
  });
  const api = new TelegramApi("t", outbox);
  const confirm = { inline_keyboard: [[{ text: "Confirm", callback_data: "c" }]] };
  try {
    const first = api.editMessageText(1, 5, "progress", { reply_markup: { inline_keyboard: [] } });
    const stale = api.editMessageReplyMarkup(1, 5, { inline_keyboard: [[{ text: "Cancel job", callback_data: "q" }]] });
    const final = api.editMessageText(1, 5, "Create Note?", { reply_markup: confirm });
    await Promise.all([first, stale, final]);
    await outbox.close();
  } finally {
    stub.restore();
  }
  const last = sent[sent.length - 1];
  assert.equal(last.method, "editMessageText");
  assert.deepEqual(last.reply_markup, confirm);
  assert.ok(!sent.some((c) => c.method === "editMessageReplyMarkup"));
});

test("a bare yes confirms the chat's pending action without a Claude call; extra text is not a confirmation", async () => {
  for (const yes of ["yes", "OK"]) {
    assert.equal(isConfirmYes(yes), true, yes);
  }
  for (const other of ["yes. but remove Max", "yesterday"]) {
    assert.equal(isConfirmYes(other), false, other);
  }
  clearAllConfirmations();
  createConfirmation("telegram:42", "cron delete", { note: "no args: resolves to Confirmed." }, "Delete job?");
  const sent: unknown[][] = [];
  const api = { sendMessage: async (...args: unknown[]) => void sent.push(args) } as unknown as TelegramApi;
  await handleIncoming(api, { message_id: 5, chat: { id: 42 }, from: { id: 7 }, text: "Yes." });
  assert.deepEqual(sent, [[42, "Confirmed."]]);
  assert.equal(latestPendingConfirmationCode("telegram:42"), null);
});

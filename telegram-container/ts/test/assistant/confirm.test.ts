import assert from "node:assert/strict";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";

process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath();

import {
  CONFIRM_TTL_MS,
  actionRequiresConfirm,
  assertConfirmableInSource,
  clearAllConfirmations,
  clearConfirmationCache,
  consumeConfirmation,
  buildNoteAddConfirmationSummary,
  confirmFailureText,
  createConfirmation,
  noteAddRequiresConfirm,
} from "../../src/assistant/confirm.js";

test("actionRequiresConfirm matches the plan's static Confirm-required list; assertConfirmableInSource refuses Confirm-required actions from cron", () => {
  for (const action of [
    "sheet spend void",
    "sheet ev void",
    "sheet rules set",
    "sheet rules delete",
    "sheet create",
    "note delete",
    "cron add",
    "cron update",
    "cron enable",
    "cron disable",
    "cron delete",
    "google tasks delete",
    "google calendar delete",
  ]) {
    assert.equal(actionRequiresConfirm(action), true, action);
  }
  assert.equal(actionRequiresConfirm("note get"), false);
  assert.equal(actionRequiresConfirm("sheet spend add"), false);
  {
    assert.throws(() => assertConfirmableInSource("cron delete", "cron"), /refusing cron delete in a cron turn/);
    assert.doesNotThrow(() => assertConfirmableInSource("cron delete", "telegram"));
    assert.doesNotThrow(() => assertConfirmableInSource("sheet spend add", "cron"));
  }
});

test("consumeConfirmation reloads from sqlite after the cache is cleared, is single-use, and returns null once expired", () => {
  clearAllConfirmations();
  const confirmation = createConfirmation("chat-1", "note delete", { slug: "phone-buy" }, "Delete note phone-buy?");
  clearConfirmationCache();
  const loaded = consumeConfirmation(confirmation.code);
  assert.equal(loaded?.code, confirmation.code);
  assert.equal(consumeConfirmation(confirmation.code), null);
  clearAllConfirmations();
  const once = createConfirmation("chat-1", "note delete", { slug: "phone-buy" }, "Delete note phone-buy?");
  const first = consumeConfirmation(once.code);
  assert.ok(first);
  assert.equal(first?.action, "note delete");
  const second = consumeConfirmation(once.code);
  assert.equal(second, null, "a code must not be usable twice");
  clearAllConfirmations();
  const now = 1_000_000;
  const expiring = createConfirmation("chat-1", "cron delete", { id: "job-1" }, "Delete this job?", now);
  const result = consumeConfirmation(expiring.code, now + CONFIRM_TTL_MS + 1);
  assert.equal(result, null);
});

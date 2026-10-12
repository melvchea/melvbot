import assert from "node:assert/strict";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";

process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath();

import { actionRequiresConfirm } from "../../src/assistant/confirm.js";
import { cliAction, newMcpTurnState, runMelvbotCliInner, webBlocked } from "../../src/assistant/custom_tools.js";
import { isGuardedWriteAction } from "../../src/assistant/write_guard.js";

test("google and sheet writes use the full verb for confirm and the injection guard", () => {
  const tasksDelete = cliAction(["google", "tasks", "delete", "abc"]);
  assert.equal(tasksDelete, "google tasks delete");
  assert.equal(isGuardedWriteAction(tasksDelete ?? ""), true);

  const tasksCreate = cliAction(["google", "tasks", "create", "Call clinic"]);
  assert.equal(tasksCreate, "google tasks create");
  assert.equal(actionRequiresConfirm(tasksCreate ?? ""), false);
  assert.equal(isGuardedWriteAction(tasksCreate ?? ""), true);

  assert.equal(cliAction(["sheet", "spend", "void", "1"]), "sheet spend void");
  assert.equal(cliAction(["cron", "delete", "job"]), "cron delete");
});

test("telegram sheet create only queues a Confirm and never creates; cron is refused", async () => {
  const argv = ["sheet", "create", "Alt scenario", "--note", "bank-save", "--tab", "Spend:Category,Amount"];
  const state = newMcpTurnState("telegram", "chat-1", "create a new sheet", false);
  const result = await runMelvbotCliInner({ args: argv }, state);
  assert.match(result.content[0].text, /needs confirmation/);
  assert.match(state.pendingConfirmation?.summary ?? "", /Alt scenario[\s\S]*Spend \(Category, Amount\)[\s\S]*bank-save/);
  const cron = await runMelvbotCliInner({ args: argv }, newMcpTurnState("cron", null, "", false));
  assert.equal(cron.isError, true);
});

test("DCA cron turn refuses web tools; normal turns keep them", async () => {
  const blocked = await webBlocked(newMcpTurnState("cron", null, "", false, true));
  assert.equal(blocked?.isError, true);
  assert.equal(webBlocked(newMcpTurnState("cron", null, "", false)), null);
});

test("an offered note write (stage: true) leaves a pending confirmation that a bare yes can consume without Claude", async () => {
  const { consumeConfirmation, latestPendingConfirmationCode } = await import("../../src/assistant/confirm.js");
  const argv = ["note", "append-history", "tv-buy", "2026-10-08 chose model X"];
  const state = newMcpTurnState("telegram", "telegram:77", "yes add it", false);
  const result = await runMelvbotCliInner({ args: argv, stage: true }, state);
  assert.match(result.content[0].text, /needs confirmation/);
  const code = latestPendingConfirmationCode("telegram:77");
  assert.equal(code, state.pendingConfirmation?.code);
  assert.deepEqual((consumeConfirmation(code ?? "") as { payload: unknown } | null)?.payload, { args: argv });
});

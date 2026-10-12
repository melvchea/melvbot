import assert from "node:assert/strict";
import test from "node:test";

import { latestUndoableChange, recordChange } from "../../src/memory/change_log.js";
import { undoLastChange } from "../../src/memory/undo.js";
import { setMelvbotEnv } from "../helpers/env.js";
import { tempDbPath } from "../helpers/temp.js";

test("latestUndoableChange is Notes-only and scoped to the chat", () => {
  const dbPath = tempDbPath();
  recordChange({ action: "note add", target: "phone-buy", before: null, after: {}, chatKey: "chat-a", dbPath });
  recordChange({ action: "note add", target: "family-eat", before: null, after: {}, chatKey: "chat-b", dbPath });
  recordChange({ action: "sheet rules set", target: "owner1:target", before: {}, after: {}, chatKey: "chat-a", dbPath });
  assert.equal(latestUndoableChange("chat-a", dbPath)?.target, "phone-buy");
  assert.equal(latestUndoableChange("chat-b", dbPath)?.target, "family-eat");
  assert.equal(latestUndoableChange("chat-c", dbPath), null);
  assert.equal(latestUndoableChange(null, dbPath)?.target, "family-eat");
});

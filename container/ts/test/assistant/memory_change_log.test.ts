import assert from "node:assert/strict";
import test from "node:test";

import { lastChangeAt, latestUndoableChange, recordChange } from "../../src/memory/change_log.js";
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

test("lastChangeAt finds the newest spend add per card and never counts as undoable", () => {
  const dbPath = tempDbPath();
  assert.equal(lastChangeAt("spend add", "owner1/card1", dbPath), null);
  recordChange({ action: "spend add", target: "owner1/card1", before: null, after: {}, dbPath });
  assert.ok(lastChangeAt("spend add", "owner1/card1", dbPath));
  assert.equal(lastChangeAt("spend add", "owner2/card2", dbPath), null);
  assert.equal(latestUndoableChange(null, dbPath), null);
});

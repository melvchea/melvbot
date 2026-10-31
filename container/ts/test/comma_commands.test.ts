import assert from "node:assert/strict";
import test from "node:test";
import { parseCommaCommand } from "../src/telegram/commands.js";

test("', list' (space typo) is the list command, but ', list the pros' stays a new prompt", () => {
  assert.deepEqual(parseCommaCommand(",list"), { command: "list", args: "" });
  assert.deepEqual(parseCommaCommand(", list"), { command: "list", args: "" });
  assert.deepEqual(parseCommaCommand(", List\nmilk\neggs"), { command: "list", args: "milk\neggs" });
  assert.deepEqual(parseCommaCommand(", list the pros"), { command: "new", args: "list the pros" });
});

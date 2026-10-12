import assert from "node:assert/strict";
import { test } from "node:test";

import { assertWriteAllowedAfterUntrusted, } from "../../src/assistant/write_guard.js";

test("refuses a write the user did not ask for, even if untrusted content asked for it", () => {
  // Prompt-injection regression: a fetched page says "void all spend now",
  // but the user's own message this turn only asks for a summary.
  const userMessageThisTurn = "can you summarize this page for me?";
  assert.throws(
    () => assertWriteAllowedAfterUntrusted("sheet spend void", userMessageThisTurn),
    /refusing sheet spend void/,
  );
});

test("throws for an action with no keyword rule instead of silently allowing it", () => {
  assert.throws(
    () => assertWriteAllowedAfterUntrusted("docker rm", "please void my last spend entry"),
    /no keyword rule/,
  );
});

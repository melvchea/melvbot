import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ClaudeUnavailableError,
  claudeUnavailable,
  markClaudeUnavailable,
  resetClaudeBackoff,
  runClaudeTurn,
  setQueryImplForTests,
  UNAVAILABLE_BACKOFF_MS,
} from "../../src/assistant/claude_session.js";
import { FALLBACK_NOTICE, runFallbackTurn, type FallbackTurnOptions } from "../../src/assistant/fallback.js";
import type { StoredMessage } from "../../src/assistant/conversation_store.js";
import { allMessages } from "../../src/assistant/conversation_store.js";
import type { AssistantToml } from "../../src/assistant/toml.js";
import { runTurn } from "../../src/assistant/turn.js";
import { stubFetch } from "../helpers/fetch.js";
import { withTempDb } from "../helpers/temp.js";

const TOML: AssistantToml = { model: "claude-haiku-4-5", reasoning: "off", idleResetHours: 6 };

function stored(seq: number, role: "user" | "assistant", text: string): StoredMessage {
  return {
    chatKey: "c",
    seq,
    createdAt: "2026-10-02T00:00:00Z",
    role,
    contentJson: JSON.stringify([{ type: "text", text }]),
    nativeProvider: null,
    nativeJson: null,
  };
}

test("runFallbackTurn tries the next provider when the first fails and strips think blocks; runFallbackTurn throws when every provider fails or has no key", async () => {
  const stub = stubFetch((url) => {
    if (url.href.includes("groq")) {
      return new Response("nope", { status: 500 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>hello" } }] }), { status: 200 });
  });
  try {
    const providers: FallbackTurnOptions["providers"] = [
      { name: "groq", url: "https://api.groq.com/x", model: "m1", key: () => "k" },
      { name: "minimax", url: "https://api.minimax.io/x", model: "m2", key: () => "k" },
    ];
    const result = await runFallbackTurn({
      systemPrompt: "sys",
      history: [stored(0, "user", "hi")],
      prompt: "hi",
      signal: new AbortController().signal,
      providers,
    });
    assert.deepEqual(result, { text: "hello", provider: "minimax" });
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
  {
    await assert.rejects(
      () =>
        runFallbackTurn({
          systemPrompt: "sys",
          history: [],
          prompt: "hi",
          signal: new AbortController().signal,
          providers: [{ name: "groq", url: "https://x", model: "m", key: () => "" }],
        }),
      /fallback failed: groq key missing/,
    );
  }
});

test("a chat turn degrades to the fallback with a notice when Claude is unavailable", async () => {
  await withTempDb("assistant-fallback-", async (dbPath) => {
    const seen: FallbackTurnOptions[] = [];
    const logs: string[] = [];
    const prevLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const result = await runTurn(
        { chatKey: "chat-1", prompt: "what is on my todo note?", signal: new AbortController().signal, source: "telegram" },
        {
          assistantToml: TOML,
          systemPrompt: "test system",
          dbPath,
          claudeTurn: async () => {
            throw new ClaudeUnavailableError("claude unavailable: rate_limit", "rate_limit");
          },
          fallbackTurn: async (options) => {
            seen.push(options);
            return { text: "Buy milk.", provider: "groq" };
          },
        },
      );
      assert.equal(result.status, "fallback");
      assert.ok(result.text.startsWith(FALLBACK_NOTICE));
      assert.ok(result.text.endsWith("Buy milk."));
      assert.deepEqual(result.toolNames, ["fallback:groq"]);
    } finally {
      console.log = prevLog;
    }
    assert.equal(seen.length, 1);
    assert.equal(allMessages("chat-1", dbPath).at(-1)?.role, "assistant");
    assert.ok(logs.some((line) => line.startsWith("assistant_turn.fallback")));
  });
});

test("the backoff breaker fails Claude turns fast, caps at the reset time, and clears", async () => {
  resetClaudeBackoff();
  assert.equal(claudeUnavailable(), false);
  const error = markClaudeUnavailable("rate_limit");
  assert.ok(error instanceof ClaudeUnavailableError);
  assert.equal(claudeUnavailable(), true);
  assert.equal(claudeUnavailable(Date.now() + UNAVAILABLE_BACKOFF_MS + 1_000), false);

  let sdkCalls = 0;
  setQueryImplForTests((() => {
    sdkCalls += 1;
    throw new Error("backoff must not reach the SDK");
  }) as never);
  await assert.rejects(
    runClaudeTurn({
      chatKey: null,
      model: "claude-haiku-4-5",
      reasoning: "off",
      systemPrompt: "s",
      prompt: "p",
      source: "cron",
      signal: new AbortController().signal,
      idleResetHours: 6,
      untrustedPrefetchApplied: false,
    }),
    (thrown: unknown) => thrown instanceof ClaudeUnavailableError && thrown.reason === "backoff",
  );
  assert.equal(sdkCalls, 0);
  setQueryImplForTests(null);

  // A reset time already in the past ends the backoff immediately.
  markClaudeUnavailable("rate_limit", Math.floor(Date.now() / 1000) - 10);
  assert.equal(claudeUnavailable(), false);
  resetClaudeBackoff();
});

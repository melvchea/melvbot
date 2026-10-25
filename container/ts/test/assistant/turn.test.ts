import assert from "node:assert/strict";
import { test } from "node:test";

import { allMessages, recentTurns } from "../../src/assistant/conversation_store.js";
import type { ClaudeTurnOptions, ClaudeTurnResult } from "../../src/assistant/claude_session.js";
import type { AssistantToml } from "../../src/assistant/toml.js";
import { withTempDb } from "../helpers/temp.js";

import { runTurn } from "../../src/assistant/turn.js";

function fakeClaudeTurn(script: {
  text?: string;
  toolNames?: string[];
  pendingConfirmation?: ClaudeTurnResult["pendingConfirmation"];
  throws?: Error;
}): { calls: ClaudeTurnOptions[]; run: typeof import("../../src/assistant/claude_session.js").runClaudeTurn } {
  const calls: ClaudeTurnOptions[] = [];
  const run = async (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    calls.push(options);
    if (script.throws) {
      throw script.throws;
    }
    if (script.text) {
      options.onText?.(script.text);
    }
    return {
      text: script.text ?? "",
      toolNames: script.toolNames ?? [],
      inputTokens: 10,
      outputTokens: 5,
      pendingConfirmation: script.pendingConfirmation,
    };
  };
  return { calls, run };
}

const TOML: AssistantToml = { model: "fake-model", reasoning: "off", idleResetHours: 6 };

test("runTurn persists an audit-only user and assistant record for the chat; cron turns (chatKey: null) never persist anything", async () => {
  await withTempDb("assistant-turn-", async (dbPath) => {
    const { run } = fakeClaudeTurn({ text: "fresh reply" });
    await runTurn(
      { chatKey: "chat-2", prompt: "new message", signal: new AbortController().signal, source: "telegram" },
      { claudeTurn: run, assistantToml: TOML, systemPrompt: "test system", dbPath },
    );
    const rows = allMessages("chat-2", dbPath);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].role, "user");
    assert.equal(rows[1].role, "assistant");
  });
  {
    await withTempDb("assistant-turn-", async (dbPath) => {
      const { run } = fakeClaudeTurn({ text: "ok" });
      await runTurn(
        { chatKey: null, prompt: "hi", signal: new AbortController().signal, source: "cron" },
        { claudeTurn: run, assistantToml: TOML, systemPrompt: "test system", dbPath },
      );
      assert.equal(allMessages("some-other-chat", dbPath).length, 0);
    });
  }
});

test("an empty Claude reply (only stripped <thinking>) sends the fallback notice and logs status empty; runTurn rethrows and logs an error status when the Claude turn throws", async () => {
  await withTempDb("assistant-turn-", async (dbPath) => {
    const { run } = fakeClaudeTurn({ text: "" });
    const streamed: string[] = [];
    const result = await runTurn(
      { chatKey: "chat-6", prompt: "hi", signal: new AbortController().signal, source: "telegram", onText: (t) => streamed.push(t) },
      { claudeTurn: run, assistantToml: TOML, systemPrompt: "test system", dbPath },
    );
    assert.equal(result.status, "empty");
    assert.equal(result.text, "I couldn't produce an answer — please try again.");
    assert.deepEqual(streamed, [result.text]);
    assert.equal(recentTurns(5, dbPath)[0]?.status, "empty");
  });
  {
    await withTempDb("assistant-turn-", async (dbPath) => {
      const { run } = fakeClaudeTurn({ throws: new Error("claude agent run failed") });
      const logs: string[] = [];
      const prevLog = console.log;
      console.log = (line: string) => logs.push(line);
      try {
        await assert.rejects(
          () =>
            runTurn(
              { chatKey: "chat-5", prompt: "hi", signal: new AbortController().signal, source: "telegram" },
              { claudeTurn: run, assistantToml: TOML, systemPrompt: "test system", dbPath },
            ),
          /claude agent run failed/,
        );
      } finally {
        console.log = prevLog;
      }
      const parsed = JSON.parse(logs[0].slice("assistant_turn ".length)) as Record<string, unknown>;
      assert.equal(parsed.status, "error");
    });
  }
});

test("a chat whose last Claude turn read more than the token limit starts a fresh session", async () => {
  await withTempDb("assistant-turn-", async (dbPath) => {
    const { saveClaudeSession, getClaudeSession, recordTurn, recentTurns } = await import("../../src/assistant/conversation_store.js");
    const { RESUME_CONTEXT_TOKEN_LIMIT } = await import("../../src/assistant/turn.js");
    const sid = "11111111-2222-3333-4444-555555555555";
    const logTurn = (chatKey: string, contextTokens: number | null) =>
      recordTurn({ chatKey, source: "telegram", route: "claude", tools: [], inputTokens: 500000, contextTokens, cacheReadTokens: 7, cacheWriteTokens: 3, outputTokens: 1, ms: 1, status: "ok", prompt: "p" }, dbPath);
    logTurn("cache", 1);
    const cached = recentTurns(1, dbPath).find((t) => t.chatKey === "cache");
    assert.deepEqual([cached?.cacheReadTokens, cached?.cacheWriteTokens], [7, 3]);
    saveClaudeSession("big", sid, dbPath);
    saveClaudeSession("small", sid, dbPath);
    saveClaudeSession("old", sid, dbPath);
    logTurn("big", RESUME_CONTEXT_TOKEN_LIMIT + 1);
    logTurn("small", RESUME_CONTEXT_TOKEN_LIMIT);
    logTurn("old", null);
    const { run } = fakeClaudeTurn({ text: "ok" });
    for (const chatKey of ["big", "small", "old"]) {
      await runTurn(
        { chatKey, prompt: "hello", signal: new AbortController().signal, source: "telegram" },
        { claudeTurn: run, assistantToml: TOML, systemPrompt: "test system", dbPath },
      );
    }
    assert.equal(getClaudeSession("big", 6, dbPath), null);
    assert.equal(getClaudeSession("small", 6, dbPath)?.sessionId, sid);
    assert.equal(getClaudeSession("old", 6, dbPath)?.sessionId, sid);
  });
});

test("think trigger: prefix is stripped, prose rule triggers, a short plain message stays off", async () => {
  await withTempDb("assistant-turn-", async (dbPath) => {
    const run = async (prompt: string) => {
      const { calls, run: claudeTurn } = fakeClaudeTurn({ text: "ok" });
      await runTurn(
        { chatKey: "chat-think", prompt, signal: new AbortController().signal, source: "telegram" },
        { claudeTurn, assistantToml: TOML, systemPrompt: "test system", dbPath },
      );
      return calls[0];
    };
    const prefixed = await run("  Think: what is 2+2");
    assert.equal(prefixed.think, true);
    assert.equal(prefixed.userMessage, "what is 2+2");
    assert.equal((await run("compare tea vs coffee")).think, true);
    for (const text of ["yes", "Confirm", "okay", "ok, go ahead!", "yes please"]) {
      assert.equal((await run(text)).think, false, text);
    }
    assert.equal((await run("think: yes")).think, true);
    assert.equal((await run("remind me to buy milk")).think, false);
    assert.equal((await run("add this to my note")).think, false);
    assert.equal((await run("update my house rules")).think, false);
    assert.equal((await run("what are my house rules?")).think, false);
    assert.equal((await run("what's in my trip note?")).think, false);
    const turns = recentTurns(1, dbPath);
    assert.deepEqual(turns.map((t) => t.thinkRule), ["prefix", "compare", null, null, null, null, null, "prefix", null, null, null, null, null]);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeAllLiveSessions,
  liveSessionCount,
  resetClaudeBackoff,
  runClaudeTurn,
  setQueryImplForTests,
  type ClaudeTurnOptions,
} from "../../src/assistant/claude_session.js";
import { getClaudeSession } from "../../src/assistant/conversation_store.js";
import { deferred } from "../helpers/async.js";
import { withTempDb } from "../helpers/temp.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

type FakeCall = { prompt: unknown; options: Record<string, unknown>; closed: boolean; interrupts: number; thinking: (number | null)[] };

/**
 * A fake SDK query: in streaming mode answers every pushed user message with deltas, an assistant message and a result.
 * `onHold` fires once the held turn has reached its hold point (the query is waiting for an interrupt).
 */
function installFake(opts: { holdUntilInterrupt?: boolean; dieAfterFirst?: boolean; onHold?: () => void } = {}) {
  const calls: FakeCall[] = [];
  let spawned = 0;
  setQueryImpl((params: { prompt: unknown; options: Record<string, unknown> }) => {
    const call: FakeCall = { prompt: params.prompt, options: params.options, closed: false, interrupts: 0, thinking: [] };
    calls.push(call);
    spawned += 1;
    const mine = spawned;
    const answer = (n: number) => [
      { type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "message_start" } },
      { type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } },
      { type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "assistant", session_id: SESSION, message: { content: [{ type: "text", text: `hello ${mine}.${n}` }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } },
      { type: "result", subtype: "success", is_error: false, session_id: SESSION, usage: { input_tokens: 5, output_tokens: 2 } },
    ];
    let interruptWake: (() => void) | undefined;
    const iterator = (async function* () {
      if (typeof params.prompt === "string") {
        yield* answer(1);
        return;
      }
      let n = 0;
      for await (const _user of params.prompt as AsyncIterable<unknown>) {
        n += 1;
        if (opts.dieAfterFirst && n > 1 && mine === 1) {
          return;
        }
        if (opts.holdUntilInterrupt && n === 2) {
          opts.onHold?.();
          await new Promise<void>((resolve) => (interruptWake = resolve));
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], session_id: SESSION, usage: { input_tokens: 1, output_tokens: 0 } };
          continue;
        }
        yield* answer(n);
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        call.interrupts += 1;
        interruptWake?.();
      },
      setMaxThinkingTokens: async (n: number | null) => {
        call.thinking.push(n);
      },
      close: () => {
        call.closed = true;
      },
    } as never;
  });
  return calls;
}

function setQueryImpl(fn: (params: { prompt: unknown; options: Record<string, unknown> }) => never): void {
  setQueryImplForTests(fn as never);
}

function base(dbPath: string, overrides: Partial<ClaudeTurnOptions> = {}): ClaudeTurnOptions {
  return {
    chatKey: "chat-live",
    model: "claude-haiku-4-5",
    reasoning: "off",
    systemPrompt: "sys",
    prompt: "hi",
    source: "telegram",
    signal: new AbortController().signal,
    idleResetHours: 6,
    untrustedPrefetchApplied: false,
    dbPath,
    ...overrides,
  };
}

async function withEnv<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  resetClaudeBackoff();
  try {
    return await withTempDb("claude-session-", fn);
  } finally {
    closeAllLiveSessions();
    setQueryImplForTests(null);
  }
}

test("consecutive turns in a chat reuse one live query and stream growing round text", async () => {
  await withEnv(async (dbPath) => {
    const calls = installFake();
    const seen: string[] = [];
    const first = await runClaudeTurn(base(dbPath, { onText: (t) => seen.push(t) }));
    const second = await runClaudeTurn(base(dbPath, { prompt: "again" }));
    assert.equal(calls.length, 1);
    assert.equal(liveSessionCount(), 1);
    assert.deepEqual(seen, ["hel", "hello"]);
    assert.equal(first.text, "hello 1.1");
    assert.equal(second.text, "hello 1.2");
    assert.equal(second.spawnMs, 0);
    assert.equal(second.roundTrips, 1);
    assert.equal(second.contextTokens, 110);
    assert.ok(first.ttftMs !== undefined);
    assert.equal(calls[0].options.includePartialMessages, true);
    assert.equal(getClaudeSession("chat-live", 6, dbPath)?.sessionId, SESSION);
  });
});

test("a changed system prompt respawns the live query with resume; a dead live process falls back to a fresh query with resume", async () => {
  await withEnv(async (dbPath) => {
    const calls = installFake();
    await runClaudeTurn(base(dbPath));
    await runClaudeTurn(base(dbPath, { systemPrompt: "other" }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].closed, true);
    assert.equal(calls[1].options.resume, SESSION);
  });
  {
    await withEnv(async (dbPath) => {
      const calls = installFake({ dieAfterFirst: true });
      await runClaudeTurn(base(dbPath));
      const second = await runClaudeTurn(base(dbPath, { prompt: "again" }));
      assert.equal(calls.length, 2);
      assert.equal(calls[0].closed, true);
      assert.equal(calls[1].options.resume, SESSION);
      assert.equal(second.text, "hello 2.1");
    });
  }
});

test("aborting a live turn interrupts it and keeps the process for the next turn", async () => {
  await withEnv(async (dbPath) => {
    const held = deferred();
    const calls = installFake({ holdUntilInterrupt: true, onHold: held.resolve });
    await runClaudeTurn(base(dbPath));
    const controller = new AbortController();
    const turn = runClaudeTurn(base(dbPath, { signal: controller.signal }));
    await held.promise;
    controller.abort();
    await assert.rejects(turn, /cancelled/);
    assert.equal(calls[0].interrupts, 1);
    assert.equal(calls[0].closed, false);
    const next = await runClaudeTurn(base(dbPath));
    assert.equal(calls.length, 1);
    assert.equal(next.text, "hello 1.3");
  });
});

test("a think turn enables thinking on the live query and resets it to disabled even when the turn is aborted", async () => {
  await withEnv(async (dbPath) => {
    const held = deferred();
    const calls = installFake({ holdUntilInterrupt: true, onHold: held.resolve });
    await runClaudeTurn(base(dbPath));
    assert.deepEqual(calls[0].thinking, []);
    const controller = new AbortController();
    const turn = runClaudeTurn(base(dbPath, { think: true, signal: controller.signal }));
    await held.promise;
    controller.abort();
    await assert.rejects(turn, /cancelled/);
    assert.deepEqual(calls[0].thinking, [4096, 0]);
    assert.equal(calls.length, 1);
  });
});

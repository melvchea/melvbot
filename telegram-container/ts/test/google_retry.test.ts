import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { GOOGLE_RETRY_AFTER_CAP_MS, GOOGLE_RETRY_LIMIT, googleRetryAfterMs } from "../src/google/retry.js";
import { driveFile } from "../src/note/notes_google.js";
import { googleAccessToken } from "../src/google/token.js";
import { setMelvbotEnv } from "./helpers/env.js";
import { jsonResponse, stubFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

test("a timed-out Google request carries a timeout signal, is retried, then fails", async () => {
  const dir = tempDir("google-retry-");
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const restore = setMelvbotEnv({ MELVBOT_GOOGLE_HOME: dir });
  const stub = stubFetch(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  try {
    await assert.rejects(() => driveFile("doc-1", "id"), /Google timed out.*Re-read the note \(note get\) and retry with --expect-rev/);
    assert.equal(stub.calls.length, GOOGLE_RETRY_LIMIT);
    assert.ok(stub.calls.every((call) => call.init?.signal instanceof AbortSignal));
  } finally {
    stub.restore();
    restore();
  }
});

test("a failed Google token refresh sends one Telegram alert per 6h window", async () => {
  const dir = tempDir("google-token-alert-");
  writeFileSync(
    path.join(dir, "google_token.json"),
    JSON.stringify({ token: "old", expiry_date: 1, refresh_token: "r", client_id: "c", client_secret: "s" }),
  );
  const restoreEnv = setMelvbotEnv({
    MELVBOT_GOOGLE_HOME: dir,
    MELVBOT_TS_ALLOW_LIVE_TOKEN: "1",
    MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN: "bot",
    MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID: "42",
    MELVBOT_OUTBOX_DIR: dir,
  });
  const stub = stubFetch((url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  });
  try {
    await assert.rejects(googleAccessToken(), /Google token refresh failed/);
    await assert.rejects(googleAccessToken(), /Google token refresh failed/);
    const alerts = stub.calls.filter((call) => call.url.hostname === "api.telegram.org");
    assert.equal(alerts.length, 1);
    assert.match(String(alerts[0].init?.body), /Google sign-in expired/);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

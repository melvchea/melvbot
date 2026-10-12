import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { calendarCreate, } from "../../src/google/http.js";
import { setMelvbotEnv } from "../helpers/env.js";
import { stubFetch } from "../helpers/fetch.js";
import { tempDir } from "../helpers/temp.js";

function withGoogleToken<T>(fn: () => Promise<T>): Promise<T> {
  const dir = tempDir("google-update-");
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const restore = setMelvbotEnv({ MELVBOT_GOOGLE_HOME: dir });
  return fn().finally(restore);
}

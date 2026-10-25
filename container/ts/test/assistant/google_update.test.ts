
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setMelvbotEnv } from "../helpers/env.js";
import { tempDir } from "../helpers/temp.js";

function withGoogleToken<T>(fn: () => Promise<T>): Promise<T> {
  const dir = tempDir("google-update-");
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const restore = setMelvbotEnv({ MELVBOT_GOOGLE_HOME: dir });
  return fn().finally(restore);
}

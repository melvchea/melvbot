import { writeFileSync } from "node:fs";
import path from "node:path";

import { setMelvbotEnv } from "./env.js";
import { tempDir } from "./temp.js";

/**
 * Temp Google home with a token and a melvbot.toml listing the three spreadsheets (and optional notes),
 * pointed at by MELVBOT_TOML / MELVBOT_GOOGLE_HOME. `restore` puts the env back.
 */
export function googleHome(opts: { notes?: Record<string, string>; sheetIds?: [string, string, string] } = {}): { dir: string; restore: () => void } {
  const dir = tempDir("google-home-");
  const [owner1, owner2, ev] = opts.sheetIds ?? ["m", "c", "b"];
  const notes = Object.entries(opts.notes ?? {}).map(([slug, id]) => `${slug} = "${id}"`);
  const toml = ["[sheets]", `owner1_spreadsheet_id = "${owner1}"`, `owner2_spreadsheet_id = "${owner2}"`, `ev_spreadsheet_id = "${ev}"`, "[notes]", ...notes].join("\n");
  writeFileSync(path.join(dir, "melvbot.toml"), toml);
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const restore = setMelvbotEnv({ MELVBOT_TOML: path.join(dir, "melvbot.toml"), MELVBOT_GOOGLE_HOME: dir });
  return { dir, restore };
}

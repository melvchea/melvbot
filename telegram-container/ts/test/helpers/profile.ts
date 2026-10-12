import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Points MELVBOT_CONFIG_DIR at a temp profile.toml so tests never read the real one. */
export function withProfile(text: string): void {
  const dir = mkdtempSync(path.join(tmpdir(), "melvbot-profile-"));
  writeFileSync(path.join(dir, "profile.toml"), text);
  process.env.MELVBOT_CONFIG_DIR = dir;
}

export const FIXTURE_PROFILE = 'owner1 = "Alice"\nowner2 = "Bob"\ncard1 = "CardOne"\ncard2 = "CardTwo"\n';

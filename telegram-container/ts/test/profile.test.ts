import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadPromptCatalog } from "../src/assistant/prompt_files.js";
import { applyProfile, parseProfile } from "../src/profile.js";
import { tempDir } from "./helpers/temp.js";
import { writePrompt } from "./helpers/prompts.js";

test("parseProfile reads flat quoted keys and applyProfile fills placeholders, failing on a missing key", () => {
  const profile = parseProfile('# note\nowner1 = "Alice"\ncard1 = "Gold" # trailing\n');
  assert.deepEqual(profile, { owner1: "Alice", card1: "Gold" });
  assert.equal(applyProfile("{{owner1}} {{card1}}", profile, "x.md"), "Alice Gold");
  assert.throws(() => applyProfile("{{owner2}}", profile, "x.md"), /x\.md: profile key "owner2" missing/);
});

test("loadPromptCatalog fills prompt placeholders from profile.toml in MELVBOT_CONFIG_DIR", () => {
  const config = tempDir("profile-config-");
  writeFileSync(path.join(config, "profile.toml"), 'owner1 = "Alice"\n');
  const dir = tempDir("profile-prompts-");
  writePrompt(dir, "demo", "For {{owner1}}", false, "Hi {{owner1}}");
  const previous = process.env.MELVBOT_CONFIG_DIR;
  process.env.MELVBOT_CONFIG_DIR = config;
  try {
    const [demo] = loadPromptCatalog(dir).indexed;
    assert.equal(demo?.description, "For Alice");
    assert.equal(demo?.body, "Hi Alice");
  } finally {
    if (previous === undefined) delete process.env.MELVBOT_CONFIG_DIR;
    else process.env.MELVBOT_CONFIG_DIR = previous;
  }
});

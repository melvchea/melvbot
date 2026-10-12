import assert from "node:assert/strict";
import test from "node:test";

import { assertOfferSaveAllowed, mergeSaveSection } from "../../src/assistant/tools.js";

test("an unknown slug is refused; ## Rules as a section is refused", () => {
  assert.throws(() => assertOfferSaveAllowed("no-such-note", "## Current pick", ["phone-buy"]), /unknown note slug/);
  {
    assert.throws(() => assertOfferSaveAllowed("phone-buy", "## Rules", ["phone-buy"]), /section must be one of/);
  }
});

test("mergeSaveSection appends a bullet to ## Shortlist without touching the rest; mergeSaveSection moves the previous Current pick into History when superseding", () => {
  const body = "## Shortlist\n- Pixel 9\n\n## Rules\n- keep it short\n";
  const merged = mergeSaveSection(body, "## Shortlist", "Pixel 10");
  assert.match(merged, /- Pixel 9\n- Pixel 10\n/);
  assert.match(merged, /## Rules\n- keep it short/);
  {
    const body = "## Current pick\nPixel 9\n\n## Rules\nshortlist at most 3\n";
    const merged = mergeSaveSection(body, "## Current pick", "Pixel 10");
    assert.match(merged, /## Current pick\nPixel 10\n/);
    assert.match(merged, /## History\n- \d{4}-\d{2}-\d{2} \(auto\) Picked Pixel 9 → Pixel 10/);
    assert.match(merged, /## Rules\nshortlist at most 3/);
  }
});

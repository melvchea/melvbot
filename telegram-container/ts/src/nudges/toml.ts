import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseTomlTable } from "../session/settings.js";

export const DEFAULT_MONTHLY_REVIEW_JOB_ID = "2df4193c2d83";

export type NudgesToml = {
  headroom: boolean;
  evInterval: boolean;
  spendGap: boolean;
  digestLog: boolean;
  saveOffer: boolean;
  monthlyReview: boolean;
  taskEvening: boolean;
  monthlyReviewJobId: string;
};

function tomlPath(): string {
  return (
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml")
  );
}

/** A missing [nudges] key defaults to true, so an unset toml turns every nudge on. */
function parseBoolDefaultTrue(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }
  return raw.trim().toLowerCase() !== "false";
}

export function parseNudgesSection(text: string): NudgesToml {
  const table = parseTomlTable(text, "nudges");
  return {
    headroom: parseBoolDefaultTrue(table.headroom),
    evInterval: parseBoolDefaultTrue(table.ev_interval),
    spendGap: parseBoolDefaultTrue(table.spend_gap),
    digestLog: parseBoolDefaultTrue(table.digest_log),
    saveOffer: parseBoolDefaultTrue(table.save_offer),
    monthlyReview: parseBoolDefaultTrue(table.monthly_review),
    taskEvening: parseBoolDefaultTrue(table.task_evening),
    monthlyReviewJobId: table.monthly_review_job_id?.trim() || DEFAULT_MONTHLY_REVIEW_JOB_ID,
  };
}

export function loadNudgesToml(filePath = tomlPath()): NudgesToml {
  const text = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return parseNudgesSection(text);
}

import { melvbotCli } from "../assistant/tools.js";
import { displayNames } from "../profile.js";
import { markReviewed } from "./store.js";
import {
  deleteDigestReceipt,
  getDigestReceipt,
  markNudgeDone,
  markNudgeSnoozed,
  type DigestReceipt,
} from "./store.js";
import type { NudgeButton } from "./bundle.js";

export const NUDGE_DONE_PREFIX = "nd:";
export const DIGEST_LOG_PREFIX = "lg:";
export const MONTHLY_REVIEW_PREFIX = "mr:";

export const EXPIRED_TEXT = "This button has expired";
export const ALREADY_LOGGED_TEXT = "already logged";

export type CallbackKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

export type NudgeCallbackResult = { text: string; keyboard?: CallbackKeyboard | null };

/** Handles a `nd:` callback, e.g. `nd:d|headroom:owner1|2026-09-01` for Done or `nd:s|...` for Snooze. */
export function handleNudgeDoneSnooze(data: string, dbPath?: string, now = new Date()): NudgeCallbackResult | null {
  const parts = data.split("|");
  if (parts.length !== 3) {
    return null;
  }
  const [action, key, period] = parts;
  if (action === "d") {
    markNudgeDone(key, period, now, dbPath);
    return { text: "Done." };
  }
  if (action === "s") {
    markNudgeSnoozed(key, period, now, dbPath);
    return { text: "Snoozed for 24h." };
  }
  return null;
}

export function encodeNudgeCallback(action: "d" | "s", key: string, period: string): string {
  return `${NUDGE_DONE_PREFIX}${action}|${key}|${period}`;
}

function digestCardKeyboard(code: string): CallbackKeyboard {
  const names = displayNames();
  return {
    inline_keyboard: [
      [
        { text: `${names.owner1} ${names.card1}`, callback_data: `${DIGEST_LOG_PREFIX}pick|${code}|owner1` },
        { text: `${names.owner2} ${names.card2}`, callback_data: `${DIGEST_LOG_PREFIX}pick|${code}|owner2` },
      ],
      [{ text: "Cancel", callback_data: `${DIGEST_LOG_PREFIX}cancel|${code}` }],
    ],
  };
}

export function encodeDigestLogButton(code: string): string {
  return `${DIGEST_LOG_PREFIX}show|${code}`;
}

/** One row per receipt candidate, each opening that receipt's card-choice
 * Confirm via the `show` sub-action. Used on the digest message itself. */
export function digestLogButtonsKeyboard(receipts: readonly { code: string; merchant: string; amount: string }[]): CallbackKeyboard {
  return {
    inline_keyboard: receipts.map((receipt) => [
      { text: `Log ${receipt.merchant} $${receipt.amount}`, callback_data: encodeDigestLogButton(receipt.code) },
    ]),
  };
}

function formatReceiptSummary(receipt: DigestReceipt): string {
  return `${receipt.merchant} — ${receipt.spentOn} — $${receipt.amount}`;
}

type CliRunner = (args: string[]) => Promise<{ stdout: string }>;

/** Handles a `lg:` callback: `show|<code>` opens the card-choice Confirm,
 * `pick|<code>|<card>` runs `sheet spend add`, `cancel|<code>` discards it.
 * `runCli` is injectable so tests can assert the exact argv shape without
 * shelling out to the real `melvbot` binary. */
export async function handleDigestLog(
  data: string,
  dbPath?: string,
  now = new Date(),
  runCli: CliRunner = melvbotCli,
): Promise<NudgeCallbackResult> {
  const parts = data.split("|");
  const [action, code] = parts;
  if (action === "show") {
    const receipt = getDigestReceipt(code, now, dbPath);
    if (!receipt) {
      return { text: EXPIRED_TEXT };
    }
    return { text: formatReceiptSummary(receipt), keyboard: digestCardKeyboard(code) };
  }
  if (action === "cancel") {
    deleteDigestReceipt(code, dbPath);
    return { text: "Cancelled." };
  }
  if (action === "pick") {
    const cardChoice = parts[2] ?? "";
    const receipt = getDigestReceipt(code, now, dbPath);
    if (!receipt) {
      return { text: EXPIRED_TEXT };
    }
    const owner = cardChoice === "owner1" ? "owner1" : "owner2";
    const card = cardChoice === "owner1" ? "card1" : "card2";
    try {
      // `sheet spend add` takes spentOn/merchant/amount positionally, after
      // the --owner/--card flags: `spend add --owner X --card Y <date> <merchant> <amount>`.
      const result = await runCli([
        "sheet",
        "spend",
        "add",
        "--owner",
        owner,
        "--card",
        card,
        receipt.spentOn,
        receipt.merchant,
        receipt.amount,
      ]);
      const parsed = JSON.parse(result.stdout) as { inserted?: boolean };
      deleteDigestReceipt(code, dbPath);
      return { text: parsed.inserted === false ? ALREADY_LOGGED_TEXT : "Logged." };
    } catch (error) {
      return { text: `Failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { text: EXPIRED_TEXT };
}

export function encodeMonthlyReviewCallback(key: string, period: string): string {
  const subkey = key.startsWith("monthly_review:") ? key.slice("monthly_review:".length) : key;
  return `${MONTHLY_REVIEW_PREFIX}${subkey}|${period}`;
}

/** Turns a BundleBlock's buttons into a Telegram inline keyboard, one button
 * per row, routing `monthly_review:*` keys through `mr:` and everything else
 * (headroom/ev_interval/spend_gap) through `nd:` Done/Snooze. */
export function nudgeButtonsKeyboard(buttons: readonly NudgeButton[]): CallbackKeyboard {
  return {
    inline_keyboard: buttons.map((button) => {
      const callbackData = button.key.startsWith("monthly_review:")
        ? encodeMonthlyReviewCallback(button.key, button.period)
        : encodeNudgeCallback(button.label === "Snooze" ? "s" : "d", button.key, button.period);
      return [{ text: button.label, callback_data: callbackData }];
    }),
  };
}

/** Handles an `mr:` callback: `<subkey>|<period>`, where subkey is
 * `stale` (Re-check), `house_rules` (Review) or `reviewed` (Reviewed). */
export function handleMonthlyReview(data: string, dbPath?: string, now = new Date()): NudgeCallbackResult {
  const [subkey] = data.split("|");
  if (subkey === "reviewed") {
    markReviewed("monthly_review", now, dbPath);
    return { text: "Marked reviewed." };
  }
  if (subkey === "stale" || subkey === "house_rules") {
    return { text: "Starting a turn to look into that…" };
  }
  return { text: EXPIRED_TEXT };
}

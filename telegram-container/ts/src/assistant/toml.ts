import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseTomlTable } from "../session/settings.js";

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const DEFAULT_REASONING = "low";
export const DEFAULT_IDLE_RESET_HOURS = 6;

export type Reasoning = "off" | "low" | "medium" | "high";
const REASONING_VALUES: readonly Reasoning[] = ["off", "low", "medium", "high"];

export type AssistantToml = {
  model: string;
  reasoning: Reasoning;
  idleResetHours: number;
};

function tomlPath(): string {
  return (
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml")
  );
}

function parseReasoning(raw: string | undefined): Reasoning {
  if (raw && (REASONING_VALUES as readonly string[]).includes(raw)) {
    return raw as Reasoning;
  }
  return DEFAULT_REASONING;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function parseAssistantSection(text: string): AssistantToml {
  const table = parseTomlTable(text, "assistant");
  return {
    model: table.model?.trim() || DEFAULT_MODEL,
    reasoning: parseReasoning(table.reasoning?.trim()),
    idleResetHours: parsePositiveInt(table.idle_reset_hours, DEFAULT_IDLE_RESET_HOURS),
  };
}

/** The Claude Agent SDK (Haiku 5.5, effort low) is the only conversational backend; there is
 * no `[assistant] provider` to select or validate. */
export function loadAssistantToml(filePath = tomlPath()): AssistantToml {
  const text = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return parseAssistantSection(text);
}

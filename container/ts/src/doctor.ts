import { displayNames } from "./profile.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { braveUsage, configuredProviders } from "./assistant/search_router.js";
import { BRIGHTDATA_ENV_KEY, BRIGHTDATA_ZONE_ENV_KEY } from "./assistant/providers/brightdata.js";
import { FIRECRAWL_ENV_KEY } from "./assistant/providers/firecrawl.js";
import { webQuotaLine } from "./assistant/web_quota.js";
import { kagiStatus } from "./assistant/providers/kagi_search.js";
import { loadOutlookConfig, outlookAuthPath, outlookConfigPath } from "./outlook/graph.js";
import { ALWAYS_PROMPTS_MAX_CHARS, loadPromptCatalog, promptsDir } from "./assistant/prompt_files.js";
import { buildSystemPrompt } from "./assistant/system_prompt.js";
import { conversationDbPath, idleChats } from "./assistant/conversation_store.js";
import { DEFAULT_MODEL, loadAssistantToml } from "./assistant/toml.js";
import { spendCardPolicy } from "./sheet/rules_policy.js";
import { getJob, KIND_IDLE_RESET, listCronJobs } from "./cron/store.js";
import { openNudgesDb } from "./nudges/store.js";
import { loadNudgesToml } from "./nudges/toml.js";

const REQUIRED_ALWAYS_PROMPTS = ["learn-sheets-notes", "telegram-reply-style"];

export type DoctorCheck = {
  label: string;
  status: "ok" | "error" | "warning" | "skip";
  detail?: string;
};

function tomlPath(): string {
  return (
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml")
  );
}

function checkSheets(): DoctorCheck {
  const text = existsSync(tomlPath()) ? readFileSync(tomlPath(), "utf8") : "";
  if (!text.includes("[sheets]")) {
    return { label: "sheets", status: "error", detail: "missing [sheets]" };
  }
  return { label: "sheets", status: "ok", detail: "[sheets] present" };
}

function checkNotes(): DoctorCheck {
  const text = existsSync(tomlPath()) ? readFileSync(tomlPath(), "utf8") : "";
  if (!text.includes("[notes]")) {
    return { label: "notes", status: "error", detail: "missing [notes]" };
  }
  return { label: "notes", status: "ok", detail: "[notes] present" };
}

const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const BRAVE_SEARCH_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";

function checkAssistantReasoning(): DoctorCheck {
  const { reasoning } = loadAssistantToml();
  if (reasoning === "medium" || reasoning === "high") {
    return {
      label: "assistant reasoning",
      status: "warning",
      detail: `reasoning=${reasoning} (slower and heavier on quota; low or off is faster)`,
    };
  }
  return { label: "assistant reasoning", status: "ok", detail: `reasoning=${reasoning}` };
}

function checkWebSearch(): DoctorCheck {
  const usage = braveUsage();
  const brave = process.env[BRAVE_SEARCH_API_KEY_ENV]?.trim()
    ? `brave ${usage.used}/${usage.quota} this month, pace ${Math.round(usage.pace)}${usage.exhausted ? ", exhausted" : ""}`
    : "no brave";
  const firecrawl = process.env[FIRECRAWL_ENV_KEY]?.trim() ? "firecrawl key set" : "no firecrawl";
  return { label: "web search", status: "ok", detail: `${configuredProviders().join(" → ")} (kagi ${kagiStatus()}; ${brave}; ${firecrawl})` };
}

function checkWebFetch(): DoctorCheck {
  const firecrawl = process.env[FIRECRAWL_ENV_KEY]?.trim();
  const brightdata = process.env[BRIGHTDATA_ENV_KEY]?.trim() && process.env[BRIGHTDATA_ZONE_ENV_KEY]?.trim();
  const chain = `${firecrawl ? "firecrawl" : "no firecrawl"} → ${brightdata ? "brightdata" : "no brightdata"} → in-process`;
  return { label: "web fetch", status: firecrawl || brightdata ? "ok" : "warning", detail: `${chain} (${webQuotaLine()})` };
}

/**
 * The Claude Agent SDK is the only conversational backend and runs on the
 * Claude subscription login — never an API key. A login is either
 * CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) or ~/.claude/.credentials.json.
 */
function checkAssistantProvider(): DoctorCheck {
  const credentials = path.join(process.env.HOME ?? "/home/melvbot", ".claude", ".credentials.json");
  if (!process.env[CLAUDE_OAUTH_TOKEN_ENV]?.trim() && !existsSync(credentials)) {
    return {
      label: "assistant provider",
      status: "error",
      detail: `no Claude login: set ${CLAUDE_OAUTH_TOKEN_ENV} (from \`claude setup-token\`) or log in so ${credentials} exists`,
    };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      label: "assistant provider",
      status: "warning",
      detail: "ANTHROPIC_API_KEY is set but ignored (the agent is stripped of API-key variables; subscription login only)",
    };
  }
  return { label: "assistant provider", status: "ok", detail: "provider=claude-agent-sdk (subscription login)" };
}

async function checkAssistantProviderProbe(): Promise<DoctorCheck> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const run = query({
      prompt: "ok",
      options: { model: DEFAULT_MODEL, tools: [], settingSources: [], persistSession: false, maxTurns: 1, env },
    });
    for await (const message of run) {
      if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
        throw new Error(message.subtype === "success" ? message.result : message.errors.join("; "));
      }
    }
  } catch (error) {
    return {
      label: "assistant provider probe",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { label: "assistant provider probe", status: "ok", detail: "provider=claude-agent-sdk" };
}

function checkPrompts(): DoctorCheck {
  let catalog: ReturnType<typeof loadPromptCatalog>;
  try {
    catalog = loadPromptCatalog(promptsDir());
  } catch (error) {
    return {
      label: "prompts",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const names = new Set([...catalog.always, ...catalog.indexed].map((prompt) => prompt.name));
  const missing = REQUIRED_ALWAYS_PROMPTS.filter((name) => !catalog.always.some((prompt) => prompt.name === name));
  if (missing.length > 0) {
    return { label: "prompts", status: "error", detail: `missing always prompt(s): ${missing.join(", ")}` };
  }
  if (catalog.alwaysCharsTotal > ALWAYS_PROMPTS_MAX_CHARS) {
    return {
      label: "prompts",
      status: "warning",
      detail: `always-injected prompts total ${catalog.alwaysCharsTotal} chars, over ${ALWAYS_PROMPTS_MAX_CHARS}`,
    };
  }
  return { label: "prompts", status: "ok", detail: `${names.size} prompt file(s), ${catalog.always.length} always` };
}

function checkWindowStore(): DoctorCheck {
  try {
    idleChats(0);
  } catch (error) {
    return {
      label: "assistant window store",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { label: "assistant window store", status: "ok" };
}

function checkConversationDbPermissions(): DoctorCheck {
  const dbPath = conversationDbPath();
  try {
    if (!existsSync(dbPath)) {
      return { label: "conversation db permissions", status: "ok", detail: "db not created yet" };
    }
    const mode = statSync(dbPath).mode & 0o777;
    if (mode & 0o077) {
      return {
        label: "conversation db permissions",
        status: "warning",
        detail: `${path.basename(dbPath)} mode ${mode.toString(8)} allows group/other access (expected 600)`,
      };
    }
    return { label: "conversation db permissions", status: "ok", detail: `mode ${mode.toString(8)}` };
  } catch (error) {
    return {
      label: "conversation db permissions",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkIdleResetCron(): DoctorCheck {
  try {
    const jobs = listCronJobs().filter((job) => job.kind === KIND_IDLE_RESET);
    if (jobs.length === 0) {
      return {
        label: "idle reset cron",
        status: "error",
        detail: "no idle_reset cron job in cron_jobs.db",
      };
    }
    const enabled = jobs.find((job) => job.enabled);
    if (!enabled) {
      return {
        label: "idle reset cron",
        status: "error",
        detail: `idle_reset job "${jobs[0].name}" exists but is disabled`,
      };
    }
    return { label: "idle reset cron", status: "ok", detail: `${enabled.name} (${enabled.schedule})` };
  } catch (error) {
    return {
      label: "idle reset cron",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkSystemPrompt(): Promise<DoctorCheck> {
  try {
    const { warnings } = await buildSystemPrompt();
    if (warnings.length > 0) {
      return { label: "system prompt", status: "warning", detail: warnings.join("; ") };
    }
    return { label: "system prompt", status: "ok" };
  } catch (error) {
    return {
      label: "system prompt",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function ignoreCoversMelvbotData(text: string): boolean {
  return text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === "/melvbot-data/" || line === "melvbot-data/" || line === "/melvbot-data");
}

function checkIgnoreCoverage(): DoctorCheck {
  const root =
    process.env.MELVBOT_WORKSPACE ??
    path.join(process.env.HOME ?? "/home/melvbot", "melvbot-workspace");
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return { label: "ignore coverage", status: "error", detail: `missing: ${gitignorePath}` };
  }
  if (!ignoreCoversMelvbotData(readFileSync(gitignorePath, "utf8"))) {
    return { label: "ignore coverage", status: "error", detail: `melvbot-data not excluded in: ${gitignorePath}` };
  }
  return { label: "ignore coverage", status: "ok", detail: "melvbot-data excluded from git" };
}

async function checkSheetMoneyRules(): Promise<DoctorCheck> {
  try {
    const [owner1, owner2] = await Promise.all([
      spendCardPolicy({ owner: "owner1", card: "card1" }),
      spendCardPolicy({ owner: "owner2", card: "card2" }),
    ]);
    const fallbacks: string[] = [];
    if (owner1.policySource === "fallback") {
      fallbacks.push(`${displayNames().owner1} target`);
    }
    if (owner2.policySource === "fallback") {
      fallbacks.push(`${displayNames().owner2} target/limit`);
    }
    if (fallbacks.length > 0) {
      return {
        label: "sheet money rules",
        status: "error",
        detail: `unparseable or missing in the Rules tab, using fallback: ${fallbacks.join(", ")}`,
      };
    }
    return { label: "sheet money rules", status: "ok", detail: `${displayNames().owner1} and ${displayNames().owner2} money keys read from the Sheet` };
  } catch (error) {
    return {
      label: "sheet money rules",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkNudgesToml(): DoctorCheck {
  try {
    const toml = loadNudgesToml();
    return {
      label: "nudges toml",
      status: "ok",
      detail: `monthly_review_job_id=${toml.monthlyReviewJobId}`,
    };
  } catch (error) {
    return { label: "nudges toml", status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkMonthlyReviewJobId(): DoctorCheck {
  const jobId = loadNudgesToml().monthlyReviewJobId;
  try {
    const job = getJob(jobId);
    if (!job) {
      return { label: "nudges monthly review job", status: "error", detail: `monthly_review_job_id ${jobId} not found in cron_jobs.db` };
    }
    return { label: "nudges monthly review job", status: "ok", detail: `${jobId} (${job.name})` };
  } catch (error) {
    return {
      label: "nudges monthly review job",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkNudgesDb(): DoctorCheck {
  try {
    const db = openNudgesDb();
    db.close();
    return { label: "nudges db", status: "ok", detail: "nudges.sqlite3 opens" };
  } catch (error) {
    return { label: "nudges db", status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkOutlook(): Promise<DoctorCheck[]> {
  const config = await loadOutlookConfig();
  if (config === null) {
    return [
      {
        label: "outlook oauth",
        status: "warning",
        detail: "not configured (place .outlook-mcp/config.json under MELVBOT_MICROSOFT_HOME)",
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  if (config.read_only !== true) {
    checks.push({
      label: "outlook config",
      status: "error",
      detail: "read_only must be true for mail-read-only mode",
    });
  } else {
    checks.push({ label: "outlook config", status: "ok", detail: "config.json" });
  }
  if (!existsSync(outlookAuthPath())) {
    checks.push({
      label: "outlook token",
      status: "error",
      detail: "auth_record.json missing (run outlook-mcp auth)",
    });
  } else {
    checks.push({ label: "outlook token", status: "ok", detail: "auth_record.json" });
  }
  checks.push({
    label: "outlook oauth home",
    status: "ok",
    detail: path.dirname(outlookConfigPath()),
  });
  return checks;
}

export async function runDoctor(options: { probe?: boolean } = {}): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [
    checkSheets(),
    checkNotes(),
    checkAssistantProvider(),
    checkWebSearch(),
    checkWebFetch(),
    checkAssistantReasoning(),
    checkPrompts(),
    checkWindowStore(),
    checkConversationDbPermissions(),
    checkIdleResetCron(),
    await checkSystemPrompt(),
    checkIgnoreCoverage(),
    checkNudgesToml(),
    checkMonthlyReviewJobId(),
    checkNudgesDb(),
    ...(await checkOutlook()),
  ];
  if (options.probe) {
    checks.push(await checkAssistantProviderProbe());
    // spendCardPolicy reads the live owner1/owner2 Rules tabs over the network,
    // so it runs only under --probe, keeping a plain doctor (including the
    // 3am run) network-free.
    checks.push(await checkSheetMoneyRules());
  }
  const ok = !checks.some((check) => check.status === "error");
  return { checks, ok };
}

async function main(): Promise<void> {
  const probe = process.argv.includes("--probe");
  const { checks, ok } = await runDoctor({ probe });
  for (const check of checks) {
    const detail = check.detail ? `\n  (${check.detail})` : "";
    console.log(`${check.label}: ${check.status}${detail}`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("doctor.ts") || process.argv[1]?.endsWith("doctor.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

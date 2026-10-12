import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { requestReminderRefresh } from "../reminders/ticker.js";
import { z } from "zod";

import {
  actionRequiresConfirm,
  assertConfirmableInSource,
  buildNoteAddConfirmationSummary,
  createConfirmation,
  noteAddRequiresConfirm,
  type PendingConfirmation,
} from "./confirm.js";
import {
  capNoteBodyForRead,
  findSimilarNoteSlugs,
  getNote,
  listNotes,
  replaceSectionInBody,
  replaceTextInBody,
} from "../note/notes.js";
import { parseSheetCreateArgs, sheetCreateSummary } from "../sheet/create.js";
import { previewEvAdd, previewSpendAdd } from "./soft_confirm.js";
import { loadNudgesToml } from "../nudges/toml.js";
import { loadPromptCatalog, promptsDir, readRule } from "./prompt_files.js";
import { offerDismissedRecently } from "./conversation_store.js";
import { invalidateNoteCachesForWrite } from "./system_prompt.js";
import {
  assertOfferSaveAllowed,
  buildOfferSaveSummary,
  formatWebSearchResults,
  hashOfferSavePayload,
  isSaveSection,
  melvbotCli,
  webFetchMany,
  webSearchMany,
  webSearchRead,
  WEB_SEARCH_MAX_QUERIES,
  WEB_SEARCH_READ_MAX_QUERIES,
  WEB_SEARCH_READ_MAX_PAGES,
} from "./tools.js";
import { getVideogenRuntime, startVideogenJob } from "../telegram/videogen_job.js";
import { assertWriteAllowedAfterUntrusted, isGuardedWriteAction } from "./write_guard.js";

export type TurnSource = "telegram" | "cron";

/**
 * Per-turn state shared between every custom tool call in one `query()`
 * and the code in claude_session.ts watching its message stream. The Agent SDK
 * runs these tools in-process via an SDK MCP server, so this closure is the one
 * place Melvbot intercepts tool execution — confirmation gating and the
 * untrusted-content write guard both live here.
 */
export type McpTurnState = {
  source: TurnSource;
  chatKey: string | null;
  userMessageThisTurn: string;
  untrustedContentSeen: boolean;
  offeredSaveThisTurn: boolean;
  pendingConfirmation: PendingConfirmation | null;
  /** Cron jobs whose data is prefetched (DCA): web tools refuse so the turn stays at note call + reply. */
  blockWeb: boolean;
  /** Wall time summed over every tool handler call this turn, and the call count (turn_log tool_ms / tool_calls). */
  toolMs: number;
  toolCalls: number;
  /** melvbot_cli subcommands (first two non-flag argv tokens) called this turn, in order (turn_log cli_cmds). */
  cliCmds: string[];
};

export function newMcpTurnState(
  source: TurnSource,
  chatKey: string | null,
  userMessageThisTurn: string,
  untrustedPrefetchApplied: boolean,
  blockWeb = false,
): McpTurnState {
  return {
    source,
    chatKey,
    userMessageThisTurn,
    untrustedContentSeen: untrustedPrefetchApplied,
    offeredSaveThisTurn: false,
    pendingConfirmation: null,
    blockWeb,
    toolMs: 0,
    toolCalls: 0,
    cliCmds: [],
  };
}

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

const WEB_BLOCKED_TEXT = "Web tools are off for this job: use the prefetched data and write n/a for anything missing.";

/** Refusal for web tools on a blockWeb turn, else null. */
export function webBlocked(state: McpTurnState): Promise<ToolResult> | null {
  return state.blockWeb ? Promise.resolve(textResult(WEB_BLOCKED_TEXT, true)) : null;
}

function textResult(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], isError };
}

async function guarded(fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

/** Groups whose second word is a namespace, so the action is `<group> <ns> <verb>`; other sheet subcommands (create, rename, pin) are two words. */
const SHEET_VERB_NAMESPACES = new Set(["spend", "ev", "rules"]);

function hasVerbLevel(group: string, sub: string): boolean {
  return group === "google" || (group === "sheet" && SHEET_VERB_NAMESPACES.has(sub));
}

export function cliAction(args: unknown): string | null {
  if (!Array.isArray(args) || args.length < 2 || typeof args[0] !== "string" || typeof args[1] !== "string") {
    return null;
  }
  if (hasVerbLevel(args[0], args[1]) && typeof args[2] === "string") {
    return `${args[0]} ${args[1]} ${args[2]}`;
  }
  return `${args[0]} ${args[1]}`;
}

/** Parses `note add <slug> ... --body <body> ...` positional/flag args. */
function noteAddSlugAndBody(args: readonly string[]): { slug: string; body: string } | null {
  const slug = args[2];
  const bodyIndex = args.indexOf("--body");
  const body = bodyIndex === -1 ? undefined : args[bodyIndex + 1];
  if (!slug || body === undefined) {
    return null;
  }
  return { slug, body };
}

/** After a Calendar write the reminder ticker re-fetches now, so a near-term reminder is not up to 5 min late. */
async function runMelvbotCli(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  const result = await runMelvbotCliInner(args, state);
  const argv = args.args;
  if (Array.isArray(argv)) {
    state.cliCmds.push(argv.filter((a) => typeof a === "string" && !a.startsWith("-")).slice(0, 2).join(" "));
  }
  if (!result.isError && Array.isArray(argv) && argv[0] === "google" && argv[1] === "calendar" && ["create", "update", "delete"].includes(argv[2])) {
    requestReminderRefresh();
  }
  return result;
}

/** Note writes the agent may stage (`stage: true`) so the user can reply yes instead of the agent asking in prose. */
const STAGEABLE_NOTE_WRITES = new Set(["note add", "note replace-section", "note replace-text", "note append-history"]);

export async function runMelvbotCliInner(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  const rawArgs = args.args;
  if (!Array.isArray(rawArgs) || !rawArgs.every((value) => typeof value === "string")) {
    return textResult("melvbot_cli requires arguments: { args: string[] }", true);
  }
  const argv = rawArgs as string[];
  const action = cliAction(argv);
  if (action === "note get" && argv.length === 3) {
    // Live read, not the read cache: the revision_id returned here is the one the next write must send.
    return guarded(async () => {
      const note = await getNote(argv[2]);
      return JSON.stringify({ ...note, body: capNoteBodyForRead(note.body) }, null, 2);
    });
  }
  if (action === "note list" && argv.length === 2) {
    return guarded(async () => JSON.stringify(await listNotes(), null, 2));
  }
  if (args.stage === true && action && STAGEABLE_NOTE_WRITES.has(action)) {
    return guarded(async () => {
      assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
      const text = argv.slice(3).filter((a) => !a.startsWith("--")).join(" ").replace(/\s+/g, " ");
      state.pendingConfirmation = createConfirmation(
        state.chatKey ?? "cron",
        action,
        { args: argv },
        `${action} ${argv[2] ?? ""}: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`,
      );
      return "this action needs confirmation";
    });
  }
  if (action === "note add") {
    const parsed = noteAddSlugAndBody(argv);
    if (parsed) {
      return guarded(async () => {
        assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
        let oldBody: string | null = null;
        try {
          oldBody = (await getNote(parsed.slug)).body;
        } catch {
          oldBody = null;
        }
        if (noteAddRequiresConfirm(parsed.slug, oldBody, parsed.body)) {
          let similarSlugs: string[] = [];
          if (oldBody === null) {
            try {
              const titleIndex = argv.indexOf("--title");
              const title = titleIndex === -1 ? parsed.slug : (argv[titleIndex + 1] ?? parsed.slug);
              similarSlugs = findSimilarNoteSlugs(title, parsed.slug, await listNotes());
            } catch {
              similarSlugs = [];
            }
          }
          state.pendingConfirmation = createConfirmation(
            state.chatKey ?? "cron",
            action,
            { args: argv },
            buildNoteAddConfirmationSummary(parsed.slug, oldBody, parsed.body, similarSlugs),
          );
          return "this action needs confirmation";
        }
        if (state.untrustedContentSeen) {
          assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
        }
        const result = await melvbotCli(argv, { chatKey: state.chatKey });
        invalidateNoteCachesForWrite(argv);
        return result.stdout.trim();
      });
    }
  }
  if (action === "note replace-section" && argv[2] && argv[3] && argv[4] !== undefined) {
    const [, , slug, heading, content] = argv;
    return guarded(async () => {
      assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
      const oldBody = (await getNote(slug)).body;
      const newBody = replaceSectionInBody(oldBody, heading, content, argv.includes("--bottom") ? "bottom" : "top");
      if (noteAddRequiresConfirm(slug, oldBody, newBody)) {
        state.pendingConfirmation = createConfirmation(
          state.chatKey ?? "cron",
          action,
          { args: argv },
          buildNoteAddConfirmationSummary(slug, oldBody, newBody),
        );
        return "this action needs confirmation";
      }
      if (state.untrustedContentSeen) {
        assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      }
      const result = await melvbotCli(argv, { chatKey: state.chatKey });
      invalidateNoteCachesForWrite(argv);
      return result.stdout.trim();
    });
  }
  if (action === "note replace-text" && argv[2] && argv[3] && argv[4] !== undefined) {
    const [, , slug, oldText, newText] = argv;
    return guarded(async () => {
      assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
      const oldBody = (await getNote(slug)).body;
      const newBody = replaceTextInBody(oldBody, oldText, newText);
      if (noteAddRequiresConfirm(slug, oldBody, newBody)) {
        state.pendingConfirmation = createConfirmation(
          state.chatKey ?? "cron",
          action,
          { args: argv },
          buildNoteAddConfirmationSummary(slug, oldBody, newBody),
        );
        return "this action needs confirmation";
      }
      if (state.untrustedContentSeen) {
        assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      }
      const result = await melvbotCli(argv, { chatKey: state.chatKey });
      invalidateNoteCachesForWrite(argv);
      return result.stdout.trim();
    });
  }
  if (action === "sheet spend add" && argv.includes("--void") && state.source !== "telegram") {
    return guarded(() => {
      assertConfirmableInSource("sheet spend void", "cron");
      return "";
    });
  }
  if (action === "sheet spend add" && state.source === "telegram") {
    return guarded(async () => {
      const preview = await previewSpendAdd(argv);
      if (preview?.needsConfirm) {
        state.pendingConfirmation = createConfirmation(state.chatKey ?? "cron", action, { args: argv }, preview.summary);
        return "this action needs confirmation";
      }
      if (state.untrustedContentSeen) {
        assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      }
      const result = await melvbotCli(argv, { chatKey: state.chatKey });
      return result.stdout.trim();
    });
  }
  if (action === "sheet ev add" && state.source === "telegram") {
    return guarded(async () => {
      const preview = await previewEvAdd(argv);
      if (preview?.needsConfirm) {
        state.pendingConfirmation = createConfirmation(state.chatKey ?? "cron", action, { args: argv }, preview.summary);
        return "this action needs confirmation";
      }
      if (state.untrustedContentSeen) {
        assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      }
      const result = await melvbotCli(argv, { chatKey: state.chatKey });
      return result.stdout.trim();
    });
  }
  if (action === "sheet create") {
    return guarded(() => {
      assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
      const request = parseSheetCreateArgs(argv.slice(2));
      if (!request) {
        throw new Error("usage: sheet create <title...> [--note <slug>] [--tab <name>:<col1>,<col2>,...]");
      }
      if (state.untrustedContentSeen) {
        assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      }
      state.pendingConfirmation = createConfirmation(state.chatKey ?? "cron", action, { args: argv }, sheetCreateSummary(request));
      return "this action needs confirmation";
    });
  }
  if (action && actionRequiresConfirm(action)) {
    return guarded(() => {
      assertConfirmableInSource(action, state.source === "telegram" ? "telegram" : "cron");
      state.pendingConfirmation = createConfirmation(
        state.chatKey ?? "cron",
        action,
        { args: argv },
        `Confirm: melvbot ${argv.join(" ")}?`,
      );
      return "this action needs confirmation";
    });
  }
  if (action && state.untrustedContentSeen && isGuardedWriteAction(action)) {
    return guarded(async () => {
      assertWriteAllowedAfterUntrusted(action, state.userMessageThisTurn);
      const result = await melvbotCli(argv, { chatKey: state.chatKey });
      invalidateNoteCachesForWrite(argv);
      return result.stdout.trim();
    });
  }
  return guarded(async () => {
    const result = await melvbotCli(argv, { chatKey: state.chatKey });
    invalidateNoteCachesForWrite(argv);
    if (action === "outlook inbox") {
      state.untrustedContentSeen = true;
    }
    return result.stdout.trim();
  });
}

async function runReadRule(args: ToolArgs): Promise<ToolResult> {
  const name = args.name;
  if (typeof name !== "string") {
    return textResult("read_rule requires arguments: { name: string }", true);
  }
  return guarded(() => {
    const catalog = loadPromptCatalog(promptsDir());
    return readRule(catalog, name);
  });
}

function searchQueries(args: ToolArgs): string[] {
  const queries: string[] = [];
  if (typeof args.query === "string") {
    queries.push(args.query);
  }
  if (Array.isArray(args.queries)) {
    queries.push(...args.queries.filter((q): q is string => typeof q === "string"));
  }
  return queries;
}

function callerKind(state: McpTurnState): "interactive" | "background" {
  return state.source === "telegram" && state.chatKey !== null ? "interactive" : "background";
}

async function runWebSearch(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  const queries = searchQueries(args);
  if (queries.length === 0) {
    return textResult("web_search requires arguments: { queries: string[] } (or { query: string })", true);
  }
  return guarded(async () => {
    const text = await webSearchMany(queries, callerKind(state));
    state.untrustedContentSeen = true;
    return text;
  });
}

async function runWebSearchRead(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  const queries = searchQueries(args);
  if (queries.length === 0) {
    return textResult("web_search_read requires arguments: { query: string, read?: 1-2 }", true);
  }
  return guarded(async () => {
    const text = await webSearchRead(queries, typeof args.read === "number" ? args.read : 1, callerKind(state));
    state.untrustedContentSeen = true;
    return text;
  });
}

async function runWebFetch(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  const urls: string[] = [];
  if (typeof args.url === "string") {
    urls.push(args.url);
  }
  if (Array.isArray(args.urls)) {
    urls.push(...args.urls.filter((u): u is string => typeof u === "string"));
  }
  if (urls.length === 0) {
    return textResult("web_fetch requires arguments: { urls: string[] } (or { url: string })", true);
  }
  return guarded(async () => {
    const text = await webFetchMany(urls);
    state.untrustedContentSeen = true;
    return text;
  });
}

async function runOfferSave(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  if (!loadNudgesToml().saveOffer) {
    return textResult("offer_save is turned off in [nudges]", true);
  }
  if (state.offeredSaveThisTurn) {
    return textResult("refused: only one save offer per turn", true);
  }
  const slug = args.slug;
  const section = args.section;
  const text = args.text;
  if (typeof slug !== "string" || typeof section !== "string" || typeof text !== "string" || !text.trim()) {
    return textResult("offer_save requires arguments: { slug: string, section: string, text: string }", true);
  }
  return guarded(async () => {
    if (state.untrustedContentSeen) {
      assertWriteAllowedAfterUntrusted("offer_save", state.userMessageThisTurn);
    }
    if (offerDismissedRecently(slug, section)) {
      return "refused: that save was dismissed recently";
    }
    const existing = await listNotes();
    assertOfferSaveAllowed(slug, section, existing.map((note) => note.slug));
    if (!isSaveSection(section)) {
      throw new Error(`section must be one of: ## Current pick, ## Shortlist, ## History`);
    }
    const note = await getNote(slug);
    const payloadHash = hashOfferSavePayload(slug, section, text);
    state.pendingConfirmation = createConfirmation(
      state.chatKey ?? "cron",
      "offer_save",
      { slug, section, text, payloadHash },
      buildOfferSaveSummary(slug, section, text, note.body),
    );
    state.offeredSaveThisTurn = true;
    return "posted a Save/Dismiss offer";
  });
}

async function runGenerateVideo(args: ToolArgs, state: McpTurnState): Promise<ToolResult> {
  return guarded(async () => {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }
    const chatId = Number(/^telegram:(-?\d+)$/.exec(state.chatKey ?? "")?.[1]);
    const runtime = getVideogenRuntime();
    if (!Number.isSafeInteger(chatId) || !runtime) {
      throw new Error("video generation is not available in this context");
    }
    const result = await startVideogenJob(runtime.api, chatId, prompt, runtime.generate);
    return result === "busy"
      ? "a video is already being generated for this chat; tell the user to wait for it"
      : "started; the video will be sent in 1–3 minutes";
  });
}

export const MCP_SERVER_NAME = "melvbot";
/** SDK tool names are `mcp__<server>__<tool>`; this is the allowlist handed to the agent. */
export const MCP_TOOL_NAMES = ["melvbot_cli", "read_rule", "web_search", "web_search_read", "web_fetch", "offer_save", "generate_video"].map(
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
);

const MELVBOT_CLI_DESCRIPTION =
      "Run an allowlisted melvbot CLI command and return its stdout. " +
      'To write a Note: ["note", "add", "<slug>", "--title", "<title>", "--body", "<full body text>"]. ' +
      "`note add` REPLACES the whole body — pass the complete text (existing content plus your change), " +
      "never just the new line. To rewrite or add ONE section without resending the whole Note, use " +
      '["note", "replace-section", "<slug>", "## Heading", "<section text>", "--expect-rev", "<revision_id>"] ' +
      "(add --bottom to append a missing section at the end instead of the top). To change a few lines of an EXISTING Note use " +
      '["note", "replace-text", "<slug>", "<exact old text from note get>", "<new text>", "--expect-rev", "<revision_id>"] ' +
      "(old text must occur once); never re-send the whole body with note add for a small edit. Reference prices may sit in the body; payments go to sheet spend add. Spend batches: one call takes several rows, ['sheet', 'spend', 'add', '--owner', O, '--card', C, d1, m1, a1, d2, m2, a2], and amend+add is one call with '--void', '<id>' (repeatable, Confirm tap) before the rows; 'sheet spend void' also takes several ids. For a new free-form Sheet (optionally linked from a Note) use ['sheet', 'create', '<title>', '--note', '<slug>', '--tab', '<name>:<col1>,<col2>'] (--tab repeatable). For one dated line under ## History, use " +
      '["note", "append-history", "<slug>", "<text>", "--expect-rev", "<revision_id>"] instead of replacing the body. ' +
      "On an existing Note, pass --expect-rev from note get's revision_id on note add, describe, and append-history. " +
      "Every Note write changes the revision: for a second write to the same Note in one turn, use the receipt's revisionId " +
      "from the previous write (or run note get again), never the earlier revision_id. " +
      "`house-rules`/`about-me` always need a Confirm " +
      "tap, posted automatically — no separate confirm flag. " +
      "Some actions (note add on a new or about-me/house-rules slug, note delete, sheet spend/ev void, " +
      "sheet create, sheet rules set/delete, cron add/update/enable/disable/delete, google tasks/calendar delete) always need " +
      "Confirm: call the tool NOW, this turn — the Confirm/Cancel buttons are posted automatically only when you " +
      "actually call it. Never write 'Confirm?' or describe a plan and wait; that posts no button and the user " +
      "cannot proceed. If a prior turn's tool call already returned 'this action needs confirmation', do not call " +
      "it again — the buttons are already showing. " +
      "To OFFER a Note write (\"want me to update the note?\"), call the write now with stage: true: it is posted as Confirm/Cancel " +
      "and the user can reply yes. Never offer a write in prose without staging it.";

/**
 * The agent's in-process MCP server, wrapping the allowlisted melvbot CLI /
 * rule-reading / Brave web-search / web-fetch / save-offer surface. The
 * session's built-in toolset is empty, so these are the only tools it has and
 * search never runs through any native web path.
 */
export function buildMelvbotMcpServer(stateOrGetter: McpTurnState | (() => McpTurnState)) {
  // A long-lived server passes a getter so each turn's tool calls see that turn's state.
  const current = typeof stateOrGetter === "function" ? stateOrGetter : () => stateOrGetter;
  // Per-turn tool timing: the state is read at call start so a swapped-in turn is charged correctly.
  const timed =
    <A>(run: (args: A, state: McpTurnState) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      const state = current();
      const started = Date.now();
      try {
        return await run(args, state);
      } finally {
        state.toolMs += Date.now() - started;
        state.toolCalls += 1;
      }
    };
  const webTimed =
    <A>(run: (args: A, state: McpTurnState) => Promise<ToolResult>) =>
    timed((args: A, state: McpTurnState) =>
      webBlocked(state) ?? run(args, state),
    );
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool("melvbot_cli", MELVBOT_CLI_DESCRIPTION, { args: z.array(z.string()), stage: z.boolean().optional() }, timed(runMelvbotCli)),
      tool("read_rule", "Read a prompt-file rule by name.", { name: z.string() }, timed((args: ToolArgs) => runReadRule(args))),
      tool(
        "web_search",
        "Search the public web. Use for reviews, forums, LinkedIn posts, pricing comparisons, and current facts. " +
          `Batch related searches into ONE call with \`queries\` (up to ${WEB_SEARCH_MAX_QUERIES}, run in parallel, results grouped per query) instead of sequential calls; \`query\` still works for one. ` +
          "Answer simple facts (prices, dates, yes/no, opening hours) from the result snippets; only call web_fetch when snippets are insufficient. " +
          "Open-research turns may already include a prefetched `<untrusted source=\"web_search\">` block — synthesize from that; " +
          "call again only if you need another angle.",
        { query: z.string().optional(), queries: z.array(z.string()).max(WEB_SEARCH_MAX_QUERIES).optional() },
        webTimed(runWebSearch),
      ),
      tool(
        "web_search_read",
        "Search the web and read the top result page(s) in one call: use when you would search and then web_fetch the top result. " +
          `Pass \`query\` (or \`queries\`, max ${WEB_SEARCH_READ_MAX_QUERIES}) and \`read\` (1-${WEB_SEARCH_READ_MAX_PAGES}, default 1 = pages to read). ` +
          "Returns the search results followed by `## <url>` page sections; paywalled/blocked hits are skipped for the next result. " +
          "Slower than web_search (page fetch, up to 12s): for simple facts use web_search alone.",
        { query: z.string().optional(), queries: z.array(z.string()).max(WEB_SEARCH_READ_MAX_QUERIES).optional(), read: z.number().int().min(1).max(WEB_SEARCH_READ_MAX_PAGES).optional() },
        webTimed(runWebSearchRead),
      ),
      tool(
        "web_fetch",
        "Fetch public http(s) pages and return their text. Slow (up to 12s per URL): use only when search snippets are insufficient. " +
          "Pass the 2-3 best URLs in one call via `urls` (max 3, fetched in parallel, output budget split between them); `url` still works for one page. " +
          "Paywalled/bot-hostile sites (investing.com, bloomberg.com, wsj.com, ft.com, barrons.com, seekingalpha.com) are refused and failures or timeouts are listed: use another result instead of retrying the same URL.",
        { url: z.string().optional(), urls: z.array(z.string()).max(3).optional() },
        webTimed(runWebFetch),
      ),
      tool(
        "generate_video",
        "Generate a short (6s) video from a text prompt with MiniMax. Runs in the background and returns immediately; " +
          "the finished video is sent to the chat by itself in 1–3 minutes. Use when the user asks for a video, clip or animation. " +
          "Do not wait for or describe the result.",
        { prompt: z.string() },
        timed(runGenerateVideo),
      ),
      tool(
        "offer_save",
        "Offer to save a settled pick, shortlist addition or decision to an existing Note. " +
          "Posts a Save/Dismiss button; never writes anything itself.",
        {
          slug: z.string(),
          section: z.enum(["## Current pick", "## Shortlist", "## History"]),
          text: z.string(),
        },
        timed(runOfferSave),
      ),
    ],
  });
}

# host

Host-side tooling for working on melvbot with Claude Code. `bin/` is on `PATH`. No helper uses a model; all take `-h`/`--help` and return the exit status of the command they ran.

## Helpers
- `dverify [--check|--all]`: default = typecheck plus the test files touched by the git diff (changed tests, plus tests matching or importing changed `src` files), one line on pass, first failure on fail; `--check` = plain tsc (first 40 error lines); `--all` = tsc then the full suite (counts on pass, last 60 lines on failure; CI runs the same). The only local check.
- `dbuild`: `docker compose build`, prints `build: ok` or the last 40 lines; built-in `default` buildx builder (docker driver), `COMPOSE_BAKE=true` (override `BUILDX_BUILDER`, `COMPOSE_BAKE`).
- `ddeploy [--dry-run] [--no-ci] [service ...]`: refuses unless `libexec/ci-gate` reports the GitHub CI run of HEAD as `pass` (`wait`/`fail` exit 1; push and wait for green, or `--no-ci`), and refuses when tracked files differ from HEAD (unless `--no-ci`). Then `dverify --check && dverify --all` (only with `--no-ci` or a dirty container), `dbuild`, tags the image `melvbot-ts:<short-sha>`, tags the running image `melvbot-ts:prev`, `docker compose up -d melvbot [services]`, waits up to 30 s for a stable container, runs the doctor probe filtered to non-ok lines, prints the total time. Rolls back to `prev` if the container is unstable or the probe fails; stops at the first failing step ("ddeploy: <step> failed", that step's exit code).
- `dci [--wait]`: CI runs for HEAD plus all open alerts (CodeQL via `dalerts`, Dependabot, secret scanning); exit 1 if a run failed or any alert is open; `--wait` polls up to 10 min. The `PostToolUse` hook `libexec/post-push-ci` (`.claude/settings.json`) runs `dci --wait` after every `git push`; silent for other commands. Use `dci` after a push or on any "show CI and alerts" ask; `dalerts` alone only for a quick CodeQL check.
- `dalerts`: open code-scanning (CodeQL) alerts by severity (`#n rule path:line`), exit 1 if any. CI job `code-scanning alerts` runs it after CodeQL, so any open alert turns CI and the `ddeploy` gate red. Ask a yes/no per severity before fixing (CLAUDE.md).
- `ddb <cron|nudges|conversation|path> "<sql>" | .tables | .schema <t>`: read-only SQLite (SELECT/PRAGMA/WITH), tab-separated with header.
- `dturns [days] [raw]`: the turn log (default last 80 Claude turns, 220 chars each; `raw` prints all). The last line counts `intercept:<name>` hits. Ends with a "Search & fetch" section from `docker logs` of melvbot (web_search per-route count and p50/p95 ms, web_fetch backend p50/p95, in-process fallback rate); logs rotate (10 MB x 3), so long periods may be truncated.
- `dsaved [days]`: Claude Code tokens per day and model from the transcripts, then Telegram SDK turns, tokens and no-LLM intercepts per day from `turn_log`.
  - `--outcome`: Claude Code $ per day at list prices (cache writes at the 5m rate) next to git commits that day, and $ per commit.
  - `--sessions`: top 20 sessions by est $ (subagents folded into their parent): start, assistant msgs, input / cache write / cache read / output, commits during the session (UTC start..last msg; overlapping sessions both count a commit), $/commit. `!` = over $1.5/commit or no commit; long sessions show as huge cache-read totals.
  - `--review`: `--outcome` + top 5 `--sessions`. Run first on any cost/optimisation request; act on rising $/commit or `!` sessions. Weekly: `dsaved --review 7`.
- `dprices [--force]`: scrapes the official pricing page for Opus/Sonnet/Haiku 5.5 into `prices.tsv` (plus a `haiku_long` row for Haiku prompts over 100K tokens, which `dsaved` applies per message) at most once per day (SGT); run by a `SessionStart` hook in `~/.claude/settings.json` on every `claude` launch, silent on failure (`dsaved` then keeps the last file or built-in defaults). If the page layout changes the parse fails and the file stays as is.
- Intercept miss check (weekly): `ddb conversation "select substr(created_at,1,10) d, substr(replace(prompt,char(10),' '),1,90) p from turn_log where route='claude' and prompt glob '[sSlLaAdDuU][hHiIdDeEpP]*' and created_at>=date('now','-7 day') order by id desc"`; read for show/list/add/delete/update phrasings that should have matched. Per-route hits come from `dturns`. Remove an intercept only after 30 days of zero hits.

CI (`.github/workflows/ci.yml`, default `permissions: {}`, `contents: read` per job): `container ts` (build, tests with coverage), `secret-guard` (guard + gitleaks), `workflow-lint` (zizmor), `shellcheck + hadolint` (warning level, hadolint ignores DL3008), `dependency-review` (PRs only, fails on high), `code-scanning alerts`. `weekly-scan.yml` (Sat 21:17 UTC, or `gh workflow run "Weekly scan" -R melvchea/melvbot`): Trivy fs + Dockerfile (gating). Secret-scanning generic-password and validity checks are paid, not enabled; private vulnerability reporting is a manual repo setting.

Removed (history): `digest`, `webx`, `big-output-nudge`, `coder` and its `coder-result` hook (2026-10-25; MiniMax helpers disabled 2026-10-19), `dexplore`, `offload-guard`.

## Delegation
Main session = Haiku 5.5 (high). No named sub-agent. Non-LLM first: `rg`, `sed -n`, `jq`, `git diff --stat`; edits ≤50 lines inline with no review (smallest unique Edit anchor, no full-file Write); plan and search inline; never `fork`.

Reviews for larger changes: an ad-hoc Sonnet 5.5 high agent (`Agent` `general-purpose`, `model: sonnet`, `effort: high`) reviews the posted spec before implementation and the diff after, with only the spec or diff plus callers as input. After two rejected reviews, escalate the main session to Sonnet 5.5 high or Opus 5.5 medium.

The main agent implements itself; the Haiku delegate below is only for mechanical work, heavy reading, or a main context over ~100K tokens.

Launch an ad-hoc Haiku 5.5 medium agent (`Agent` with `subagent_type: general-purpose`, `model: haiku`, `effort: medium`) only when it saves cost per completed outcome:
- the spec (goal, exact file:line ranges, verify command) costs far fewer tokens than the diff, i.e. mechanical or repeated patterns, or heavy file reading/summarising whose raw output would otherwise sit in Sonnet's context (multi-page web research, 3+ fetches);
- a 20-50 line edit with a full spec costs about the same either way, so keep it inline; a single lookup is cheaper than a cold start.
- Post the spec and get a yes first (execution gate below). Soft cap 99,999 Haiku tokens per run: one agent per small task (one file or concern, est. under ~40K); parallel only for independent work on disjoint files; reuse a warm agent via SendMessage while under budget. Ask it to end with `VERIFY: pass|fail|none` and an under-5-line report.
- Enforced by hooks in `.claude/settings.json`: `libexec/agent-gate` (PreToolUse on `Agent`) denies anything but general-purpose + haiku + medium and forces an ask; `libexec/subagent-cap` (SubagentStop) warns when a run used over 99,999 tokens. Test: `libexec/test_agent_hooks.sh`.

## Cost rules (full form of CLAUDE.md "Cost per completed outcome")
- Per MTok (API list prices, refreshed daily by `dprices` into `~/.local/state/melvbot/prices.tsv`, which `dsaved` reads; 2026-10-25): Opus 5.5 in $4, out $20, cache write $5 (5m) / $8 (1h), read $0.20; Sonnet 5.5 in $2, out $10, write $2.50 / $4, read $0.10; bot Haiku 5.5 in $0.10, out $0.50, write $0.125 / $0.20, read $0.01 (5× above 100K-token prompts). The Pro plan has no per-token price; these rates only estimate the value of its quota. MiniMax is prepaid to 2027-04-28 and now serves only the bot's image and video reading (re-compare with Haiku 5.5 at renewal).
- Redos cost most: ask first and verify before reporting done.
- Execution gate: before any edit, agent launch, deploy or commit, ask a yes/no AskUserQuestion "Are all prompts and decisions in?" (batched with open decisions); proceed only on yes; a later request reopens it. Read-only lookups need no gate.
- Output costs 5× input: no restating plans, specs or tool results, no narration between tool calls; batch edits into one turn, verify once.
- Input: `rg`/`sed -n`/`offset`+`limit`, no whole files or re-reads; long output via `tail`; batch independent calls. Docker, git push, dbuild, ddeploy run as standalone Bash calls (`git -C`, absolute paths, `env X=… cmd`, no `cd …;`/`export …;`) so sandbox excludedCommands match. Never re-run a helper to re-read output already in context.
- Cache: the MCP set stays unchanged mid-session; auto-compact at 40%; subagents start cold. Long sessions re-read the whole context every turn (see `dsaved --sessions`): `/clear` once an outcome is done.
- Auto-loaded md (CLAUDE.md, MEMORY.md) sits in every prefix: one line per rule, no duplicates or examples; details go in on-demand docs (this file, `container/docs/`), found with `rg`.
- Before re-reviewing Telegram memory, recall or prompt-cache cost, read "Reviewed, no action" in `container/docs/how-to/performance.md`.

## Claude Code wiring (`~/.claude/settings.json`, not in the repo)
- `.claude/settings.json` allows `Agent(general-purpose)`; `Explore`, `Plan`, `claude`, `statusline-setup` and `claude-code-guide` are denied so they stay out of the prompt. `effortLevel: medium`; subagents default to Haiku (`CLAUDE_CODE_SUBAGENT_MODEL`).
- Input-token settings: `MAX_THINKING_TOKENS=0`, `BASH_MAX_OUTPUT_LENGTH=5000`, `autoCompactEnabled` with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, claude.ai MCP servers off.
- `bin/statusline`: model + effort letter (L/M/H/XH/X), context %, Pro 5-hour and 7-day windows as `time left of window, unused %` (e.g. `4.2h/5h 97%l 4.1d/7d 87%l`; context is `2%u`); `Sonnet ` is shortened to `Snn`.
- Custom agents must say `model: haiku` or omit `model`.

| Role | Model |
|---|---|
| Main session | Haiku 5.5, high |
| Reviewer (spec before, diff after) | Sonnet 5.5, high |
| Ad-hoc delegate | Haiku 5.5, medium |

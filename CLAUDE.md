# melvbot

Telegram personal assistant. TypeScript daemon in `container/ts`, run as the `melvbot` Docker container.
Agent = Claude Agent SDK, Haiku 5.5 (effort low by default; effort medium per turn on `think:` or complex-prose triggers), Claude subscription login only (no API key; shares the Pro quota with the host CLI).
Routing per message: non-LLM `,commands` and prose intercepts (`src/telegram/prose_intercept.ts`) → Claude (Haiku). Media: images (vision, OCR) and video → MiniMax-M3; voice and audio files → Groq Whisper STT. Intercept rules (when to add, measure, fix, remove): `container/docs/explanation/architecture.md`. Every turn after the intercepts is logged with its prompt in `turn_log` (`melvbot turns`, host `dturns` for the weekly review).

Runtime rule files: `host/assistant/prompts/`; host helpers and hooks: `host/README.md`.

## Commands
- Verify per change in `container/ts`: `npx tsc --noEmit` + touched tests (the only local check, GitHub CI runs the full suite); build `docker compose build`
- Deploy: `ddeploy` (`--dry-run`, extra services as args); read-only SQLite `ddb` (`turn_log` is in `conversation`, date column `created_at`)

## Rules
- Never read or print `/etc/melvbot/melvbot.env` (root-only secrets; token is `CLAUDE_CODE_OAUTH_TOKEN`).
- Keep the system prompt byte-stable between turns (prompt cache); per-turn data goes in the user message.
- API-key env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) are stripped from the agent on purpose.
- Container is read-only except the HOME volume; the agent has no built-in tools, only `mcp__melvbot__*`.
- Commit straight to `main` and push when asked; end commits with the Co-Authored-By line. The repo is public and `main` blocks force-pushes: subjects are at most 4 generic words, also for squash-merged Dependabot PRs (`gh pr merge --squash --subject "Update packages"`) ("Update scripts", "Update docs", "Fix bug"), never naming a tool, file or feature.
- Cursor was removed entirely; don't reintroduce it.
- Code-rendered bot messages (cron reports, reminders) align with Daily Maintenance: first line `Title Ddd D Mon HH:MM` (Asia/Singapore, 24h, e.g. `Weekly Reminder Sat 10 Oct 07:00`), no `for`/dashes, then a blank line, then the body.
- Reminders/alerts: follow "Keep every reminder aligned" in `host/assistant/prompts/reminders.md` (one home per item, Telegram only, code-rendered fixed lists, no new jobs in taken time slots).
- Reuse first: `rg` for an existing helper or pattern before writing new code; write only what the task needs, but never cut validation, error handling or security. Review a changed or renamed field against its callers and untouched files, not just the diff.
- Tests: key tests only, no cap: add every test a necessary behaviour needs, never an unimportant one: always prevent and remove non-key tests (prune trivial/duplicate tests on every change); every fixed bug gets a regression test. Read `container/docs/how-to/dev-setup.md` before adding or changing tests.

## Model routing
- Main session = Sonnet 5.5; no named sub-agent. Non-LLM first (`rg`, `sed -n`, `jq`), edits ≤50 lines inline. Delegate to an ad-hoc Haiku 5.5 medium agent (`Agent` general-purpose, `model: haiku`, `effort: medium`) after posting the spec and getting a yes, only when it saves cost per completed outcome: spec far cheaper than the diff (mechanical/repeated patterns), or heavy reading whose raw output would bloat Sonnet's context (multi-page web research). Never `fork`. Helper scripts (`dverify`, `dbuild`, `dturns`, …) use no model; details in `host/README.md`.

## Cost per completed outcome (full form: README "Cost rules"; review `!` rows in `dsaved --sessions`)
- Batch open requests and decisions into one AskUserQuestion before any change. Before executing anything (edits, agent launch, deploy, commit), always end with a yes/no AskUserQuestion "Are all prompts and decisions in?" and act only on yes; a new request after that restarts the check. Verify (tsc + touched tests) before reporting done.
- Every question to the user (commit/push, deploy, proceed, blockers, "how to go ahead", fact checks, `!` commands, each P0/P1/P2 item) is a yes/no AskUserQuestion, never prose or bullets. That includes anything unverified or blocked by the sandbox (no GitHub access, no systemd bus, a leftover timer, a file delete or symlink the sandbox refuses): never write "run this in your terminal" or "you can ignore X" in the summary; ask "Run `! cmd` yourself?" or "Re-check from the host?" as a yes/no AskUserQuestion, never a "you'll need to…" note in the summary. Call it before the summary; the final message ends with a statement, never a question, and that includes offers like "Do you want me to…", "Should I…" or "tell me if you want…" (e.g. commit/push after a change): put them in an AskUserQuestion instead.
- Commands for the user to paste (Termius wraps lines): every line under 50 chars including the `! ` prefix, break with `\` outside quotes, build long values from short `X=...` vars, no quote or `|` spanning a break; else write a script and give a one-line call. Applies everywhere I show a command, AskUserQuestion included. Always give the suggested command in a fenced block (never inline in prose or a table), pre-broken into lines <50 chars; count before sending, final summaries too. Path `~/melvbot-storage/container/...` is too long: `cd` into it or set `D=...` first.
- Writing files (code, docs, memory notes and `MEMORY.md`, scripts): always the Edit tool first (Write for new files), never Bash redirects or heredocs, and never ask the user to run a `!` command for it; the sandbox blocks shell writes that Edit allows. Fall back to a `!` command only if Edit is denied.
- Change `.claude/settings.json` (allow/deny, hooks, env) with the Edit tool; the built-in "Do you want to make this edit to settings.json?" prompt is the yes/no, so no extra AskUserQuestion. Never use Bash to write it; if the Edit is denied, report it.
- Where possible, keep Haiku 5.5 usage (bot turns, delegated agents) below 99,990 tokens per run (soft cap; price is 5× above): split work into small tasks (one file or one concern, est. under ~40K each), one agent per task; reuse one via SendMessage only while under budget.
- Answers ≤10 lines, no recaps; narrow reads, no re-reads; one task per session, `/clear` after each outcome.
- Best-practice requests: research the latest forums/docs with web search, keep only measures practical for this single-user Telegram assistant (skip enterprise overkill, drop what is already covered), list as P0/P1/P2 with a yes/no AskUserQuestion per item.
- On any cost/optimisation request, first run `dsaved --review 7` and read trends and `!` sessions (cause and fix), then batch fixes as P0/P1/P2.
- CI/CodeQL loop after every push: show all open alerts and the CI runs with `dci` (CodeQL, Dependabot, secret scanning); fix every failure and alert (ask one yes/no AskUserQuestion per severity or issue first), push, and repeat until CI is green with 0 alerts; then `ddeploy` without asking. CI fails while any alert is open.
- When asked about optimisation, also check `turn_log` for frequent Claude prompts that could become intercepts.

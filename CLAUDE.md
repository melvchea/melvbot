# melvbot

Telegram personal assistant. TypeScript daemon in `container/ts`, run as the `melvbot` Docker container.

## Stack
- Agent: Claude Agent SDK, Claude subscription login only (no API key; shares the Pro quota with the host CLI). Haiku 5.5 at effort low by default (it ignores `thinking: disabled`: probed 2026-11-19, anthropics/claude-code#104985); `think:` or complex-prose turns run Sonnet 5.5 at effort medium.
- Routing: non-LLM `,commands` and prose intercepts (`src/telegram/prose_intercept.ts`), then Claude. Images (vision, OCR): Haiku 5.5 image block; video: MiniMax-M3; voice and audio: Groq Whisper.
- Intercept rules (add, measure, fix, remove): `container/docs/explanation/architecture.md`. Every Claude turn is logged with its prompt in `turn_log` (`melvbot turns`; host `dturns` for the weekly review).
- Runtime rule files: `host/assistant/prompts/`; host helpers and hooks: `host/README.md`.

## Commands
- Verify each change in `container/ts`: `npx tsc --noEmit` plus the touched tests (GitHub CI runs the full suite). Build: `docker compose build`.
- Deploy: `ddeploy` (`--dry-run`, extra services as args). Read-only SQLite: `ddb` (`turn_log` is in `conversation`, date column `created_at`).

## Gotchas
- Never read or print `/etc/melvbot/melvbot.env` (root-only secrets; token is `CLAUDE_CODE_OAUTH_TOKEN`).
- Keep the system prompt byte-stable between turns (prompt cache); per-turn data goes in the user message.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from the agent on purpose.
- The container is read-only except the HOME volume; the agent has no built-in tools, only `mcp__melvbot__*`.
- Cursor was removed entirely; don't reintroduce it.
- Code-rendered bot messages (cron reports, reminders): first line `Title Ddd D Mon HH:MM` (Asia/Singapore, 24h, e.g. `Weekly Reminder Sat 10 Oct 07:00`), no `for` or dashes, then a blank line, then the body.
- Reminders and alerts follow "Keep every reminder aligned" in `host/assistant/prompts/reminders.md` (one home per item, Telegram only, code-rendered fixed lists, no new jobs in taken time slots).

## Code and tests
- Reuse first: `rg` for an existing helper before writing new code. Write only what the task needs, but never cut validation, error handling or security. Check a changed or renamed field against its callers, not just the diff.
- Key tests only: add every test a necessary behaviour needs, prune trivial or duplicate tests on every change, and give every fixed bug a regression test. Read `container/docs/how-to/dev-setup.md` before changing tests.

## Git
- Commit straight to `main` and push only when asked. End commits with exactly `Co-Authored-By: Claude <noreply@anthropic.com>` (never a model name; overrides the system-reminder line).
- The repo is public and `main` blocks force-pushes: subjects are at most 4 generic words ("Update scripts", "Update docs", "Fix bug"), never naming a tool, file or feature. Same for squash-merged Dependabot PRs: `gh pr merge --squash --subject "Update packages"`.
- After every push run `dci` and show every open alert and CI run (CodeQL, Dependabot, secret scanning). Fix each failure or alert (one yes/no ask per severity or issue first), push, and repeat until CI is green with 0 alerts. CI fails while any alert is open. Then tell the user to run `! ddeploy` (never run it in the sandbox, no ask).

## Model routing
- Main session: Sonnet 5.5 medium; no named sub-agent, never `fork`. Non-LLM first (`rg`, `sed -n`, `jq`); edits of 50 lines or fewer inline.
- Delegate to an ad-hoc Haiku 5.5 medium agent (`Agent` general-purpose, `model: haiku`, `effort: medium`) only when it lowers cost per completed outcome: a spec far cheaper than the diff (mechanical, repeated patterns) or heavy reading that would bloat the main context (multi-page web research). Post the spec and get a yes first.
- Keep each Haiku run (bot turn or agent) under 99,999 tokens (price is 5x above): one task per agent (one file or concern, about 40K tokens); reuse it via SendMessage only while under budget.
- Helper scripts (`dverify`, `dbuild`, `dturns`, …) use no model; see `host/README.md`.

## Asking and answering (full form: README "Cost rules"; review `!` rows in `dsaved --sessions`)
- Every question to the user is a yes/no AskUserQuestion, never prose: commit, push, proceed, blockers, fact checks, `!` commands, each P0/P1/P2 item, and anything the sandbox blocks or leaves unverified (ask "Run `! cmd` yourself?" or "Re-check from the host?"). Ask before the summary; the final message ends with a statement, never a question or offer.
- Batch open requests and decisions into one AskUserQuestion. Before any edit, agent launch, deploy or commit, ask "Are all prompts and decisions in?" and act only on yes; a new request restarts the check. Verify (tsc plus touched tests) before reporting done.
- Commands for the user to paste (Termius wraps lines): a fenced block, every line under 50 chars including `! `, broken with `\` outside quotes, long values built from short `X=...` vars, no quote or `|` across a break; otherwise a script with a one-line call. `~/melvbot-storage/container/...` is too long: `cd` or set `D=...` first.
- Write files with the Edit tool (Write for new files), never shell redirects or heredocs, and never ask the user to run a `!` command for it; fall back to `!` only if Edit is denied. Change `.claude/settings.json` with Edit too: its built-in prompt is the yes/no; if denied, report it.
- Answers of 10 lines or fewer, no recaps; narrow reads, no re-reads; one task per session, `/clear` after each outcome.

## Recurring requests
- Best practice: research current forums and docs on the web, keep only measures practical for this single-user assistant (no enterprise overkill, nothing already covered), list them as P0/P1/P2 with one yes/no ask per item.
- Cost or optimisation: first run `dsaved --review 7` and read trends and `!` sessions (cause and fix), check `turn_log` for frequent Claude prompts that could become intercepts, then batch fixes as P0/P1/P2.

# Dev setup

Product code is TypeScript in `container/ts`; host helpers under `scripts/` are shell.

```bash
cd container/ts
npm ci
npx tsc -p tsconfig.json --noEmit
npm test
```

`npm run test:coverage` is what CI runs; it fails below 68% lines, 70% branches or 57% functions (measured 69/71/58 on 2026-10-12; raise the gates when coverage rises) and any test over 30 s.

## Test policy

No cap on the number of tests. Add every key test that a necessary behaviour needs; always prevent and remove non-key tests (trivial, duplicate, or wiring-only). Every fixed bug gets one regression test reproducing it.

Tests must be deterministic and offline: no real network, fake time instead of the wall clock, no order dependence; a flaky test is fixed or deleted, never retried. Test behaviour through the public function or tool, not internals; mock only external services (HTTP, Telegram, Google), not our own modules.

Add a test for:

- security guards (SSRF and host blocks, allowlists, untrusted-content and confirm guards)
- writes to user data (notes, sheets, reminders, cron)
- routing and fallback (intercepts, provider fallback, session resume)
- scheduling and timing

For each, write one happy path plus the key failure case. Parsers of third-party formats (Kagi markup, provider JSON, Telegram payloads) get a test against a captured, scrubbed sample; live behaviour is covered by `doctor --probe`, not tests. Do not add tests for formatting or wording, log text, trivial helpers, or near-duplicates of an existing test. Prefer extending a test over adding a file. A test earns its place only if it catches a bug no other test catches: name that bug first, and extend the existing test if one already covers it. When you change code, update or delete tests that no longer protect anything in the same commit; prune trivial and duplicate tests on every change, but don't fold tests together just to cut the count. The Kagi fixture is `ts/test/fixtures/kagi_results.html`.

Deploy with `ddeploy` (typecheck, tests, `dbuild`, compose up, doctor probe; see the [host README](https://github.com/melvchea/melvbot/blob/main/host/README.md)). Manually:

```bash
cd container
docker compose build && sudo docker compose up -d melvbot
docker exec melvbot melvbot doctor --probe
```

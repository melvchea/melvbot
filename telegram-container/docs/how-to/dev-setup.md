# Dev setup

Product code is TypeScript in `telegram-container/ts`; host helpers under `scripts/` are shell.

```bash
cd telegram-container/ts
npm ci
npx tsc -p tsconfig.json --noEmit
npm test
```

`npm run test:coverage` is what CI runs; it fails below 67% lines, 68% branches or 55% functions (measured 69/71/58 on 2026-10-12; raise the gates when coverage rises) and any test over 30 s.
### Test policy

No cap on the number of tests. Add every key test that a necessary behaviour needs; always prevent and remove non-key tests (trivial, duplicate, or wiring-only). Every fixed bug gets one regression test reproducing it.

Tests must be deterministic and offline: no real network, fake time instead of the wall clock, no order dependence; a flaky test is fixed or deleted, never retried. Test behaviour through the public function or tool, not internals; mock only external services (HTTP, Telegram, Google), not our own modules.

Add a test for:

- security guards (SSRF and host blocks, allowlists, untrusted-content and confirm guards)
- writes to user data (notes, sheets, reminders, cron)
- routing and fallback (intercepts, provider fallback, session resume)
- scheduling and timing

For each, write one happy path plus the key failure case. Parsers of third-party formats (Kagi markup, provider JSON, Telegram payloads) get a test against a captured, scrubbed sample; live behaviour is covered by `doctor --probe`, not tests. Do not add tests for formatting or wording, log text, trivial helpers, or near-duplicate cases of an existing test. Prefer extending an existing test over adding a file. A test earns its place only if it would catch a bug no other test catches. Before adding one, name that bug and check no existing test already catches it; if one does, extend it instead. When you modify code, update or delete tests whose checks no longer protect anything, in the same commit. Prune trivial and duplicate tests on every change; do not fold tests together just to reduce the count. The Kagi fixture is `ts/test/fixtures/kagi_results.html`.

Deploy with `ddeploy` (typecheck, tests, `dbuild`, compose up, doctor probe; see the [host-cli README](https://github.com/melvchea/melvbot/blob/main/host-cli/README.md)). Manually:

```bash
cd telegram-container
docker compose build && sudo docker compose up -d melvbot
docker exec melvbot melvbot doctor --probe
```

# melvbot

Telegram bridge for a Claude agent (Claude Agent SDK, Haiku 5.5, subscription login). Live product code is TypeScript in `ts/src`. The container runs `node` (`melvbot-ts:latest`); there is no Python daemon.

## Runtime

- Repo: [container/](https://github.com/melvchea/melvbot/tree/main/container) at `~/melvbot-storage/container`
- Host CLI: [host/](https://github.com/melvchea/melvbot/tree/main/host) at `~/melvbot-storage/host`
- State: `~/melvbot-workspace/melvbot-data`
- CLI: `docker exec melvbot melvbot …`
- Tests: `npm test` in `ts/` (small key-test suite; see [dev setup](docs/how-to/dev-setup.md))
- Version: `ts/package.json`

## Layout

| Path | Role |
|------|------|
| `ts/src/` | Poller, Claude Agent SDK, cron, sheet, note, Google, Outlook, doctor |
| `Dockerfile.node` | In-container Node image |
| `docker-compose.yml` | `melvbot` service |
| `scripts/` | Host maint / cron timer helpers |
| `docs/` | Diataxis docs (tutorials, how-to, reference, explanation) |

See [architecture](docs/explanation/architecture.md).

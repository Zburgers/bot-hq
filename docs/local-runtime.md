# Local Bot HQ runtime

The Node server runs on the host. Each bot runs Hermes, Chromium and a visible X11 desktop in its own Docker container. The host keeps Composio credentials, the database, and T3/Codex access policy. Containers receive only their own Hermes home, Library/profile directory, model credential and bot-specific HQ MCP token. The server requires Docker CLI access; containers receive no Docker socket.

## Razor Crest deployment

- Repository: `/home/naki/Desktop/bot-hq`.
- UI/API: `127.0.0.1:8788`; private HTTPS on port `10444`.
- Service: `systemctl --user status bot-hq.service`.
- Data: `data/bot-hq.db`, `data/engines/<botId>`, `data/computers/<botId>`.
- Private credentials: `.env`, `data/knowledge.json`, `data/runtime-secrets/`.
- Containers: `bot-hq-<botId>`; desktop ports from 18091 and gateway ports from 8660, published on loopback only.
- Container-to-host MCP callback: `10.0.20.1:8878`; this listener serves only authenticated `/mcp/<botId>` endpoints.

`COMPUTER_PROVIDER=docker` makes every bot a managed engine, including the primary contact. `HERMES_HOME_PRIMARY` is a dedicated model template in this mode; it must not point to another person's running Hermes home. The model template supplies initial provider settings, compression and memory limits. Existing profiles keep their own settings. Model changes in the Engine panel are passed to Hermes on subsequent turns.

The proxy model catalog is configured with `MODEL_CATALOG_URL` and `MODEL_CATALOG_KEY` on the host. Hermes' model endpoint must use an address reachable from its container, such as the Docker bridge gateway rather than host loopback. `.env.example` lists the local runtime settings. Never commit real credentials.

## Memory and migration

Hermes owns persistent memory (`memories/MEMORY.md`, `USER.md`), sessions and compression. The local model template enables compression with `threshold_tokens: 70000`, an absolute soft trigger that survives model changes. It is not the model's context capacity. Imported durable facts have a 12,000-character memory budget. The app reads/deletes native Hermes memory entries.

The migration handoff is sent once on the bot's first accepted Bot HQ turn. It is historical context and does not continually reinsert old facts. Old chat generations and model history remain archived; the original Grokbot UI remains available. See [migration instructions](grokbot-migration.md).

The Codex bridge provides separate read-only retrieval from approved Markdown files. It does not mount the Codex home into agents, copy authentication/session databases, or merge all memories into every prompt. See [scoped knowledge](scoped-knowledge.md) for grants and owner connection controls.

## Operations and updates

Build the dedicated image and application, preserving private data:

```sh
docker build -f desktop/base.Dockerfile -t grokbot-desktop:local .
docker build -f desktop/Dockerfile -t bot-hq-desktop:local .
npm ci
npm run typecheck
npm run build
systemctl --user restart bot-hq.service
```

The first command is only needed when the base image is absent or intentionally updated. On Razor Crest it already exists for Grokbot; avoid rebuilding that shared tag during ordinary Bot HQ updates. Hermes and its computer driver are pinned in the dedicated image. A new image takes effect when the affected bot's Engine is restarted, which recreates only its owned container. Profiles and files persist. The readiness marker prevents Hermes from loading stale config while the host refreshes it.

Install the example unit from `deploy/bot-hq.service` under `~/.config/systemd/user/`, then daemon-reload and enable it. The host Docker service must be running before managed engines can start; a transient startup failure can be retried through Engine settings. Container restart policies restore running bots after Docker restarts. The server does not operate another Hermes installation.

The side-by-side deployment sets `GROKBOT_NO_SCHEDULER=1` to prevent duplicate routines/check-ins. New chat, connected apps, computer use and T3 tools work interactively. Schedule migration is a separate cutover decision: disable old schedulers before enabling the new one. xAI voice and live X-search require an optional xAI key; ordinary chat does not.

## Rollback and limits

Use the original Grokbot address on port 10443 for rollback. Stop Bot HQ with `systemctl --user stop bot-hq.service`; managed containers are independent and continue until explicitly stopped. Stop only containers bearing both `bot-hq.managed=true` and the expected bot ID label. Retain data directories for restoration. Changes made after migration are independent in each app and are not synchronized.

Browser cookies are fresh and may need browser sign-in; existing Composio OAuth connections are reused through the preserved user identity and project key. Grant enforcement applies to the native T3/Codex bridge. Static per-bot MCP credentials identify the bot; sender-origin restrictions follow app-managed turns, and cannot prove the origin of arbitrary delayed/background engine calls. Do not treat this as a general multi-tenant security boundary. The existing host network access policy remains in force.

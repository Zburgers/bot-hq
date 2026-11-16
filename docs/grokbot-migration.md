# Migrating a local Grokbot installation

The importer creates an independent SQLite snapshot and fresh per-bot Hermes homes. The source
database is opened read-only, and SQLite's backup API includes committed WAL contents without
checkpointing or modifying the source. Run it before starting the destination server:

```sh
python3 scripts/migrate-grokbot.py \
  --source /path/to/grokbot-clone/data/grokbot.db \
  --destination /path/to/bot-hq/data/grokbot.db \
  --engines-dir /path/to/bot-hq/data/engines \
  --memory-char-limit 12000
```

Both destination paths must be new. The importer refuses existing databases or engine directories.
New files have mode 600 and new engine directories have mode 700. It prints only counts.

Users, bot IDs, standing instructions, selected models, archived conversation rows, tasks, routines,
policies and Composio router-session references are preserved. Existing bot engine assignments,
provider selections, ports and screen-handback markers are reset where those columns exist.
Tasks previously marked working become needs-input with a note asking the user to confirm whether
they remain active. Previous notes are retained. Browser sessions, pending model calls, sign-in cookies, login attempts, computers and screen leases
are cleared in the destination. The importer does not start engines or contact external services.

Use the same Composio project API key and preserved user ID to find existing connected accounts.
Their OAuth credentials live at Composio, outside this database. A router-session reference may be
reused or recreated; it is not the connection credential. Sign into HQ using the original user's
email so that the existing user record is selected.

Each visible agent receives `ENGINES_DIR/<botId>/memories/MEMORY.md` containing only active,
unexpired durable memories, with Hermes' `\n§\n` entry separator. Forgotten, superseded, expired and
temporary observation records remain archived in SQLite and are not injected into Hermes.
`MIGRATION-HANDOFF.md` contains the standing instructions, durable facts, open tasks and bounded
recent conversation excerpts for the destination prompt to load as historical context.

Configure every new home's `config.yaml` with a matching memory budget:

```yaml
memory:
  memory_enabled: true
  memory_char_limit: 12000
```

The pinned Hermes default is 2200 characters. The importer refuses over-budget exports instead of
silently dropping facts. Increasing the flag also requires increasing the Hermes configuration.

The former model history (`llm_items`) remains archived; fresh Hermes homes cannot resume those
engine calls. Bots start a new conversation generation; old rows remain archived in the copied
database and visible in the original installation. A migration
handoff gives the new engine historical context, not previous tool permissions or live state.

Library files and Chrome profiles live outside SQLite. Copy approved files separately into each
bot's dedicated volume under `/home/agent/grokbot`. Keep the old volumes and `knowledge.json` as
private archives. HQ's Hermes/MCP setup does not automatically reproduce the old per-bot Codex/T3
access rules.

## Dedicated desktop image

```sh
# Only needed on a clean machine without the existing local desktop base image:
docker build -f desktop/base.Dockerfile -t grokbot-desktop:local .
docker build -f desktop/Dockerfile -t bot-hq-desktop:local .
```

This derives a new image from `grokbot-desktop:local`; it does not replace that image. Hermes is
pinned to `e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e`, with Python 3.14 under `/opt/python` and
`/opt/hermes-venv`. The GTK helpers retain `/usr/bin/python3`. All desktop packages install during
the image build. The upstream `browser` extra does not exist at this revision; browser-harness is
a core dependency. The `mcp`, `computer-use` and `vision` extras are installed explicitly. The
minimal `sms` extra supplies `aiohttp`, which the gateway API server also requires. Installation
uses the pinned upstream lockfile and its dependency overrides.
The native `cua-driver` is downloaded from the official release and verified against the SHA-256
in the same pinned Hermes `pm/lock.json`, then selected with `HERMES_CUA_DRIVER_CMD` for every home.

Run as UID 1000 with one dedicated Hermes home mounted at the same absolute path on the host and
container. Supply `HERMES_HOME`, `BH_HOME`, `API_SERVER_PORT` and a dedicated `DESKTOP_TOKEN` at
runtime. Supply model credentials through the private home, never build arguments. Set the
Hermes API server host to `0.0.0.0` in that home's environment and restrict published host ports
to loopback. The entrypoint starts desktopd on port 8090 first, waits for the home's config,
environment and `.hq-ready` marker written last by the host, then starts its Hermes gateway.
Termination cleans up the desktop, gateway and session bus process groups. Desktop credentials
are removed from the gateway environment.

Run fixture checks without any real database or services:

```sh
python3 -m unittest discover -s tests -p '*_test.py'
bash -n desktop/entrypoint.sh
```

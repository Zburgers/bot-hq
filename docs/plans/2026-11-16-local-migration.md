# Bot HQ on Razor Crest

Keep Grokbot available at its existing address. Run Bot HQ separately with the same user and bot identities, a snapshot of the archive, existing Composio project connections, and new Hermes conversations.

## Runtime boundaries

The host runs the UI/API, SQLite database, Composio credentials and scoped knowledge bridge. Each bot gets its own Docker container running a desktop and Hermes gateway. Only that bot's Hermes home and Library are mounted. No host Docker socket or general home mount is given to agents. The original Goofy Hermes installation is unrelated and must remain untouched.

<task id="runtime" owner="desktop" tdd="true">
Implement server/src/local-runtime.ts and Docker branches in box.ts, computer.ts, desk.ts and vnc.ts. Route each screen to one container; retain the optional Orgo implementation. Verify names, ports, ownership checks, per-screen command routing, and loopback publishing with node:test.
</task>

<task id="image-migration" owner="migration" tdd="true">
Add desktop/Dockerfile and entrypoint with pinned Hermes/Python and existing local desktop service. Add a WAL-aware, non-overwriting database migration script and active-memory export. Test fixture migration for source immutability and exclusion of superseded/forgotten facts. Build the new image without changing the old image or container.
</task>

<task id="knowledge" owner="knowledge" tdd="true">
Port knowledge-policy.ts, codex-memory.ts, t3-mcp.ts and t3-pairing.ts and native tools/settings. Authenticate each bot's HQ MCP calls, retain transitive sender grant intersection, and apply approval policy before mutation calls. Verify traversal protection, device scopes and MCP token handling.
</task>

<task id="integration" owner="root" tdd="true">
Adapt env.ts, engine.ts and index.ts for managed Docker engines, an isolated seed model configuration, local model catalog and a bridge-bound MCP-only listener. Use a distinct auth cookie and preserve password sign-in. Add transitive origin metadata to bot messages. Keep Hermes native memory/compression with a 70,000-token soft cap. Verify typechecks, focused tests, build and dependency audit.
</task>

<task id="deployment" owner="root">
Snapshot the old database, copy scoped private configuration and Library files, and start a dedicated Bot HQ service on 127.0.0.1:8788 with private Tailscale HTTPS. Disable duplicate scheduled work. Check old app health, new authenticated roster/archive/Composio connections, per-bot engine health, model selection, local desktop and a bounded read-only knowledge test. Document rollback and fresh-session limits.
</task>

## Acceptance

Three named bots retain instructions, usable current facts, app connections and scoped T3/Codex capabilities. Bot HQ runs locally without Orgo or a required xAI account. Model settings show the proxy catalog. Old live app/database remain intact. The report must distinguish tested behavior from untested future operations.

# Codex knowledge and T3 connections

Bot HQ exposes the existing Codex/T3 bridge through each bot's authenticated HQ MCP endpoint. Hermes receives `search_codex_memory`, `read_codex_memory`, `list_mcp_devices`, `list_mcp_tools`, and `mcp_call` alongside the connected-app tools. No separate Composio connector is needed for these tools.

## Owner configuration

The host reads `data/knowledge.json` beside the configured database, or the file named by `GROKBOT_KNOWLEDGE_CONFIG`. Keep it mode `0600`, outside Git and outside the desktop mounts. Its format is unchanged from the customized Grokbot:

```json
{
  "sources": [{
    "id": "codex-personal",
    "label": "Codex notes",
    "root": "/home/owner/.codex/memories_v2",
    "files": ["memory_summary.md", "rollout_summaries/*.md", "extensions/ad_hoc/notes/*.md"]
  }],
  "devices": [{
    "id": "workstation",
    "label": "Workstation T3",
    "url": "https://workstation.example.ts.net/mcp"
  }],
  "grants": {
    "bot_example": {"sources": ["codex-personal"], "devices": ["workstation"]}
  }
}
```

Grant keys are the actual bot IDs in the database. New permanent bots start with no Codex or T3 grants. Hidden helpers inherit their parent's grants. Forwarded bot work and group messages intersect the recipient's grants with the original senders' grants; a broader teammate cannot supply a missing device grant on the sender's behalf. The current authority chain is persisted across application restarts.

Use **Bot settings → Memories → T3 devices** to pair an assigned device or save its separately issued MCP access token. Pairing only contacts the device URL in the owner configuration; a pasted pairing link cannot change the destination. The test button verifies authenticated tool discovery and the T3 identity tool. Tokens are write-only in the UI and never returned by bot tools. Keep T3 out of the global `EXTRA_MCP_SERVERS` setting: that bypasses this app's per-bot bridge.

## Tool behavior

| Tool | Input | Behavior |
| --- | --- | --- |
| `search_codex_memory` | `query` | Searches approved Markdown files and returns bounded, dated excerpts with relative source paths. |
| `read_codex_memory` | `source`, `path`, optional `start_line`, `line_count` | Reads at most 100 lines from an approved file. Traversal and links outside the approved source are rejected. |
| `list_mcp_devices` | none | Lists assigned devices and safe connection status. |
| `list_mcp_tools` | `device`, optional `query` | Discovers bounded tool schemas; narrow large catalogs by an exact tool name. |
| `mcp_call` | `device`, `tool`, `arguments` | Validates the remote schema, checks grants, enforces approval policy, and invokes the selected device. |

For example, discover a T3 launch schema with `list_mcp_tools({"device":"workstation","query":"t3_thread_launch"})`, then use that advertised schema in `mcp_call`. Standalone Bot HQ clients cannot use thread-bound T3 tools such as `delegate_task` or `create_threads`; use `t3_thread_launch` with `scratch:true` or an explicit project instead. Cross-environment `environmentId` arguments are rejected: select the assigned device explicitly.

A fixed set of T3 reads is allowed automatically. Other calls ask for approval unless the owner has saved an allow/block policy for `mcp:<device>:<tool>`. Approval never adds a device grant, and grants are checked again before invocation. Calls have a bounded timeout and response size; remote failures return safe diagnostics rather than raw credential-bearing payloads.

## Operational limits

Codex retrieval is read-only historical evidence; verify live state before acting on old notes. Hermes owns its own persistent memory and conversation compression separately.

Bot grants and separate desktop mounts are the durable access boundary. The app also applies the original sender's scope to its serialized Hermes turns. The static per-bot MCP token does not identify an individual engine turn, so arbitrary delayed/background requests from an independently running gateway cannot be causally attributed to an earlier turn. Do not treat this as isolation between mutually hostile prompts sharing one bot.

Run the bridge regression checks with:

```sh
node --import tsx --test tests/knowledge.test.mjs tests/t3-mcp.test.mjs tests/knowledge-api.test.mjs tests/hq-mcp-scope.test.mjs tests/permanent-bots.test.mjs
```

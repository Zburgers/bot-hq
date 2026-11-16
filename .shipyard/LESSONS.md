# Shipyard Lessons Learned

## [2026-11-16] Local Bot HQ migration

### What Went Well
- Preserving user and bot IDs with the same Composio project reused existing remote OAuth connections.
- Separate per-bot desktop/Hermes containers retained the host-owned scoped T3/Codex bridge.

### Surprises / Discoveries
- Upstream HQ_LOCAL still called Orgo for screen lifecycle and screenshots.
- Hermes' locked dependency graph has resolver overrides; uv sync --locked was needed for its Pillow/browser-harness combination.
- Hermes computer-use extras alone do not install the pinned native driver.

### Pitfalls to Avoid
- Do not reuse another operator's running Hermes home as a migration template.
- Do not start a recreated gateway before the host finishes refreshing its config; use the readiness marker.
- Do not point the new app at the old live database or run both schedulers.

### Process Improvements
- Test the native driver against the actual X11 display and accessibility bus, then verify an agent capture and VNC handshake.
- Use the same Node executable for native dependency builds and the systemd service.

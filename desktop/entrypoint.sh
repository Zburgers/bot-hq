#!/usr/bin/env bash
set -euo pipefail

desktop_pid=''
gateway_pid=''
bus_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for child in "$gateway_pid" "$desktop_pid" "$bus_pid"; do
    if [[ -n "$child" ]]; then kill -TERM -- "-$child" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# One per-container session bus connects GTK apps and the driver's accessibility tools.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/hq-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
setsid dbus-daemon --session --nofork --address="$DBUS_SESSION_BUS_ADDRESS" &
bus_pid=$!

# The desktop API must be ready while the host provisions this bot's Hermes config.
PORT=8090 setsid node /opt/desktopd/server.js &
desktop_pid=$!
: "${HERMES_HOME:?HERMES_HOME must name this bot's mounted home}"
: "${BH_HOME:?BH_HOME must name this bot's browser helper directory}"
: "${API_SERVER_PORT:?API_SERVER_PORT is required}"
while [[ ! -f "$HERMES_HOME/.hq-ready" || ! -s "$HERMES_HOME/config.yaml" || ! -s "$HERMES_HOME/.env" ]]; do
  kill -0 "$desktop_pid" 2>/dev/null || { wait "$desktop_pid"; exit 1; }
  sleep 1
done

env -u DESKTOP_TOKEN -u VNC_PASSWORD -u PORT setsid /opt/hermes-venv/bin/hermes gateway run --no-supervise &
gateway_pid=$!
set +e
wait -n "$desktop_pid" "$gateway_pid"
status=$?
set -e
exit "$status"

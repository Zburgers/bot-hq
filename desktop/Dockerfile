# Build from the repository root: docker build -f desktop/Dockerfile -t bot-hq-desktop:local .
# The existing grokbot-desktop image and container remain separate.
FROM ghcr.io/astral-sh/uv:0.11.8 AS uv
FROM grokbot-desktop:local

USER root
ARG DEBIAN_FRONTEND=noninteractive
ARG HERMES_COMMIT=e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e
LABEL org.opencontainers.image.hermes.revision=$HERMES_COMMIT
COPY --from=uv /uv /usr/local/bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
      wmctrl openssl fonts-inter xfce4-terminal thunar mousepad \
      xdg-utils dbus-x11 libglib2.0-bin at-spi2-core libatk-adaptor \
    && rm -rf /var/lib/apt/lists/*

# Pin the upstream tree; never copy host data, credentials, or Hermes homes into the image.
RUN git init /opt/hermes \
    && git -C /opt/hermes remote add origin https://github.com/NousResearch/hermes-agent.git \
    && git -C /opt/hermes fetch --depth=1 origin "$HERMES_COMMIT" \
    && git -C /opt/hermes checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/hermes rev-parse HEAD)" = "$HERMES_COMMIT"

# System python3 stays available for the GTK helpers; Hermes uses its own interpreter.
ENV UV_PYTHON_INSTALL_DIR=/opt/python
ENV UV_PROJECT_ENVIRONMENT=/opt/hermes-venv
RUN uv python install 3.14 \
    && uv venv --python 3.14 /opt/hermes-venv \
    && uv sync --project /opt/hermes --locked --no-dev \
      --extra mcp --extra computer-use --extra vision --extra sms \
    && rm -rf /root/.cache/uv /home/agent/.cache/uv \
    && /usr/bin/python3 -c "import gi; gi.require_version('Gtk','3.0'); import cairo" \
    && /opt/hermes-venv/bin/python -c 'import aiohttp, mcp, PIL' \
    && /opt/hermes-venv/bin/hermes --help >/dev/null

# The official artifact URL and checksum are owned by the pinned Hermes package lock.
# A fixed executable override lets every isolated home use this immutable installation.
RUN /opt/hermes-venv/bin/python - <<'PY'
import hashlib, json, pathlib, platform, tarfile, urllib.request
target = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64'}[platform.machine()]
lock = json.loads(pathlib.Path('/opt/hermes/pm/lock.json').read_text())
artifact = lock['packages']['cua-driver']['artifacts'][target]
archive = pathlib.Path('/tmp/cua-driver.tar.gz')
with urllib.request.urlopen(artifact['url']) as response:
    data = response.read()
assert hashlib.sha256(data).hexdigest() == artifact['sha256'], 'cua-driver checksum mismatch'
archive.write_bytes(data)
root = pathlib.Path('/opt/cua-driver')
root.mkdir()
with tarfile.open(archive) as bundle:
    bundle.extractall(root, filter='data')
binaries = list(root.rglob('cua-driver'))
assert len(binaries) == 1, 'expected exactly one official cua-driver binary'
pathlib.Path('/usr/local/bin/cua-driver').symlink_to(binaries[0])
archive.unlink()
PY
ENV HERMES_CUA_DRIVER_CMD=/usr/local/bin/cua-driver CUA_DRIVER_RS_TELEMETRY_ENABLED=0
RUN cua-driver manifest >/dev/null

COPY desktop/desktopd/server.js desktop/desktopd/package.json desktop/desktopd/package-lock.json /opt/desktopd/
COPY --chown=agent:agent server/box/ /opt/hq/
COPY desktop/entrypoint.sh /usr/local/bin/bot-hq-desktop
RUN chmod 755 /usr/local/bin/bot-hq-desktop \
    && mkdir -p /var/log/hq /opt/hq/screens /opt/hq/jobs \
      /etc/opt/chrome/policies/managed /etc/chromium/policies/managed /etc/chromium-browser/policies/managed \
    && chown -R agent:agent /home/agent /var/log/hq /opt/hq \
      /etc/opt/chrome/policies/managed /etc/chromium/policies/managed /etc/chromium-browser/policies/managed

USER agent
WORKDIR /home/agent
ENV HOME=/home/agent USER=agent DISPLAY=:99 PORT=8090
EXPOSE 8090 8650
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bot-hq-desktop"]
CMD []

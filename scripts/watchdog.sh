#!/usr/bin/env bash
# External process watchdog: the supervisor's own in-process self-reload
# (src/selfReload.ts) can itself fail to produce a replacement (observed in
# production: the shutdown sequence crashed silently, bypassing all JS-level
# error handling, with nothing left running and no external supervisor to
# notice). This script is that external supervisor — run it on a short cron
# interval. It does nothing when the process is healthy; it only acts when
# the pidfile's process is confirmed gone AND has been gone for more than
# GRACE_SECONDS, so it never races a normal, fast in-flight SIGHUP reload
# (which briefly has no live pid between the old process exiting and the new
# one writing its own pidfile).
set -euo pipefail

REPO_DIR="/home/dev/supervisor"
PIDFILE="$REPO_DIR/data/supervisor.pid"
LOG="$REPO_DIR/data/supervisor.log"
GRACE_SECONDS=30
NODE_BIN_DIR="/home/dev/.local/share/mise/installs/node/26.2.0/bin"

cd "$REPO_DIR"

if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || echo '')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0 # healthy, nothing to do
  fi
  # Process is gone. Don't race a normal reload still completing its boot —
  # only act once the pidfile has been stale for a while.
  age=$(( $(date +%s) - $(stat -c %Y "$PIDFILE") ))
  if [ "$age" -lt "$GRACE_SECONDS" ]; then
    exit 0
  fi
fi

ts="$(date -u +%H:%M:%S.000)"
echo "${ts} WARN  external watchdog: supervisor not running (pidfile pid=${pid:-none}) — restarting" >> "$LOG"

export PATH="$NODE_BIN_DIR:$PATH"
TSX_DIR="$(find "$REPO_DIR/node_modules/.pnpm" -maxdepth 1 -iname 'tsx@*' | head -1)/node_modules/tsx/dist"
nohup node \
  --require "$TSX_DIR/preflight.cjs" \
  --import "file://$TSX_DIR/loader.mjs" \
  "$REPO_DIR/src/index.ts" >> "$LOG" 2>&1 &
disown

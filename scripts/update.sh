#!/usr/bin/env bash
# gigradar local dev-update helper — NOT the real end-user auto-updater.
#
# This is a same-day dogfooding convenience for the owner's own local
# checkout: pulls the configured channel's branch, rebuilds, and restarts
# the local web server + scheduler in place. The real, future auto-update
# mechanism (a true 1-click bundled installer with its own dev/prod
# update channels, no local git checkout required) is separate, larger,
# planned work — see task #54 / the future Tauri-installer epic. This
# script assumes exactly what's already true of every dev workflow in
# this repo: a real local clone, git, and Node/npm on PATH.
#
# Channel selection: GIGRADAR_CHANNEL=dev (default) tracks the `dev`
# branch; GIGRADAR_CHANNEL=prod tracks `main`. `main` only advances on a
# real release cut (see CLAUDE.md / the project's git-dev-branch-workflow
# convention) — the "prod" channel is deliberately behind `dev` until
# that happens, which is correct, not a bug.
#
# Usage: npm run update        (uses GIGRADAR_CHANNEL, default "dev")
#        GIGRADAR_CHANNEL=prod npm run update
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${GIGRADAR_CHANNEL:-dev}"
case "$CHANNEL" in
  dev) BRANCH="dev" ;;
  prod) BRANCH="main" ;;
  *)
    echo "gigradar: unknown GIGRADAR_CHANNEL '$CHANNEL' (expected 'dev' or 'prod')" >&2
    exit 1
    ;;
esac

RUN_DIR=".run"
mkdir -p "$RUN_DIR"
WEB_LOG="$RUN_DIR/web.log"
SCHED_LOG="$RUN_DIR/scheduler.log"

echo "gigradar: updating on channel '$CHANNEL' (branch '$BRANCH')..."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "gigradar: working tree has uncommitted changes — refusing to switch/pull. Commit or stash first." >&2
  exit 1
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm ci
npm run build

stop_by_port() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "gigradar: stopping process(es) on port ${port}: ${pids}"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
}

stop_by_pattern() {
  local pattern="$1" pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "gigradar: stopping process(es) matching '${pattern}': ${pids}"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
}

echo "gigradar: stopping existing services (if running)..."
stop_by_port 3000
stop_by_pattern "tsx .*src/scheduler/index\\.ts"

echo "gigradar: starting web server..."
nohup npm run start > "$WEB_LOG" 2>&1 &
disown

echo "gigradar: starting scheduler..."
nohup npm run scheduler > "$SCHED_LOG" 2>&1 &
disown

sleep 3
if curl -s -o /dev/null -w "" "http://127.0.0.1:3000/"; then
  echo "gigradar: update complete — web server responding on http://127.0.0.1:3000/"
else
  echo "gigradar: update finished, but the web server isn't responding yet — check ${WEB_LOG}" >&2
fi
echo "gigradar: logs at ${WEB_LOG} / ${SCHED_LOG}"

#!/usr/bin/env bash
# tauri-installer epic — prepares the two things `npx tauri build`/`tauri dev`
# need that aren't already produced by `npm run build`:
#   1. binaries/node-<target-triple>  — a real, PINNED Node.js binary
#      (never "latest" — see design-discussion.md's own risk registry:
#      version drift vs. what --experimental-sqlite/node:sqlite needs).
#      Bundled via Tauri's externalBin mechanism, spawned in src-tauri's
#      Rust code with the standalone server.js as an argument — NOT
#      compiled via pkg/Node SEA (see this epic's tauri-bare-packaged-app
#      story: those tools are fragile with node:sqlite's native bindings
#      and Playwright's own native dependencies).
#   2. resources/server/  — the real `.next/standalone` output PLUS the
#      static assets `standalone` mode deliberately omits (confirmed live
#      this story: `.next/static` and `public/` are NOT auto-copied by
#      Next's own standalone build — this script does it, same as Next's
#      own documented standalone-deploy instructions).
#   3. resources/playwright-browsers/ — a real Chromium build, bundled so
#      Capture Login / browser-session sources never hit the network for a
#      first-run browser download. NOT a Tauri externalBin sidecar (Tauri
#      never invokes it directly) -- Playwright itself launches it once
#      PLAYWRIGHT_BROWSERS_PATH points here (main.rs sets this env var on
#      the Node sidecar's spawn). Live-verified this story: a bare
#      chromium.launch()/chromium.executablePath() call transparently
#      respects PLAYWRIGHT_BROWSERS_PATH with ZERO code change needed in
#      src/lib/auth/browser-session.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned Node version — bump deliberately, never silently drift.
NODE_VERSION="22.12.0"
TARGET_TRIPLE="${TAURI_TARGET_TRIPLE:-$(rustc --print host-tuple)}"

case "$TARGET_TRIPLE" in
  aarch64-apple-darwin) NODE_PLATFORM="darwin-arm64" ;;
  x86_64-apple-darwin) NODE_PLATFORM="darwin-x64" ;;
  *)
    echo "prepare-tauri-sidecars: unsupported target triple '$TARGET_TRIPLE' — this epic's first pass is macOS-only (see structured-outline.md)." >&2
    exit 1
    ;;
esac

BIN_DIR="src-tauri/binaries"
RES_DIR="src-tauri/resources/server"
NODE_DEST="$BIN_DIR/node-$TARGET_TRIPLE"

mkdir -p "$BIN_DIR" "$RES_DIR"

if [ ! -f "$NODE_DEST" ]; then
  echo "prepare-tauri-sidecars: fetching Node.js v$NODE_VERSION for $NODE_PLATFORM..."
  TMP_DIR="$(mktemp -d)"
  NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "$TMP_DIR/node.tar.gz"
  tar -xzf "$TMP_DIR/node.tar.gz" -C "$TMP_DIR"
  cp "$TMP_DIR/node-v${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$NODE_DEST"
  chmod +x "$NODE_DEST"
  rm -rf "$TMP_DIR"
  echo "prepare-tauri-sidecars: wrote $NODE_DEST"
else
  echo "prepare-tauri-sidecars: $NODE_DEST already present, skipping download."
fi

echo "prepare-tauri-sidecars: staging the standalone server bundle into $RES_DIR..."
rm -rf "$RES_DIR"
mkdir -p "$RES_DIR"
cp -r .next/standalone/. "$RES_DIR/"
mkdir -p "$RES_DIR/.next/static"
cp -r .next/static/. "$RES_DIR/.next/static/"
if [ -d public ]; then
  cp -r public "$RES_DIR/public"
fi

# runner-registry-and-sidecar-lifecycle epic: the orphan-self-detection
# preload (see that file's own header comment) -- staged here, NOT part
# of .next/standalone, since it's a repo-owned file, not Next build
# output. lib.rs resolves this exact path via resource_dir and loads it
# with NODE_OPTIONS=--require.
cp scripts/parent-liveness-guard.cjs "$RES_DIR/parent-liveness-guard.cjs"

# llm-provider-harness epic: @anthropic-ai/claude-agent-sdk's query()
# resolves its native `claude` CLI binary via a require.resolve()-style
# lookup for @anthropic-ai/claude-agent-sdk-<platform>-<arch> (an
# optionalDependency, live-verified this session by reading sdk.mjs's own
# resolution code -- see design-discussion.md's now-CONFIRMED, not just
# anticipated, open question 3) -- a DYNAMIC require Next's own
# standalone-output file tracer (@vercel/nft) can't see statically, so it
# silently drops BOTH @anthropic-ai/claude-agent-sdk itself and its native
# binary sibling from .next/standalone entirely. Found live: a real
# packaged build's claude-code-harness mode failed with "Native CLI binary
# for darwin-arm64 not found" the first time it was actually exercised in
# a real .app, not npm run dev. Same "Next's tracer missed it, copy it in
# manually" pattern as .next/static/public above.
ANTHROPIC_DIR="$RES_DIR/node_modules/@anthropic-ai"
mkdir -p "$ANTHROPIC_DIR"
if [ -d "node_modules/@anthropic-ai/claude-agent-sdk" ]; then
  cp -r "node_modules/@anthropic-ai/claude-agent-sdk" "$ANTHROPIC_DIR/"
fi
NATIVE_BINARY_PKG="claude-agent-sdk-$NODE_PLATFORM"
if [ -d "node_modules/@anthropic-ai/$NATIVE_BINARY_PKG" ]; then
  cp -r "node_modules/@anthropic-ai/$NATIVE_BINARY_PKG" "$ANTHROPIC_DIR/"
  echo "prepare-tauri-sidecars: bundled @anthropic-ai/$NATIVE_BINARY_PKG for claude-code-harness mode."
else
  echo "prepare-tauri-sidecars: WARNING -- node_modules/@anthropic-ai/$NATIVE_BINARY_PKG not found; claude-code-harness mode will fail inside this packaged build. Run 'npm install' without --omit=optional first." >&2
fi

BROWSERS_DIR="src-tauri/resources/playwright-browsers"
if [ ! -d "$BROWSERS_DIR" ] || [ -z "$(ls -A "$BROWSERS_DIR" 2>/dev/null)" ]; then
  echo "prepare-tauri-sidecars: installing Chromium into $BROWSERS_DIR..."
  mkdir -p "$BROWSERS_DIR"
  # --no-shell: browser-session.ts only ever launches headed (headless:
  # false is hardcoded there -- see that file's own header comment on why),
  # so the separate chromium-headless-shell variant Playwright installs by
  # default is dead weight in this bundle -- skipping it saves ~200MB.
  PLAYWRIGHT_BROWSERS_PATH="$(pwd)/$BROWSERS_DIR" npx playwright install chromium --no-shell
else
  echo "prepare-tauri-sidecars: $BROWSERS_DIR already populated, skipping Chromium install."
fi

echo "prepare-tauri-sidecars: done."

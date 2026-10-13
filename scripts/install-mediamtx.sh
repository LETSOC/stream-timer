#!/usr/bin/env bash
# Downloads the MediaMTX release binary into ./bin/mediamtx (gitignored).
# Usage: scripts/install-mediamtx.sh [version]   e.g. v1.21.2 (default: latest)
# Alternative on a Mac: `brew install mediamtx` (the app also finds /opt/homebrew/bin/mediamtx),
# or point MEDIAMTX_BIN at any mediamtx binary.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/bluenviron/mediamtx/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$VERSION" ] || { echo "Could not find the latest MediaMTX version; pass one, e.g. v1.21.2" >&2; exit 1; }
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Unsupported OS $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; armv7l) ARCH=armv7 ;; *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
[ "$OS" = linux ] && [ "$ARCH" = arm64 ] && ARCH=arm64
URL="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${OS}_${ARCH}.tar.gz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
curl -fL --retry 3 -o "$TMP/mtx.tar.gz" "$URL"
tar -xzf "$TMP/mtx.tar.gz" -C "$TMP" mediamtx
mkdir -p bin
mv "$TMP/mediamtx" bin/mediamtx
chmod 755 bin/mediamtx
# macOS: a downloaded binary is quarantined; clear it so it can run without a Gatekeeper prompt.
[ "$OS" = darwin ] && xattr -d com.apple.quarantine bin/mediamtx 2>/dev/null || true
echo "Installed $(bin/mediamtx --version 2>/dev/null || echo mediamtx) at $(pwd)/bin/mediamtx"

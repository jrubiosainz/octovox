#!/usr/bin/env bash
# Sets up Octovox: the speech-recognition environment and the Mona Sans font (optional).
set -euo pipefail
cd "$(dirname "$0")"

./stt/setup.sh

FONT="ui/.fonts/MonaSans.woff2"
if [ ! -s "$FONT" ]; then
  mkdir -p ui/.fonts
  URL="https://raw.githubusercontent.com/github/mona-sans/main/fonts/webfonts/variable/MonaSansVF%5Bwdth,opsz,wght%5D.woff2"
  if curl -fsSL --max-time 60 -o "$FONT.tmp" "$URL"; then
    mv "$FONT.tmp" "$FONT"
    echo "Mona Sans ready"
  else
    rm -f "$FONT.tmp"
    echo "Couldn't download Mona Sans; the panel will use the system font." >&2
  fi
fi

if ! command -v az >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/az ] && [ ! -x /usr/local/bin/az ]; then
  echo "Optional: for Azure AI Foundry voices and Interview with Microsoft Entra ID, install the Azure CLI (brew install azure-cli) and run az login."
fi

# Interview's audio helper (macOS voice processing, so GPT-Live doesn't hear itself). Same name as
# lib/duplex.mjs uses: the first 12 hex digits of the source's SHA-256.
SRC="native/duplex.swift"
BIN=".run/bin/octovox-duplex-$(shasum -a 256 "$SRC" | cut -c1-12)"
if [ ! -x "$BIN" ]; then
  if xcrun --find swiftc >/dev/null 2>&1; then
    mkdir -p .run/bin && chmod 700 .run/bin
    if xcrun swiftc -O -swift-version 5 -module-cache-path .run/swift-cache -o "$BIN.tmp" "$SRC" 2>/dev/null; then
      mv "$BIN.tmp" "$BIN"
      for old in .run/bin/octovox-duplex-*; do [ "$old" = "$BIN" ] || rm -f "$old"; done
      echo "Interview audio helper ready"
    else
      rm -f "$BIN.tmp"
      echo "Couldn't build the Interview audio helper; Octovox will try again (or use SoX) when you start an interview." >&2
    fi
  else
    echo "Optional: for Interview with echo cancellation, install Xcode's command line tools (xcode-select --install)."
  fi
fi

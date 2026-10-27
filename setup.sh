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
  echo "Optional: for Azure AI Foundry voices with Microsoft Entra ID, install the Azure CLI (brew install azure-cli) and run az login."
fi

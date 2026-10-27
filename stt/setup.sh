#!/usr/bin/env bash
# Creates stt/.venv with mlx-whisper for Octovox's local speech recognition.
# Uses the wheels in stt/.wheels when present (no network); otherwise downloads from PyPI.
set -euo pipefail
cd "$(dirname "$0")"

command -v uv >/dev/null 2>&1 || { echo "Octovox needs uv: brew install uv" >&2; exit 1; }
[ -x .venv/bin/python ] || uv venv -q --python 3.12 .venv

if compgen -G ".wheels/*.whl" >/dev/null; then
  uv pip install -q --python .venv/bin/python --offline --no-index --find-links .wheels mlx-whisper \
    || uv pip install -q --python .venv/bin/python mlx-whisper
else
  uv pip install -q --python .venv/bin/python mlx-whisper
fi

.venv/bin/python -c "import mlx_whisper; print('mlx-whisper ready')"

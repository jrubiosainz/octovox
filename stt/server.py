#!/usr/bin/env python3
"""Octovox STT: local speech-to-text server (Whisper on MLX).

Listens on 127.0.0.1 only and is shared by every Copilot session. Keeps the model loaded while
it's being used and unloads it after a while without use.

Usage:
  server.py [--port 18766] [--model PATH_OR_REPO] [--preload]
  server.py --transcribe audio.wav [--language auto|en|es|…]
"""
from __future__ import annotations

import argparse
import gc
import io
import json
import os
import re
import sys
import threading
import time
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

DEFAULT_PORT = 18766
SAMPLE_RATE = 16000
LOCAL_MODEL = os.path.expanduser("~/Library/Application Support/PodcastStudio/models/whisper-large-v3-turbo")
HUB_MODEL = "mlx-community/whisper-large-v3-turbo"
GLOSSARY = "Copilot, GitHub, Octovox, commit, push, pull request, merge, deploy, Azure, Foundry."
SUPPORTED = ("en", "es", "it", "de", "fr", "pt", "nl", "pl")
MAX_AUDIO_SECONDS = 180
# Phrases Whisper tends to invent over silence or noise.
HALLUCINATIONS = {
    "gracias",
    "gracias por ver",
    "gracias por ver el video",
    "muchas gracias",
    "subtitulos realizados por la comunidad de amara org",
    "subtitulos por la comunidad de amara org",
    "suscribete",
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "you",
    "bye",
    "grazie",
    "grazie per la visione",
    "sottotitoli creati dalla comunita amara org",
    "vielen dank",
    "untertitel der amara org community",
    "untertitel im auftrag des zdf",
    "merci",
    "sous titres realises par la communaute d amara org",
    "obrigado",
    "legendas pela comunidade amara org",
    "bedankt",
    "ondertitels ingediend door de amara org gemeenschap",
    "dziekuje",
    "napisy stworzone przez spolecznosc amara org",
}


def pick_model(explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("OCTOVOX_STT_MODEL")
    if env:
        return env
    for name in ("weights.safetensors", "weights.npz"):
        if os.path.isfile(os.path.join(LOCAL_MODEL, name)):
            return LOCAL_MODEL
    return HUB_MODEL


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower().replace("ł", "l"))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def decode_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("Expected 16-bit PCM audio")
        channels = wav.getnchannels()
        rate = wav.getframerate()
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm[: len(pcm) // channels * channels].reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and len(pcm):
        count = int(round(len(pcm) * SAMPLE_RATE / rate))
        pcm = np.interp(np.linspace(0, len(pcm) - 1, count), np.arange(len(pcm)), pcm).astype(np.float32)
    if len(pcm) > SAMPLE_RATE * MAX_AUDIO_SECONDS:
        raise ValueError(f"Audio longer than {MAX_AUDIO_SECONDS} s")
    return pcm


class Engine:
    def __init__(self, model: str, idle_seconds: int, exit_after: int):
        self.model = model
        self.idle_seconds = idle_seconds
        self.exit_after = exit_after
        self.lock = threading.Lock()
        self.loaded = False
        self.last_used = time.monotonic()
        threading.Thread(target=self._reaper, daemon=True).start()

    def load(self) -> None:
        with self.lock:
            self._load()

    def unload(self) -> None:
        with self.lock:
            self._unload()

    def _load(self):
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder

        started = time.monotonic()
        model = ModelHolder.get_model(self.model, mx.float16)
        if not self.loaded:
            self.loaded = True
            log(f"model loaded in {time.monotonic() - started:.1f}s: {self.model}")
        self.last_used = time.monotonic()
        return model

    def _unload(self) -> None:
        if not self.loaded:
            return
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder

        ModelHolder.model = None
        ModelHolder.model_path = None
        gc.collect()
        clear = getattr(mx, "clear_cache", None) or mx.metal.clear_cache
        clear()
        self.loaded = False
        log("model unloaded after inactivity")

    def _reaper(self) -> None:
        while True:
            time.sleep(15)
            idle = time.monotonic() - self.last_used
            if self.loaded and idle > self.idle_seconds:
                with self.lock:
                    if time.monotonic() - self.last_used > self.idle_seconds:
                        self._unload()
            if self.exit_after and not self.loaded and idle > self.exit_after:
                log("unused; shutting down")
                os._exit(0)

    def _best_language(self, model, audio: np.ndarray, allowed: tuple[str, ...]) -> tuple[str, dict]:
        """Most likely language among the allowed ones (Whisper alone confuses es/gl/ca/pt)."""
        import mlx.core as mx
        from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim

        mel = log_mel_spectrogram(audio, n_mels=model.dims.n_mels, padding=N_SAMPLES)
        segment = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
        _, probs = model.detect_language(segment)
        if isinstance(probs, list):
            probs = probs[0]
        pool = {code: float(p) for code, p in probs.items() if code in allowed} or {k: float(v) for k, v in probs.items()}
        best = max(pool, key=pool.get)
        top = dict(sorted(pool.items(), key=lambda item: -item[1])[:3])
        return best, {code: round(p, 3) for code, p in top.items()}

    def transcribe(self, audio: np.ndarray, language: str | None, glossary: bool, allowed: tuple[str, ...] = SUPPORTED) -> dict:
        import mlx_whisper

        language = None if language in (None, "", "auto") else language
        with self.lock:
            model = self._load()
            started = time.monotonic()
            scores = None
            if language is None and allowed:
                language, scores = self._best_language(model, audio, allowed)
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=self.model,
                language=language,
                condition_on_previous_text=False,
                temperature=(0.0, 0.2, 0.4),
                initial_prompt=GLOSSARY if glossary else None,
                verbose=None,
            )
            elapsed = time.monotonic() - started
            self.last_used = time.monotonic()
        segments = [
            s
            for s in result.get("segments", [])
            if not (s.get("no_speech_prob", 0) > 0.6 and s.get("avg_logprob", 0) < -0.8)
        ]
        text = " ".join(s.get("text", "").strip() for s in segments).strip()
        if normalize(text) in HALLUCINATIONS or normalize(text) == normalize(GLOSSARY):
            text = ""
        return {
            "text": text,
            "language": result.get("language") or language,
            "scores": scores,
            "duration": round(len(audio) / SAMPLE_RATE, 2),
            "elapsed_ms": int(elapsed * 1000),
        }


ENGINE: Engine | None = None


def log(message: str) -> None:
    sys.stderr.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} octovox-stt[{os.getpid()}] {message}\n")
    sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    server_version = "OctovoxSTT/2"

    def log_message(self, fmt, *args):  # noqa: N802 - BaseHTTPRequestHandler API
        pass

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def do_GET(self):  # noqa: N802
        if not self._host_ok():
            return self._json(421, {"error": "host not allowed"})
        if urlparse(self.path).path == "/health":
            return self._json(
                200,
                {"ok": True, "service": "octovox-stt", "version": 2, "model": ENGINE.model, "loaded": ENGINE.loaded, "pid": os.getpid()},
            )
        return self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._host_ok():
            return self._json(421, {"error": "host not allowed"})
        # Custom header: forces a CORS preflight we never grant.
        if self.headers.get("X-Octovox") != "1":
            return self._json(403, {"error": "missing X-Octovox"})
        url = urlparse(self.path)
        query = parse_qs(url.query)
        length = int(self.headers.get("Content-Length") or 0)
        if length > SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS + 4096:
            return self._json(413, {"error": "audio too long"})
        body = self.rfile.read(length) if length else b""
        try:
            if url.path == "/warmup":
                ENGINE.load()
                return self._json(200, {"ok": True, "loaded": True, "model": ENGINE.model})
            if url.path == "/unload":
                ENGINE.unload()
                return self._json(200, {"ok": True, "loaded": False})
            if url.path == "/transcribe":
                language = (query.get("language") or ["auto"])[0]
                if not re.fullmatch(r"auto|[a-z]{2}", language):
                    return self._json(400, {"error": "invalid language"})
                glossary = (query.get("glossary") or ["1"])[0] != "0"
                allowed = tuple(
                    code for code in (query.get("allowed") or [",".join(SUPPORTED)])[0].split(",") if re.fullmatch(r"[a-z]{2}", code)
                )
                return self._json(200, ENGINE.transcribe(decode_wav(body), language, glossary, allowed))
        except ValueError as error:
            return self._json(400, {"error": str(error)})
        except Exception as error:  # pragma: no cover - model errors
            log(f"error: {error!r}")
            return self._json(500, {"error": str(error)})
        return self._json(404, {"error": "not found"})


def main() -> int:
    global ENGINE
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=int(os.environ.get("OCTOVOX_STT_PORT", DEFAULT_PORT)))
    parser.add_argument("--model")
    parser.add_argument("--idle", type=int, default=900, help="seconds without use before unloading the model")
    parser.add_argument("--exit-after", type=int, default=3600, help="seconds without use before exiting (0 = never)")
    parser.add_argument("--preload", action="store_true", help="load the model at startup")
    parser.add_argument("--transcribe", metavar="WAV", help="transcribe one file and exit")
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()

    ENGINE = Engine(pick_model(args.model), args.idle, args.exit_after)
    if args.transcribe:
        with open(args.transcribe, "rb") as handle:
            print(json.dumps(ENGINE.transcribe(decode_wav(handle.read()), args.language, True), ensure_ascii=False))
        return 0

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        log(f"can't listen on {args.port}: {error}")
        return 1
    log(f"listening on http://127.0.0.1:{args.port} with {ENGINE.model}")
    if args.preload:
        threading.Thread(target=ENGINE.load, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

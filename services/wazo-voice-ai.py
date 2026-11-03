#!/usr/bin/env python3
"""Service vocal au protocole du plugin wazo-stt de sboily.

Le plugin se connecte, envoie un JSON `{"type":"config",…}`, puis des trames
binaires d'audio, puis `EOF`. Ce service transcrit l'audio accumulé et renvoie
`{"type":"transcription","text":…}`.

Variables d'environnement :
  VOICE_AI_PORT  port d'écoute (défaut 8766)
  ASR_URL        service de reconnaissance (défaut http://127.0.0.1:9030)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request

import websockets

PORT = int(os.environ.get("VOICE_AI_PORT", "8766"))
ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:9030")


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def transcribe(pcm: bytes) -> str:
    """Envoie le PCM au service de reconnaissance et renvoie le texte."""
    request = urllib.request.Request(
        ASR_URL, data=pcm, headers={"content-type": "application/octet-stream"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return (payload.get("text") or "").strip()


async def handle(ws) -> None:
    path = getattr(ws, "request", None)
    log("connexion du plugin")
    buffer = bytearray()
    try:
        async for message in ws:
            if isinstance(message, bytes):
                if message == b"EOF":
                    text = ""
                    if buffer:
                        try:
                            text = await asyncio.to_thread(transcribe, bytes(buffer))
                        except Exception as error:  # une panne d'ASR ne coupe pas l'appel
                            log("ASR en échec:", type(error).__name__, str(error)[:120])
                            await ws.send(json.dumps({"type": "error", "message": str(error)[:120]}))
                    log("transcription:", text or "(vide)", "|", len(buffer), "octets")
                    await ws.send(json.dumps({"type": "transcription", "text": text}))
                    buffer.clear()
                else:
                    buffer.extend(message)
            else:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "config":
                    log("config reçue:", {k: data.get(k) for k in ("sample_rate", "format", "language")})
    except websockets.exceptions.ConnectionClosed:
        log("connexion fermée")
    finally:
        if buffer:
            log("reste non transcrit:", len(buffer), "octets")


async def main() -> None:
    async with websockets.serve(handle, "0.0.0.0", PORT, max_size=None):
        log(f"service vocal à l'écoute sur ws://0.0.0.0:{PORT} → ASR {ASR_URL}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

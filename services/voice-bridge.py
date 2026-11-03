#!/usr/bin/env python3
"""Pont vocal autonome : Wazo <-> harnais, sans AVA.

Écoute AudioSocket sur 8092, découpe la parole par détection d'énergie, fait
transcrire par le service ASR local, interroge le harnais, puis synthétise avec
la voix système de macOS (say + afconvert). Bibliothèque standard uniquement.
"""
from __future__ import annotations

import array
import asyncio
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request

PORT = int(os.environ.get("BRIDGE_PORT", "8092"))
ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:9030")
HARNESS_URL = os.environ.get("HARNESS_URL", "http://127.0.0.1:9031/v1")
VOICE = os.environ.get("BRIDGE_VOICE", "Amelie")
PROMPT = (
    "Tu es un assistant vocal au téléphone. Réponds en français, en une ou deux "
    "phrases courtes, sans markdown ni liste."
)
FRAME = 320
SILENCE_RMS = 450
END_SILENCE = 0.60
MIN_SPEECH = 0.30


def log(*args: object) -> None:
    import time
    print(time.strftime("%H:%M:%S"), *args, file=sys.stderr, flush=True)


def transcribe(pcm: bytes) -> str:
    request = urllib.request.Request(ASR_URL, data=pcm, headers={"content-type": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return (json.load(response).get("text") or "").strip()


def ask_harness(text: str) -> str:
    body = json.dumps({"model": "deepseek-flash", "messages": [
        {"role": "system", "content": PROMPT},
        {"role": "user", "content": text}]}).encode()
    request = urllib.request.Request(
        f"{HARNESS_URL}/chat/completions", data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
        return (payload["choices"][0]["message"]["content"] or "").strip()
    except Exception as error:
        log("harnais injoignable:", type(error).__name__, str(error)[:100])
        return "Je n'arrive pas à joindre le harnais."


def synthesize(text: str) -> bytes:
    with tempfile.TemporaryDirectory() as folder:
        aiff, wav = f"{folder}/voix.aiff", f"{folder}/voix.wav"
        subprocess.run(["say", "-v", VOICE, "-o", aiff, text], check=True, timeout=120)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@8000", "-c", "1", aiff, wav],
                       check=True, timeout=60)
        with open(wav, "rb") as handle:
            data = handle.read()
    marker = data.find(b"data")
    return data[marker + 8:] if marker >= 0 else data[44:]


class Call:
    def __init__(self, reader, writer) -> None:
        self.reader, self.writer = reader, writer
        self.utterance = bytearray()
        self.silence = 0.0
        self.speaking = False
        self.busy = False
        self.frames = 0
        self.peak = 0.0

    async def write_audio(self, pcm: bytes) -> None:
        for offset in range(0, len(pcm), FRAME):
            chunk = pcm[offset:offset + FRAME]
            if not chunk:
                continue
            if len(chunk) < FRAME:
                chunk = chunk + b"\x00" * (FRAME - len(chunk))
            try:
                self.writer.write(b"\x10" + struct.pack("!H", len(chunk)) + chunk)
                await self.writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                return
            await asyncio.sleep(0.02)

    async def answer(self) -> None:
        if self.busy or not self.utterance:
            return
        self.busy = True
        pcm, self.utterance = bytes(self.utterance), bytearray()
        try:
            text = await asyncio.to_thread(transcribe, pcm)
            log("transcription:", text or "(vide)")
            if not text:
                return
            reply = await asyncio.to_thread(ask_harness, text)
            log("réponse:", reply[:120])
            if reply:
                pcm = await asyncio.to_thread(synthesize, reply)
                log("audio envoyé:", len(pcm), "octets")
                await self.write_audio(pcm)
        except Exception as error:
            log("erreur de tour:", type(error).__name__, str(error)[:120])
        finally:
            self.busy = False

    async def run(self) -> None:
        header = await self.reader.readexactly(3)
        kind, length = header[0], struct.unpack("!H", header[1:])[0]
        if kind != 0x01 or length != 16:
            log("en-tête AudioSocket inattendu:", kind, length)
            return
        await self.reader.readexactly(16)
        log("appel entrant")
        # Pas d'accueil joué à la connexion : le canal AudioSocket s'ouvre dès
        # l'Answer() du dialplan, avant que l'appelé ait décroché. Tout audio
        # envoyé à cet instant est perdu. On répond donc au premier tour de parole.
        log("prêt (pas d'accueil : le canal s'ouvre avant le décroché)")
        while True:
            head = await self.reader.readexactly(3)
            kind, length = head[0], struct.unpack("!H", head[1:])[0]
            if kind not in (0x00, 0x10):
                log("en-tête inattendu:", hex(kind), "longueur", length)
            if kind == 0x00:
                log("raccroché")
                return
            if kind != 0x10 or not length:
                continue
            audio = await self.reader.readexactly(length)
            samples = array.array("h", audio[: len(audio) // 2 * 2])
            energy = math.sqrt(sum(s * s for s in samples) / max(1, len(samples)))
            self.frames += 1
            self.peak = max(self.peak, energy)
            if self.frames % 250 == 0:  # toutes les 5 s environ
                log(f"trames={self.frames} énergie_max={self.peak:.0f} parole={'oui' if self.speaking else 'non'}")
                self.peak = 0.0
            if energy >= SILENCE_RMS:
                self.speaking = True
                self.silence = 0.0
                self.utterance.extend(audio)
            elif self.speaking:
                self.silence += length / 16000.0
                self.utterance.extend(audio)
                if self.silence >= END_SILENCE:
                    self.speaking = False
                    if len(self.utterance) / 16000.0 >= MIN_SPEECH:
                        asyncio.create_task(self.answer())
                    self.utterance.clear()


async def handle(reader, writer) -> None:
    call = Call(reader, writer)
    try:
        await call.run()
    except (asyncio.IncompleteReadError, ConnectionResetError):
        log("connexion fermée")
    except Exception as error:
        log("erreur:", type(error).__name__, str(error)[:140])
    finally:
        writer.close()


async def main() -> None:
    server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    log(f"pont vocal autonome sur 0.0.0.0:{PORT} · ASR {ASR_URL} · voix {VOICE}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

"""French telephone ASR service: 8 kHz slin PCM in, transcript out, MLX Whisper on Metal."""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx_whisper
import numpy as np
from scipy.signal import resample_poly

MODEL = "mlx-community/whisper-large-v3-turbo"
PORT = 9030


def transcribe(pcm: bytes) -> dict:
    """Resample one 8 kHz mono slin16 utterance and recognize it."""
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size == 0:
        return {"text": "", "seconds": 0.0, "audioSeconds": 0.0}
    wide = resample_poly(samples, 2, 1).astype(np.float32)
    started = time.perf_counter()
    result = mlx_whisper.transcribe(wide, path_or_hf_repo=MODEL, language="fr", task="transcribe", condition_on_previous_text=False)
    return {
        "text": result["text"].strip(),
        "seconds": round(time.perf_counter() - started, 3),
        "audioSeconds": round(samples.size / 8000, 2),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server API
        body = json.dumps({"ready": True, "model": MODEL}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("content-length", "0"))
        pcm = self.rfile.read(length)
        try:
            payload = transcribe(pcm)
            status = 200
        except Exception as error:  # noqa: BLE001 - report any decode failure to the caller
            payload = {"error": str(error)}
            status = 500
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"loading {MODEL}", flush=True)
    transcribe(np.zeros(8000, dtype="<i2").tobytes())
    print(f"asr ready on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

"""Phone agent service: forward one spoken utterance to DeepSeek Harness and return its reply."""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from deepseek_harness import DeepSeekHarness

PORT = 9031
PROVIDER = os.environ.get("PHONE_PROVIDER", "deepseek-official")
MODEL = os.environ.get("PHONE_MODEL", "deepseek-flash")
HOME = "/Users/bvezina/.dsh-phone"
CWD = "/Users/bvezina/Documents/deepseek-harness/git"
SESSION = "phone"

SYSTEM = (
    "Réponse parlée au téléphone. Une à deux phrases, français, sans markdown ni listes. "
    "Va droit au fait."
)

harness = DeepSeekHarness(
    dsh_home=HOME,
    cwd=CWD,
    provider=PROVIDER,
    model=MODEL,
    api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
)
lock = threading.Lock()
session = None


def current_session():
    """Reuse the persisted phone session, creating it on first use."""
    global session
    if session is None:
        try:
            session = harness.resume_session(SESSION)
        except Exception:  # noqa: BLE001 - a missing session is created by the first run
            session = None
    return session


def ask(text: str) -> dict:
    """Run one harness turn and return its final text."""
    with lock:
        active = current_session()
        if active is None:
            result = harness.run(text, session_id=SESSION)
        else:
            result = active.run(text)
        return {"reply": (result.final_response or "").strip(), "finish": str(result.finish_reason)}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - http.server API
        self.reply(200, {"ready": True, "provider": PROVIDER, "model": MODEL})

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("content-length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path.startswith("/v1/chat/completions"):
                messages = payload.get("messages") or []
                text = ""
                for message in reversed(messages):
                    if message.get("role") == "user":
                        content = message.get("content")
                        text = content if isinstance(content, str) else str(content)
                        break
                reply = ask(text.strip())["reply"]
                self.reply(200, {
                    "id": "dsh-phone",
                    "object": "chat.completion",
                    "model": MODEL,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                })
                return
            text = str(payload.get("text", "")).strip()
            if text == "":
                self.reply(400, {"error": "text is required"})
                return
            self.reply(200, ask(text))
        except Exception as error:  # noqa: BLE001 - report any turn failure to the caller
            self.reply(500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"booting harness provider={PROVIDER} model={MODEL}", flush=True)
    ask("Réponds simplement: prêt.")
    print(f"agent ready on 0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

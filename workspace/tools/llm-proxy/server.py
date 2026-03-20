#!/usr/bin/env python3
"""
LLM Proxy — 把本機的 claude CLI 暴露成 HTTP API

用法:
  python3 server.py                    # 跑在 :18791
  python3 server.py --port 18791       # 指定 port

Vercel function 打這個 endpoint:
  POST /chat
  { "messages": [{"role":"user","content":"hello"}], "system": "..." }
  → { "text": "response..." }
"""

import json
import os
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 18791
AUTH_TOKEN = os.environ.get("LLM_PROXY_TOKEN", "ship-agents-chat-2026")


def call_claude(prompt: str, system: str = "", max_tokens: int = 600) -> str:
    """Call claude CLI with Max subscription."""
    full_prompt = prompt
    if system:
        full_prompt = f"<system>\n{system}\n</system>\n\n{prompt}"

    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    try:
        result = subprocess.run(
            ["claude", "--print", "--model", "haiku"],
            input=full_prompt,
            capture_output=True, text=True, timeout=60,
            env=env,
            cwd="/tmp",  # Isolate from project CLAUDE.md
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception as e:
        print(f"[proxy] claude CLI error: {e}")

    # Fallback: Ollama
    try:
        import urllib.request
        data = json.dumps({
            "model": "qwen2.5:14b",
            "messages": [{"role": "user", "content": full_prompt}],
            "temperature": 0.3,
            "max_tokens": max_tokens,
        }).encode()
        req = urllib.request.Request(
            "http://localhost:11434/v1/chat/completions",
            data=data, method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", "Bearer ollama")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[proxy] Ollama error: {e}")

    return "AI temporarily unavailable."


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_json(200, {"status": "ok", "service": "llm-proxy"})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self):
        # Auth check
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {AUTH_TOKEN}":
            self.send_json(401, {"error": "Unauthorized"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length else {}

        messages = body.get("messages", [])
        system = body.get("system", "")

        if not messages:
            self.send_json(400, {"error": "Messages required"})
            return

        # Build prompt from messages
        prompt_parts = []
        for m in messages[-20:]:
            role = m.get("role", "user")
            content = m.get("content", "")[:2000]
            if role == "user":
                prompt_parts.append(f"Human: {content}")
            else:
                prompt_parts.append(f"Assistant: {content}")

        prompt = "\n\n".join(prompt_parts) + "\n\nAssistant:"
        response_text = call_claude(prompt, system)

        self.send_json(200, {"text": response_text})

    def send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        print(f"[proxy] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[proxy] LLM Proxy running on :{PORT}")
    print(f"[proxy] Auth token: {AUTH_TOKEN}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[proxy] Shutting down")
        server.server_close()

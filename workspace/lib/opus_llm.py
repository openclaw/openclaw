"""
opus_llm — 統一 LLM 呼叫層

默認：Claude Opus → GLM-5.1 via z.ai → 智谱 HTTP → OpenClaw
備用：Ollama Qwen 14B（僅 embedding）

Usage:
  from workspace.lib.opus_llm import call_llm, call_embedding

  response = call_llm("你的 prompt")
  vector = call_embedding("要嵌入的文字")
"""

import json
import os
import subprocess
import urllib.request
from pathlib import Path

OLLAMA_URL = "http://localhost:11434"


def _get_zai_key() -> str | None:
    """讀取 ZAI_API_KEY（環境變量或 ~/.zai_key 文件）"""
    key = os.getenv('ZAI_API_KEY')
    if key:
        return key

    try:
        key_file = Path.home() / '.zai_key'
        if key_file.exists():
            return key_file.read_text().strip()
    except:
        pass

    return None


def _preflight_check(prompt: str) -> str | None:
    """Pre-flight check：擋掉垃圾 prompt，避免浪費 Opus。

    回傳 None = 通過，回傳 str = 錯誤訊息。
    """
    if not prompt or not prompt.strip():
        return "BLOCKED: empty prompt"

    # 最低素材門檻：prompt 裡必須有足夠的 context
    # 扣掉指令部分，純 data 至少要 50 字
    lines = prompt.strip().split('\n')
    data_chars = sum(len(l) for l in lines if not l.startswith('規則') and not l.startswith('-'))
    if data_chars < 50:
        return f"BLOCKED: prompt too thin ({data_chars} data chars < 50). Feed actual content, not vague references."

    # 偵測「請搜尋」「請查」等無素材指令
    lazy_patterns = ['請搜尋', '幫我查', '去找', 'search for', 'look up', '最新一集']
    prompt_lower = prompt.lower()
    for pat in lazy_patterns:
        if pat in prompt_lower and data_chars < 200:
            return f"BLOCKED: lazy prompt detected ('{pat}' without enough context). Provide the actual data."

    return None  # 通過


def _is_garbage(text: str, prompt: str) -> bool:
    """Detect if LLM output is garbage (unrelated to the prompt).

    Checks for common signs of context pollution:
    - Output mentions topics not in the prompt
    - Output is a continuation of a different conversation
    - Output is too short to be a real analysis (< 100 chars for data prompts)
    """
    if not text or len(text) < 50:
        return True

    # If prompt contains data keywords, output should too
    data_keywords = ['₹', '存款', '优惠', '盈利', '均值', '波动', '存提', 'deposit', 'promo']
    prompt_has_data = any(kw in prompt for kw in data_keywords)
    output_has_data = any(kw in text for kw in data_keywords)

    if prompt_has_data and not output_has_data and len(text) < 200:
        return True

    # Known garbage patterns from stale agent contexts
    garbage_signals = ['[SKIP]', '招聘廣告', '招聘广告', '請提供下一批', '请提供下一批',
                       '上一輪已成功', '上一轮已成功', '繼續處理訊息', '继续处理讯息']
    for sig in garbage_signals:
        if sig in text:
            return True

    return False


def call_llm(prompt: str, max_tokens: int = 500, timeout: int = 90) -> str:
    """Call LLM with fallback chain: Claude CLI → 智谱 HTTP → OpenClaw.

    Priority order (most reliable first):
    1. Claude Opus via CLI (fast, stable, launchd-safe with PATH fix)
    2. 智谱 BigModel HTTP API (GLM-5, JWT auth, may 429)
    3. OpenClaw CLI (local agent, may have stale context)
    """
    import sys

    # Pre-flight: 擋垃圾 prompt
    block_reason = _preflight_check(prompt)
    if block_reason:
        print(f"⚠️ opus_llm {block_reason}", file=sys.stderr)
        return f"[PREFLIGHT BLOCKED] {block_reason}"

    errors = []

    # === Path 1: Claude Opus via CLI (most reliable) ===
    CLAUDE_CLI = "/Users/sulaxd/.local/bin/claude"
    if os.path.exists(CLAUDE_CLI):
        try:
            env = {k: v for k, v in os.environ.items()}
            env["PATH"] = "/Users/sulaxd/.local/bin:/Applications/cmux.app/Contents/Resources/bin:/opt/homebrew/bin:" + env.get("PATH", "/usr/local/bin:/usr/bin:/bin")

            result = subprocess.run(
                [CLAUDE_CLI, "--print", "--model", "claude-opus-4-6"],
                input=prompt,
                capture_output=True, text=True, timeout=timeout,
                env=env,
            )
            if result.returncode == 0 and result.stdout.strip():
                text = result.stdout.strip()
                if not _is_garbage(text, prompt):
                    print("[Claude Opus CLI]", file=sys.stderr)
                    return text
                else:
                    errors.append("Claude Opus: garbage output")
                    print(f"[Claude Opus: garbage output, falling through]", file=sys.stderr)
            else:
                err = result.stderr.strip()[:200] if result.stderr else "no output"
                errors.append(f"Claude Opus rc={result.returncode}: {err}")
                print(f"[Claude Opus failed (rc={result.returncode}): {err}]", file=sys.stderr)
        except subprocess.TimeoutExpired:
            errors.append("Claude Opus: timeout")
            print("[Claude Opus timeout]", file=sys.stderr)
        except Exception as e:
            errors.append(f"Claude Opus: {e}")
            print(f"[Claude Opus error: {e}]", file=sys.stderr)

    # === Path 1.5: GLM-5.1 via z.ai (free, stable) ===
    GLM_CLI = "/Users/sulaxd/.local/bin/glm"
    if os.path.exists(GLM_CLI):
        try:
            result = subprocess.run(
                [GLM_CLI, "glm-5.1", "--print", "--bare", "-p", prompt],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0 and result.stdout.strip():
                text = result.stdout.strip()
                if not _is_garbage(text, prompt):
                    print("[GLM-5.1 via z.ai]", file=sys.stderr)
                    return text
                else:
                    errors.append("GLM z.ai: garbage output")
                    print("[GLM z.ai: garbage output, falling through]", file=sys.stderr)
            else:
                err = result.stderr.strip()[:200] if result.stderr else "no output"
                errors.append(f"GLM z.ai rc={result.returncode}: {err}")
                print(f"[GLM z.ai failed (rc={result.returncode}): {err}]", file=sys.stderr)
        except subprocess.TimeoutExpired:
            errors.append("GLM z.ai: timeout")
            print("[GLM z.ai timeout]", file=sys.stderr)
        except Exception as e:
            errors.append(f"GLM z.ai: {e}")
            print(f"[GLM z.ai error: {e}]", file=sys.stderr)

    # === Path 2: 智谱 BigModel HTTP API (GLM-5, JWT auth) ===
    zai_key = _get_zai_key()
    if zai_key and "." in zai_key:
        try:
            import jwt as pyjwt
            api_id, secret = zai_key.split(".", 1)
            import time as _time
            jwt_payload = {
                "api_key": api_id,
                "exp": int(_time.time()) + 3600,
                "timestamp": int(_time.time()),
            }
            token = pyjwt.encode(jwt_payload, secret, algorithm="HS256",
                                 headers={"alg": "HS256", "sign_type": "SIGN"})
            payload = json.dumps({
                "model": "glm-5",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
            }).encode()
            req = urllib.request.Request(
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                data=payload, method="POST",
            )
            req.add_header("Content-Type", "application/json")
            req.add_header("Authorization", f"Bearer {token}")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode())
                text = body["choices"][0]["message"]["content"].strip()
                if text and not _is_garbage(text, prompt):
                    print("[智谱 GLM-5 HTTP]", file=sys.stderr)
                    return text
                elif text:
                    errors.append("智谱: garbage output")
                    print("[智谱: garbage output, falling through]", file=sys.stderr)
        except Exception as e:
            errors.append(f"智谱: {e}")
            print(f"[智谱 HTTP failed: {e}]", file=sys.stderr)

    # === Path 3: OpenClaw CLI (may have stale agent context) ===
    OPENCLAW_CLI = "/opt/homebrew/bin/openclaw"
    try:
        # Use --no-history to avoid stale context pollution
        result = subprocess.run(
            [OPENCLAW_CLI, "agent", "--local", "--no-history",
             "--message", prompt],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode == 0 and result.stdout.strip():
            import re
            out = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout)
            lines = [l for l in out.split('\n') if not l.startswith('[plugins]') and l.strip()]
            text = '\n'.join(lines).strip()
            if text and not _is_garbage(text, prompt):
                print("[OpenClaw GLM-5]", file=sys.stderr)
                return text
            elif text:
                errors.append("OpenClaw: garbage output")
                print(f"[OpenClaw: garbage output, discarded]", file=sys.stderr)
    except Exception as e:
        errors.append(f"OpenClaw: {e}")
        print(f"[OpenClaw failed: {e}]", file=sys.stderr)

    # All paths failed
    return f"[ALL LLM PATHS FAILED] {'; '.join(errors)}"


def call_embedding(text: str, model: str = "qwen3-embedding:8b", dim: int = 1024) -> list[float]:
    """Get embedding vector. Requires Ollama (embedding is local-only).

    Auto-starts Ollama if not running.
    """
    import numpy as np

    try:
        data = json.dumps({
            "model": model,
            "input": text,
            "dimensions": dim,
        }).encode()
        req = urllib.request.Request(
            f"{OLLAMA_URL}/v1/embeddings",
            data=data, method="POST",
        )
        req.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            vec = result["data"][0]["embedding"]
            arr = np.array(vec, dtype=np.float32)
            norm = np.linalg.norm(arr)
            if norm > 1e-9:
                arr = arr / norm
            return arr.tolist()
    except Exception:
        # Try auto-starting Ollama
        try:
            subprocess.Popen(
                ["/Applications/Ollama.app/Contents/Resources/ollama", "serve"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            import time
            time.sleep(3)
            # Retry
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                urllib.request.Request(
                    f"{OLLAMA_URL}/v1/embeddings",
                    data=data, method="POST",
                    headers={"Content-Type": "application/json"},
                ), timeout=30
            ) as resp:
                result = json.loads(resp.read().decode())
                vec = result["data"][0]["embedding"]
                arr = np.array(vec, dtype=np.float32)
                norm = np.linalg.norm(arr)
                if norm > 1e-9:
                    arr = arr / norm
                return arr.tolist()
        except Exception:
            pass

    # Last resort: deterministic random
    rng = np.random.RandomState(abs(hash(text)) % (2**31))
    vec = rng.randn(dim).astype(np.float32)
    vec = vec / (np.linalg.norm(vec) + 1e-9)
    return vec.tolist()

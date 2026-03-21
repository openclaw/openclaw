# Building a Self-Healing AI Agent Monitor in 50 Lines of Python

Your AI agent works perfectly at 2pm when you're watching it. At 3am, it crashes silently. You wake up to angry customers, a dead process, and no logs explaining what happened.

If you've deployed any long-running AI agent — a chatbot, an automation pipeline, a code assistant — you've lived this. The agent dies, nobody notices for hours, and the failure cascades.

This article gives you a production-grade self-healing monitor in about 50 lines of Python. It watches your agent process, restarts it when it dies, backs off when something is fundamentally broken, and optionally uses a cheap AI call to diagnose what went wrong.

## The Problem: Silent Death

AI agents fail differently than traditional services. A web server either runs or doesn't. An AI agent can fail in subtle ways:

- **OOM kills**: The model context grows until the OS kills the process. No error log, no stack trace. Just gone.
- **API timeouts**: The upstream model provider goes down, the agent hangs on a request, and eventually the connection resets.
- **State corruption**: The agent writes bad data to its memory file, then crashes on the next read. It will crash again immediately after restart.
- **Dependency rot**: A library update changes an API signature. The agent imports fine but crashes on first use.

Traditional process managers like `systemd` or `supervisord` handle restarts, but they don't understand _why_ the process died. They'll happily restart a state-corrupted agent 10,000 times in a row, burning API credits and CPU.

We need something smarter.

## The Solution: A 50-Line Self-Healing Daemon

Here's the complete daemon. Read it first, then I'll explain each part.

```python
#!/usr/bin/env python3
"""Self-healing AI agent monitor. Watches a process, restarts with backoff."""

import subprocess, time, sys, os, json
from datetime import datetime, timedelta
from pathlib import Path

# --- Configuration ---
AGENT_CMD = sys.argv[1:]                          # e.g. python3 my_agent.py
STATE_FILE = Path("/tmp/agent-monitor-state.json")
MAX_BACKOFF = 3600         # max 1 hour between restarts
FLAP_WINDOW = 300          # 5 minutes
FLAP_THRESHOLD = 5         # 5 crashes in window = flapping
HEALTHY_AFTER = 120        # 2 minutes uptime = reset backoff

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"crashes": [], "backoff": 1, "total_restarts": 0}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, default=str))

def is_flapping(state):
    cutoff = datetime.now() - timedelta(seconds=FLAP_WINDOW)
    recent = [c for c in state["crashes"] if datetime.fromisoformat(c) > cutoff]
    return len(recent) >= FLAP_THRESHOLD

def run_agent(state):
    print(f"[monitor] Starting: {' '.join(AGENT_CMD)}")
    start = time.time()
    proc = subprocess.run(AGENT_CMD)
    uptime = time.time() - start

    if uptime > HEALTHY_AFTER:
        state["backoff"] = 1  # reset backoff — it ran long enough
        print(f"[monitor] Agent ran {uptime:.0f}s (healthy). Backoff reset.")
    else:
        state["backoff"] = min(state["backoff"] * 2, MAX_BACKOFF)
        print(f"[monitor] Agent died after {uptime:.0f}s. Backoff: {state['backoff']}s")

    state["crashes"].append(datetime.now().isoformat())
    state["crashes"] = state["crashes"][-20:]  # keep last 20
    state["total_restarts"] += 1
    return proc.returncode

def main():
    if not AGENT_CMD:
        print("Usage: python monitor.py <command> [args...]")
        sys.exit(1)

    state = load_state()
    while True:
        if is_flapping(state):
            print(f"[monitor] FLAP DETECTED: {FLAP_THRESHOLD} crashes in {FLAP_WINDOW}s. Cooling down 10m.")
            save_state(state)
            time.sleep(600)
            state["crashes"] = []  # clear after cooldown

        run_agent(state)
        save_state(state)
        print(f"[monitor] Waiting {state['backoff']}s before restart...")
        time.sleep(state["backoff"])

if __name__ == "__main__":
    main()
```

Save it as `monitor.py` and run it:

```bash
python3 monitor.py python3 my_agent.py --config prod.yaml
```

That's it. Your agent is now self-healing. Let's break down why each part matters.

## Exponential Backoff: Don't Hammer a Dead Process

The most important line in the daemon is this one:

```python
state["backoff"] = min(state["backoff"] * 2, MAX_BACKOFF)
```

When an agent crashes, the first restart happens after 1 second. If it crashes again, the next restart is after 2 seconds. Then 4, 8, 16, 32... up to a maximum of 3600 seconds (1 hour).

Why? Because if an agent keeps crashing, restarting it faster won't help. You're just burning resources. Exponential backoff gives the underlying problem time to resolve — maybe the API comes back, maybe the disk frees up, maybe your on-call engineer wakes up.

The equally important counterpart is the **healthy reset**:

```python
if uptime > HEALTHY_AFTER:
    state["backoff"] = 1
```

If the agent runs for more than 2 minutes, it was probably a transient failure. Reset the backoff to 1 second so the next restart is fast. This is what makes the system self-healing rather than just cautious — transient failures get fast recovery, persistent failures get graceful degradation.

## Flap Detection: Know When to Stop

Flapping is when a process crashes, restarts, crashes, restarts, crashes — in a tight loop. Even with exponential backoff, the first few restarts happen quickly. If the agent is fundamentally broken (bad config, corrupted state file, missing dependency), you want to detect this pattern and stop.

```python
def is_flapping(state):
    cutoff = datetime.now() - timedelta(seconds=FLAP_WINDOW)
    recent = [c for c in state["crashes"] if datetime.fromisoformat(c) > cutoff]
    return len(recent) >= FLAP_THRESHOLD
```

Five crashes in 5 minutes triggers a 10-minute cooldown. After the cooldown, the crash history resets and the daemon tries again with a fresh slate.

This prevents two disasters:

1. **Resource exhaustion**: An agent that crashes on startup and gets restarted 1000 times can eat significant CPU, memory, and API costs.
2. **Log flooding**: Thousands of crash-restart cycles bury your actual diagnostic information in noise.

## Optional: AI-Powered Diagnosis

Here's a bonus addition. When the agent crashes, you can use a cheap model call to analyze the last few log lines and suggest a fix:

```python
import urllib.request

def diagnose_crash(returncode, log_tail):
    """Use a cheap AI call to diagnose the crash. ~$0.001 per call."""
    prompt = f"""An AI agent process exited with code {returncode}.
Last 20 lines of output:
{log_tail}

In 2-3 sentences: what likely went wrong and what should be checked?"""

    payload = json.dumps({
        "model": "claude-haiku-4-20250414",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "content-type": "application/json",
            "x-api-key": os.environ.get("ANTHROPIC_API_KEY", ""),
            "anthropic-version": "2023-06-01"
        }
    )

    try:
        resp = urllib.request.urlopen(req, timeout=10)
        result = json.loads(resp.read())
        diagnosis = result["content"][0]["text"]
        print(f"[monitor] AI Diagnosis: {diagnosis}")
        return diagnosis
    except Exception as e:
        print(f"[monitor] Diagnosis failed: {e}")
        return None
```

To capture logs for diagnosis, modify `run_agent` to use `subprocess.Popen` instead of `subprocess.run`:

```python
def run_agent_with_logs(state):
    proc = subprocess.Popen(
        AGENT_CMD,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    log_lines = []
    for line in proc.stdout:
        print(line, end="")  # still show output in real-time
        log_lines.append(line)
        log_lines = log_lines[-20:]  # keep last 20 lines

    proc.wait()

    if proc.returncode != 0:
        diagnose_crash(proc.returncode, "".join(log_lines))

    return proc.returncode
```

At roughly $0.001 per diagnosis call, you can afford to run this on every crash. The AI often catches things humans miss at 3am: "The error suggests the SQLite database is locked, likely because a previous process didn't release the lock file. Check for stale .lock files in /tmp."

## Making It Production-Ready

The 50-line version is genuinely useful, but here are a few additions for serious production use:

### 1. Signal Handling

Catch SIGTERM so the monitor shuts down cleanly when you stop it:

```python
import signal

def handle_signal(signum, frame):
    print(f"[monitor] Received signal {signum}. Shutting down.")
    save_state(state)
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)
```

### 2. Notifications

Add a webhook call when the agent enters flap state:

```python
def notify_flap(state):
    webhook_url = os.environ.get("ALERT_WEBHOOK")
    if not webhook_url:
        return
    payload = json.dumps({
        "text": f"Agent flapping! {state['total_restarts']} total restarts. Last crash: {state['crashes'][-1]}"
    }).encode()
    req = urllib.request.Request(webhook_url, data=payload,
        headers={"content-type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # don't crash the monitor
```

### 3. Health Check Endpoint

If your agent exposes an HTTP health endpoint, you can check for _logical_ death (process alive but unresponsive) in addition to process death:

```python
def health_check(port=8080):
    try:
        resp = urllib.request.urlopen(f"http://localhost:{port}/health", timeout=5)
        return resp.status == 200
    except Exception:
        return False
```

## The Bigger Picture

This monitor solves the immediate problem: agents crash, and nobody notices. But it's part of a larger pattern in production AI systems — **agents need operational infrastructure**, not just good prompts.

The hierarchy of agent reliability looks like this:

1. **Process liveness**: Is the agent running? (This article)
2. **Behavioral health**: Is the agent doing the right thing? (Requires output monitoring)
3. **Identity stability**: Is the agent still acting like itself? (Requires identity architecture)
4. **Memory persistence**: Does the agent remember what it learned? (Requires a memory system)

Each layer builds on the one below. There's no point monitoring behavior if the process keeps dying. There's no point maintaining memory if the agent's identity drifts between sessions.

---

_If you're building AI agents that need to run reliably in production — not just impressive demos — check out [thinker.cafe](https://thinker.cafe) for practical patterns on self-healing, identity architecture, and memory persistence._

# Monitoring Blueprint: Keeping AI Agents Alive 24/7

AI agents crash. APIs go down. Certificates expire. Models return nonsense.
The difference between a demo and a production system is what happens at 3 AM
when nobody is watching.

This guide covers how to build a monitoring system that detects failures,
attempts repairs, and escalates to humans only when necessary.

---

## Core Architecture: Level-Triggered Reconciliation

Most monitoring systems are edge-triggered: they fire when something changes
(server goes down, error rate spikes). This is fragile. If the monitor itself
restarts, it misses the edge and the alert is lost.

Level-triggered reconciliation is simpler and more reliable:

```
Every N minutes:
  1. OBSERVE  -- What is the current state of the world?
  2. DIFF     -- How does it differ from the desired state?
  3. ACT      -- Take the minimum action to close the gap
```

**The key insight:** you don't need to know _what changed_. You only need to
know _what's wrong right now_. If a service is down, restart it -- whether it
crashed 5 seconds ago or 5 hours ago.

```python
def reconcile(desired_state, services):
    """Level-triggered reconciliation loop."""
    observed = observe_all(services)

    for name, desired in desired_state.items():
        actual = observed.get(name)
        if actual is None:
            log(f"{name}: not found, attempting repair")
            repair(name, desired)
        elif actual["status"] != "healthy":
            log(f"{name}: unhealthy ({actual['status']}), attempting repair")
            repair(name, desired)
        else:
            log(f"{name}: healthy")
```

---

## Desired State Declaration

Define what "healthy" looks like in a config file, not in code:

```yaml
desired_state:
  services:
    api-gateway:
      label: com.myapp.gateway # Process manager label
      port: 8080
      health:
        type: http
        url: "http://localhost:8080/health"
        timeout: 5 # seconds
      repair:
        risk: low
        method: restart
        backoff: 15 # initial backoff seconds
        cap: 300 # max backoff seconds
        max_retries: 10

    worker-agent:
      label: com.myapp.worker
      health:
        type: process # Just check if the process exists
      repair:
        risk: low
        method: restart
        backoff: 30
        cap: 600
        max_retries: 5

    database-proxy:
      label: com.myapp.db-proxy
      port: 5432
      health:
        type: tcp # TCP port check
        timeout: 3
      repair:
        risk: medium
        method: restart
        backoff: 60
        cap: 900
        max_retries: 3

  system:
    disk_warn_pct: 80
    disk_crit_pct: 90
    swap_crit_mb: 2000
    cpu_hog_pct: 95
```

**Risk levels matter.** A `low` risk repair (restarting a stateless gateway)
can be automated aggressively. A `medium` risk repair (restarting a database
proxy) needs more caution. A `high` risk repair (modifying config files) should
notify a human first.

---

## Health Check Patterns

### HTTP Health Check

The gold standard. Your service exposes a `/health` endpoint that returns 200
when healthy.

```python
def check_http(url, timeout=5):
    try:
        resp = requests.get(url, timeout=timeout)
        return {"status": "healthy" if resp.status_code == 200 else "degraded",
                "code": resp.status_code}
    except requests.Timeout:
        return {"status": "timeout"}
    except requests.ConnectionError:
        return {"status": "unreachable"}
```

**What the health endpoint should check:**

- Can the service reach its database?
- Are required API keys configured?
- Is the last successful operation within expected timeframe?

**What it should NOT check:**

- Downstream services (that's their health check's job)
- Expensive operations (health checks run every few minutes)

### Process Health Check

Simpler: just check if the process is running.

```python
def check_process(label):
    """Check if a launchd/systemd service is running."""
    result = subprocess.run(
        ["launchctl", "print", f"gui/{uid}/{label}"],
        capture_output=True, text=True
    )
    running = "state = running" in result.stdout
    return {"status": "healthy" if running else "not_running"}
```

### TCP Port Check

Middle ground: verify the port is accepting connections without sending
application-level requests.

```python
def check_tcp(host, port, timeout=3):
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        sock.close()
        return {"status": "healthy"}
    except (socket.timeout, ConnectionRefusedError):
        return {"status": "unreachable"}
```

---

## Self-Healing with Exponential Backoff

When a service fails, don't hammer it with restarts. Use exponential backoff
with a cap:

```
Attempt 1: restart, wait 15s
Attempt 2: restart, wait 30s
Attempt 3: restart, wait 60s
Attempt 4: restart, wait 120s
Attempt 5: restart, wait 300s (cap)
Attempt 6: restart, wait 300s (stays at cap)
...
Attempt 10: give up, notify human
```

```python
def compute_backoff(attempt, base=15, cap=300):
    """Exponential backoff with cap."""
    delay = min(base * (2 ** attempt), cap)
    return delay

def execute_repair(service_name, config, state):
    """Attempt repair with backoff tracking."""
    repair_state = state.get(service_name, {"attempts": 0, "last_attempt": 0})
    now = time.time()

    # Check if we've exhausted retries
    max_retries = config["repair"]["max_retries"]
    if repair_state["attempts"] >= max_retries:
        notify_human(f"{service_name} failed after {max_retries} attempts")
        return

    # Check if enough time has passed since last attempt
    backoff = compute_backoff(
        repair_state["attempts"],
        base=config["repair"]["backoff"],
        cap=config["repair"]["cap"]
    )
    if now - repair_state["last_attempt"] < backoff:
        return  # Too soon, skip this cycle

    # Attempt repair
    log(f"Repairing {service_name} (attempt {repair_state['attempts'] + 1})")
    success = restart_service(config["label"])

    repair_state["attempts"] = 0 if success else repair_state["attempts"] + 1
    repair_state["last_attempt"] = now
    state[service_name] = repair_state
```

**Critical:** Reset the attempt counter on success. Otherwise, a service that
fails once and recovers will exhaust its retry budget over days of intermittent
issues.

---

## Flap Detection

A flapping service is one that keeps crashing and restarting in a loop. Without
detection, your monitor will endlessly restart it, burning resources and
flooding logs.

```python
FLAP_THRESHOLD = 5      # failures in window = flapping
FLAP_WINDOW_SEC = 600   # 10-minute window

def is_flapping(service_name, state):
    """Detect if a service is crashing in a loop."""
    failures = state.get(f"{service_name}_failures", [])
    now = time.time()

    # Keep only failures within the window
    recent = [t for t in failures if now - t < FLAP_WINDOW_SEC]
    state[f"{service_name}_failures"] = recent

    return len(recent) >= FLAP_THRESHOLD
```

**When flapping is detected:**

1. Stop automatic restarts
2. Notify human with full context (error logs, timestamps, attempt history)
3. Enter cooldown period (e.g., 1 hour)
4. After cooldown, try one more time
5. If still failing, mark as "needs manual intervention"

---

## Budget-Aware AI Diagnosis

When a service fails and simple restarts don't fix it, you can use an AI model
to diagnose the issue. But AI calls cost money. Use a tiered approach:

```yaml
ai_diagnosis:
  enabled: true
  triage_model: "cheap" # $0.001/call -- classify the error
  diagnosis_model: "expensive" # $0.05/call -- deep analysis
  max_daily_budget_usd: 0.50
  cooldown_between_calls: 3600 # Don't call AI more than once per hour per service
```

**The triage flow:**

```
Service fails
  ├── Simple restart works? → Done
  ├── Restart fails 3x? → Cheap model: "Is this a config error, resource
  │                         issue, or code bug?"
  │     ├── Config error → Attempt automated config fix
  │     ├── Resource issue → Free up disk/memory, retry
  │     └── Code bug → Notify human (AI can't fix code)
  └── Flapping? → Expensive model: "Analyze these logs and suggest root cause"
                   → Notify human with diagnosis
```

**Why cheap models first:** A $0.001 Haiku-class call that classifies an error
into three categories saves you from burning $0.05 on a Sonnet-class call that
would have given the same answer. Reserve expensive models for cases where the
cheap model says "I don't know."

```python
def ai_diagnose(service_name, error_logs, config):
    """Two-tier AI diagnosis with budget tracking."""
    budget = load_daily_budget()
    if budget["spent"] >= config["max_daily_budget_usd"]:
        return {"action": "notify_human", "reason": "AI budget exhausted"}

    # Tier 1: cheap triage
    triage = call_llm(
        model=config["triage_model"],
        prompt=f"Classify this service failure:\n{error_logs}\n"
               f"Categories: config_error, resource_issue, code_bug, unknown"
    )
    budget["spent"] += 0.001

    if triage == "config_error":
        return {"action": "check_config", "category": triage}
    elif triage == "resource_issue":
        return {"action": "free_resources", "category": triage}
    elif triage == "code_bug":
        return {"action": "notify_human", "category": triage}

    # Tier 2: expensive diagnosis (only for "unknown")
    diagnosis = call_llm(
        model=config["diagnosis_model"],
        prompt=f"Analyze this failure in detail:\n{error_logs}\n"
               f"Provide: root cause, suggested fix, risk level"
    )
    budget["spent"] += 0.05

    return {"action": "notify_human_with_diagnosis", "diagnosis": diagnosis}
```

---

## Process Manager Integration

Your monitoring daemon itself needs to be kept alive. Use the OS process
manager.

### macOS (launchd)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.myapp.sentinel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/python3</string>
        <string>/opt/myapp/sentinel/sentinel.py</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/opt/myapp/logs/sentinel.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/opt/myapp/logs/sentinel.stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

### Linux (systemd)

```ini
[Unit]
Description=Sentinel Monitoring Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/myapp/sentinel/sentinel.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Key settings:**

- `KeepAlive` / `Restart=always`: The OS restarts the sentinel if it crashes
- `ThrottleInterval` / `RestartSec`: Don't restart too fast (avoids CPU spin)
- Log to files, not just stdout (logs survive restarts)

---

## Notification Strategy

Not every failure needs a human notification. Use priority levels:

| Priority | Response        | Notification            |
| -------- | --------------- | ----------------------- |
| P0       | Immediate       | Push notification + SMS |
| P1       | Within 1 hour   | Push notification       |
| P2       | Within 24 hours | Daily digest            |
| P3       | Informational   | Weekly summary          |

**Quiet hours:** Suppress P2/P3 notifications between midnight and 6 AM.
P0/P1 always go through.

**Deduplication:** The same alert should not fire repeatedly. Track known
issues in state and only re-notify if the situation changes (e.g., service
was flapping, now it's completely dead).

---

## Putting It All Together

A complete monitoring config for a three-service system:

```yaml
timezone: America/New_York

desired_state:
  services:
    api-gateway:
      label: com.myapp.gateway
      port: 8080
      health: { type: http, url: "http://localhost:8080/health", timeout: 5 }
      repair: { risk: low, method: restart, backoff: 15, cap: 300, max_retries: 10 }

    agent-worker:
      label: com.myapp.agent-worker
      health: { type: process }
      repair: { risk: low, method: restart, backoff: 30, cap: 600, max_retries: 5 }

    vector-db:
      label: com.myapp.vectordb
      port: 6333
      health: { type: tcp, timeout: 3 }
      repair: { risk: medium, method: restart, backoff: 60, cap: 900, max_retries: 3 }

  system:
    disk_warn_pct: 80
    disk_crit_pct: 90

tasks:
  health_check: { schedule: "every 5m", enabled: true }
  nightly_cleanup: { schedule: "02:00", enabled: true }
  daily_report: { schedule: "07:00", enabled: true, ai_model: "cheap" }
  weekly_review: { schedule: "sunday 10:00", enabled: true, ai_model: "expensive" }

ai_diagnosis:
  enabled: true
  triage_model: "cheap"
  diagnosis_model: "expensive"
  max_daily_budget_usd: 0.50
  cooldown_between_calls: 3600

notifications:
  webhook_url: "https://hooks.slack.com/..."
  quiet_hours: ["00:00", "06:00"]

flap_detection:
  threshold: 5
  window_seconds: 600

prune:
  logs_days: 7
  state_history_days: 30
```

---

## Monitoring Checklist

Before going to production:

- [ ] Every service has a health check (HTTP, TCP, or process)
- [ ] Repair actions use exponential backoff with a cap
- [ ] Flap detection prevents restart storms
- [ ] The sentinel itself is managed by the OS (launchd/systemd)
- [ ] AI diagnosis has a daily budget cap
- [ ] Notifications have priority levels and quiet hours
- [ ] State is persisted to disk (survives sentinel restarts)
- [ ] State file writes are atomic (write to tmp, then rename)
- [ ] Logs are pruned automatically (don't fill the disk)
- [ ] You've tested: what happens when the sentinel itself crashes?

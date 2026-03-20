# Deployment Guide — Ship AI Agents to Production

This guide covers every deployment scenario, from your laptop to a VPS. Pick the path that fits your situation.

---

## Table of Contents

1. [Local Development (Mac/Linux)](#1-local-development)
2. [Docker Deployment](#2-docker-deployment)
3. [VPS Deployment (DigitalOcean/Hetzner)](#3-vps-deployment)
4. [macOS Service (launchd)](#4-macos-service-launchd)
5. [Linux Service (systemd)](#5-linux-service-systemd)
6. [Environment Variables Reference](#6-environment-variables)
7. [Health Check Endpoints](#7-health-checks)
8. [Log Management](#8-log-management)
9. [Backup Strategy](#9-backup-strategy)
10. [Zero-Downtime Restart](#10-zero-downtime-restart)
11. [Cost Breakdown](#11-cost-breakdown)

---

## 1. Local Development

**Best for:** Testing, iterating on agent prompts, single-user setups.

### Prerequisites

- Python 3.11+
- Redis (optional — falls back to in-memory state)
- An LLM API key (Anthropic, OpenAI, etc.)

### Setup

```bash
# Clone and enter the project
git clone https://github.com/your-org/agent-stack.git
cd agent-stack

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Copy environment template
cp .env.template .env
# Edit .env — at minimum, set LLM_API_KEY

# Create your first agent
mkdir -p agents/my-agent
cp templates/SOUL.md.template agents/my-agent/SOUL.md
# Edit agents/my-agent/SOUL.md with your agent's identity

# Run
python3 runner.py --agents-dir ./agents
```

### Optional: Local Redis

```bash
# macOS
brew install redis
brew services start redis

# Linux (Ubuntu/Debian)
sudo apt install redis-server
sudo systemctl start redis
```

Set `REDIS_URL=redis://localhost:6379/0` in your `.env`.

### Development Tips

- Use `LOG_LEVEL=DEBUG` for verbose output during development.
- Run a single agent with `python3 runner.py --agent my-agent` to isolate testing.
- The runner auto-reloads agent files (SOUL.md, CONSTITUTION.md) on change — no restart needed for prompt edits.

---

## 2. Docker Deployment

**Best for:** Reproducible environments, multi-service setups, teams.

### Prerequisites

- Docker Engine 24+
- Docker Compose v2

### Quick Start

```bash
# Copy environment template
cp .env.template .env
# Edit .env with your API keys

# Build and start all services
docker compose up -d

# Check everything is healthy
docker compose ps

# Watch logs
docker compose logs -f agent-runner

# Stop everything
docker compose down
```

### What Gets Started

| Service      | Port            | Purpose              |
| ------------ | --------------- | -------------------- |
| agent-runner | 8080 (internal) | Hosts all agents     |
| sentinel     | —               | Monitors services    |
| redis        | 6379 (internal) | Shared state         |
| api-gateway  | 3000 (exposed)  | External entry point |

### Building Custom Images

The compose file references three Dockerfiles:

```
Dockerfile.agent-runner  — Python 3.11-slim, your agent code
Dockerfile.sentinel      — Python 3.11-slim, sentinel daemon
Dockerfile.gateway       — Node 20-alpine or Python, your gateway
```

Example `Dockerfile.agent-runner`:

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
COPY runner.py .
EXPOSE 8080
CMD ["python3", "runner.py", "--host", "0.0.0.0", "--port", "8080"]
```

### Updating Agents Without Rebuilding

Agent definitions (SOUL.md, etc.) are mounted as volumes. To update:

```bash
# Edit your agent file
vim agents/my-agent/SOUL.md

# The runner picks up changes automatically (no restart needed)
# If you need to force reload:
docker compose restart agent-runner
```

---

## 3. VPS Deployment (DigitalOcean / Hetzner)

**Best for:** Production workloads, always-on agents, cost-effective hosting.

### Recommended Specs

| Workload                      | VPS Size        | Monthly Cost |
| ----------------------------- | --------------- | ------------ |
| 1-3 agents, light traffic     | 1 vCPU, 2GB RAM | $6-12/mo     |
| 5-10 agents, moderate traffic | 2 vCPU, 4GB RAM | $12-24/mo    |
| 10+ agents, high traffic      | 4 vCPU, 8GB RAM | $24-48/mo    |

### Initial Server Setup

```bash
# SSH into your new server
ssh root@your-server-ip

# Create a non-root user
adduser agentops
usermod -aG sudo agentops
su - agentops

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker agentops
# Log out and back in for group to take effect

# Install Docker Compose
sudo apt install docker-compose-plugin

# Clone your project
git clone https://github.com/your-org/agent-stack.git
cd agent-stack

# Set up environment
cp .env.template .env
nano .env  # Fill in API keys

# Start
docker compose up -d
```

### Firewall Setup

```bash
# Allow SSH and your gateway port only
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
sudo ufw enable

# Verify
sudo ufw status
```

### TLS with Caddy (Recommended)

Instead of exposing the gateway directly, put Caddy in front for automatic HTTPS:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/deb/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
# ... (follow Caddy install docs for your distro)

# Create Caddyfile
cat > /etc/caddy/Caddyfile << 'EOF'
agents.yourdomain.com {
    reverse_proxy localhost:3000
}
EOF

sudo systemctl restart caddy
```

### Auto-Updates

Create a simple update script:

```bash
#!/bin/bash
# /home/agentops/update.sh
cd /home/agentops/agent-stack
git pull
docker compose build
docker compose up -d --remove-orphans
docker image prune -f
```

Add to crontab for daily updates (optional):

```bash
crontab -e
# 0 4 * * * /home/agentops/update.sh >> /home/agentops/update.log 2>&1
```

---

## 4. macOS Service (launchd)

**Best for:** Running agents on a Mac that stays on (Mac Mini server, development machine).

### Create the plist

Save as `~/Library/LaunchAgents/com.agent-stack.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-stack.runner</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/python3</string>
        <string>/Users/you/agent-stack/runner.py</string>
        <string>--agents-dir</string>
        <string>/Users/you/agent-stack/agents</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/you/agent-stack</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>LLM_API_KEY</key>
        <string>sk-ant-xxxxx</string>
        <key>REDIS_URL</key>
        <string>redis://localhost:6379/0</string>
        <key>LOG_LEVEL</key>
        <string>INFO</string>
    </dict>

    <!-- Restart automatically if the process dies -->
    <key>KeepAlive</key>
    <true/>

    <!-- Wait 10 seconds before restarting after a crash -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <!-- Log stdout and stderr -->
    <key>StandardOutPath</key>
    <string>/Users/you/agent-stack/logs/runner-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/agent-stack/logs/runner-stderr.log</string>

    <!-- Start after login -->
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Sentinel plist

Save as `~/Library/LaunchAgents/com.agent-stack.sentinel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-stack.sentinel</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/python3</string>
        <string>/Users/you/agent-stack/sentinel-daemon.py</string>
        <string>--config</string>
        <string>/Users/you/agent-stack/config/sentinel.yaml</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/you/agent-stack</string>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>/Users/you/agent-stack/logs/sentinel-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/agent-stack/logs/sentinel-stderr.log</string>

    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Managing the Services

```bash
# Load (start and enable auto-start)
launchctl load ~/Library/LaunchAgents/com.agent-stack.runner.plist
launchctl load ~/Library/LaunchAgents/com.agent-stack.sentinel.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.agent-stack.runner.plist

# Check status
launchctl list | grep agent-stack

# View logs
tail -f ~/agent-stack/logs/runner-stdout.log
```

---

## 5. Linux Service (systemd)

**Best for:** Linux VPS, dedicated servers.

### Agent Runner Service

Save as `/etc/systemd/system/agent-runner.service`:

```ini
[Unit]
Description=AI Agent Runner
After=network.target redis.service
Wants=redis.service

[Service]
Type=simple
User=agentops
Group=agentops
WorkingDirectory=/home/agentops/agent-stack
ExecStart=/home/agentops/agent-stack/.venv/bin/python3 runner.py --agents-dir ./agents
Restart=always
RestartSec=10

# Environment
EnvironmentFile=/home/agentops/agent-stack/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/agentops/agent-stack/logs
PrivateTmp=true

# Resource limits
MemoryMax=1G
CPUQuota=100%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-runner

[Install]
WantedBy=multi-user.target
```

### Sentinel Service

Save as `/etc/systemd/system/agent-sentinel.service`:

```ini
[Unit]
Description=Agent Sentinel Monitoring Daemon
After=network.target agent-runner.service

[Service]
Type=simple
User=agentops
Group=agentops
WorkingDirectory=/home/agentops/agent-stack
ExecStart=/home/agentops/agent-stack/.venv/bin/python3 sentinel-daemon.py --config config/sentinel.yaml
Restart=always
RestartSec=30

EnvironmentFile=/home/agentops/agent-stack/.env

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/agentops/agent-stack/logs /home/agentops/agent-stack/state
PrivateTmp=true

MemoryMax=256M
CPUQuota=25%

StandardOutput=journal
StandardError=journal
SyslogIdentifier=agent-sentinel

[Install]
WantedBy=multi-user.target
```

### Managing systemd Services

```bash
# Reload after creating/editing service files
sudo systemctl daemon-reload

# Enable (start on boot) and start
sudo systemctl enable --now agent-runner
sudo systemctl enable --now agent-sentinel

# Check status
sudo systemctl status agent-runner
sudo systemctl status agent-sentinel

# View logs
journalctl -u agent-runner -f
journalctl -u agent-sentinel --since "1 hour ago"

# Restart
sudo systemctl restart agent-runner
```

---

## 6. Environment Variables

| Variable                  | Required | Default                    | Description                                      |
| ------------------------- | -------- | -------------------------- | ------------------------------------------------ |
| `LLM_API_KEY`             | Yes      | —                          | API key for your LLM provider                    |
| `LLM_PROVIDER`            | No       | `anthropic`                | `anthropic`, `openai`, `ollama`                  |
| `LLM_MODEL`               | No       | `claude-sonnet-4-20250514` | Model for agent responses                        |
| `DIAGNOSIS_MODEL`         | No       | `claude-haiku-4-20250514`  | Cheap model for sentinel diagnosis               |
| `REDIS_URL`               | No       | `redis://localhost:6379/0` | Redis connection string                          |
| `TELEGRAM_BOT_TOKEN`      | No       | —                          | Telegram Bot API token                           |
| `DISCORD_BOT_TOKEN`       | No       | —                          | Discord bot token                                |
| `SLACK_BOT_TOKEN`         | No       | —                          | Slack bot token                                  |
| `API_SECRET_KEY`          | Yes\*    | —                          | Secret for API gateway auth (\*if using gateway) |
| `LOG_LEVEL`               | No       | `INFO`                     | `DEBUG`, `INFO`, `WARNING`, `ERROR`              |
| `MAX_CONCURRENT_AGENTS`   | No       | `10`                       | Max agents running simultaneously                |
| `MAX_TOKENS_PER_RESPONSE` | No       | `4096`                     | Token limit per LLM call                         |
| `MAX_COST_PER_HOUR_USD`   | No       | `1.00`                     | Cost circuit breaker                             |
| `RATE_LIMIT_PER_MINUTE`   | No       | `60`                       | API gateway rate limit                           |
| `GATEWAY_PORT`            | No       | `3000`                     | Port for the API gateway                         |
| `ALERT_TELEGRAM_TOKEN`    | No       | —                          | Bot token for sentinel alerts                    |
| `ALERT_TELEGRAM_CHAT_ID`  | No       | —                          | Chat ID for sentinel alerts                      |

---

## 7. Health Checks

### Agent Runner — `GET /health`

```json
{
  "status": "healthy",
  "uptime_seconds": 86420,
  "agents_loaded": 3,
  "agents": {
    "support-bot": { "status": "running", "messages_processed": 142 },
    "moderator": { "status": "running", "messages_processed": 891 },
    "reporter": { "status": "idle", "last_active": "2025-03-15T08:00:00Z" }
  },
  "redis_connected": true,
  "llm_provider": "anthropic",
  "cost_last_hour_usd": 0.23
}
```

### API Gateway — `GET /health`

```json
{
  "status": "healthy",
  "uptime_seconds": 86420,
  "upstream_healthy": true,
  "requests_last_minute": 12
}
```

### Monitoring Script

```bash
#!/bin/bash
# Simple health check you can add to cron
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
if [ "$HEALTH" != "200" ]; then
    echo "ALERT: Gateway unhealthy (HTTP $HEALTH)" | \
      curl -s -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
      -d chat_id="${ALERT_CHAT_ID}" -d text="$(cat -)"
fi
```

---

## 8. Log Management

### Log Locations

| Service      | Docker                 | Native                |
| ------------ | ---------------------- | --------------------- |
| Agent Runner | `./logs/agent-runner/` | `./logs/runner.log`   |
| Sentinel     | `./logs/sentinel/`     | `./logs/sentinel.log` |
| Gateway      | Docker stdout          | `./logs/gateway.log`  |

### Log Rotation

For native deployments, set up logrotate:

```
# /etc/logrotate.d/agent-stack
/home/agentops/agent-stack/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

For Docker, configure the logging driver in your compose file:

```yaml
services:
  agent-runner:
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
```

### Structured Logging

All services output JSON-formatted logs when `LOG_LEVEL` is set:

```json
{
  "ts": "2025-03-15T10:30:00Z",
  "level": "INFO",
  "service": "agent-runner",
  "agent": "support-bot",
  "event": "message_processed",
  "tokens": 342,
  "cost_usd": 0.0012
}
```

Parse with `jq`:

```bash
# Show all errors in the last hour
cat logs/runner.log | jq 'select(.level == "ERROR")'

# Cost per agent today
cat logs/runner.log | jq 'select(.event == "message_processed") | {agent, cost_usd}' | jq -s 'group_by(.agent) | map({agent: .[0].agent, total_cost: (map(.cost_usd) | add)})'
```

---

## 9. Backup Strategy

### What to Back Up

| Data                          | Priority | Method           | Frequency    |
| ----------------------------- | -------- | ---------------- | ------------ |
| Agent definitions (`agents/`) | Critical | Git              | Every change |
| Environment files (`.env`)    | Critical | Encrypted backup | Weekly       |
| Redis data                    | Medium   | RDB snapshot     | Daily        |
| Logs                          | Low      | Rotate + archive | Weekly       |
| Sentinel state                | Low      | File copy        | Daily        |

### Automated Backup Script

```bash
#!/bin/bash
# /home/agentops/backup.sh
BACKUP_DIR="/home/agentops/backups/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

# 1. Agent definitions (should already be in git, but belt-and-suspenders)
tar czf "$BACKUP_DIR/agents.tar.gz" -C /home/agentops/agent-stack agents/

# 2. Redis snapshot
docker compose exec redis redis-cli BGSAVE
sleep 2
cp /home/agentops/agent-stack/redis-data/dump.rdb "$BACKUP_DIR/"

# 3. Config (encrypt sensitive files)
tar czf - -C /home/agentops/agent-stack .env config/ | \
  gpg --symmetric --cipher-algo AES256 -o "$BACKUP_DIR/config.tar.gz.gpg"

# 4. Sentinel state
cp -r /home/agentops/agent-stack/state/ "$BACKUP_DIR/sentinel-state/"

# 5. Prune old backups (keep 30 days)
find /home/agentops/backups/ -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;

echo "Backup complete: $BACKUP_DIR"
```

Add to crontab:

```bash
0 3 * * * /home/agentops/backup.sh >> /home/agentops/backup.log 2>&1
```

---

## 10. Zero-Downtime Restart

When you need to update agent code without dropping messages.

### Docker Approach

```bash
# 1. Build the new image
docker compose build agent-runner

# 2. Restart with zero downtime
#    Docker Compose recreates the container while the old one is still running.
#    The health check ensures traffic only routes to the new container once ready.
docker compose up -d --no-deps agent-runner

# 3. Verify
docker compose ps
curl http://localhost:3000/health
```

### Native Approach (Graceful Restart)

The agent runner supports `SIGHUP` for graceful reload:

```bash
# Send SIGHUP to reload agent definitions without dropping connections
kill -HUP $(pgrep -f "python3 runner.py")

# For a full restart with connection draining:
# 1. Tell the runner to stop accepting new connections
kill -USR1 $(pgrep -f "python3 runner.py")

# 2. Wait for in-flight requests to complete (check health endpoint)
while curl -s http://localhost:8080/health | jq -e '.in_flight > 0' > /dev/null; do
    sleep 1
done

# 3. Start the new version
systemctl restart agent-runner

# 4. Verify
curl http://localhost:8080/health
```

### For Agent Prompt Updates Only

If you are only changing SOUL.md, CONSTITUTION.md, or HEARTBEAT.md files (no code changes), no restart is needed. The runner watches these files and reloads them automatically.

---

## 11. Cost Breakdown

What you actually pay per month to run this stack.

### Infrastructure Costs

| Component       | Self-Hosted (VPS)  | Docker on Mac  | Cloud (AWS/GCP) |
| --------------- | ------------------ | -------------- | --------------- |
| VPS/Server      | $6-24/mo           | $0 (your Mac)  | $30-100/mo      |
| Domain + DNS    | $1/mo              | $0 (localhost) | $1/mo           |
| TLS Certificate | $0 (Let's Encrypt) | $0 (N/A)       | $0 (ACM)        |
| Redis           | $0 (self-hosted)   | $0 (local)     | $15-30/mo       |
| **Infra Total** | **$7-25/mo**       | **$0**         | **$46-131/mo**  |

### LLM API Costs

These depend heavily on traffic volume. Estimates for a typical small deployment:

| Traffic Level        | Messages/Day | Model         | Monthly LLM Cost |
| -------------------- | ------------ | ------------- | ---------------- |
| Low (personal)       | 10-50        | Claude Haiku  | $1-5/mo          |
| Medium (small team)  | 50-200       | Claude Sonnet | $10-40/mo        |
| High (public-facing) | 200-1000     | Claude Sonnet | $40-200/mo       |
| Sentinel diagnosis   | N/A          | Claude Haiku  | $0.50-2/mo       |

### Cost Optimization Tips

1. **Use the cheapest model that works.** Start with Haiku. Only upgrade to Sonnet for agents that need it.
2. **Cache aggressively.** If the same question comes up often, cache the response in Redis.
3. **Set cost circuit breakers.** `MAX_COST_PER_HOUR_USD=1.00` prevents runaway costs.
4. **Use prompt caching.** Long system prompts (SOUL.md) get cached by the API provider, reducing costs by 50-90%.
5. **Monitor daily.** Check `curl localhost:8080/health | jq '.cost_last_hour_usd'` regularly.

### Realistic Monthly Budget

| Setup                           | Infra | LLM  | Total       |
| ------------------------------- | ----- | ---- | ----------- |
| Solo hacker, 2 agents on Mac    | $0    | $5   | **$5/mo**   |
| Small team, 5 agents on Hetzner | $12   | $30  | **$42/mo**  |
| Production, 10 agents on DO     | $24   | $100 | **$124/mo** |

The most common mistake is over-provisioning infrastructure. A $6/mo VPS can comfortably run 5 agents. Start small.

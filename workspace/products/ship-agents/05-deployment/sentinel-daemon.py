#!/usr/bin/env python3
"""
Sentinel Daemon — Lightweight service monitor for AI agent stacks.

Reads a YAML config defining services to watch, periodically checks their
health via HTTP endpoints, and restarts failed services with exponential
backoff. Includes flap detection to avoid restart loops.

Optionally calls a cheap LLM to diagnose repeated failures.

Usage:
    python3 sentinel-daemon.py --config sentinel.yaml
    python3 sentinel-daemon.py --config sentinel.yaml --once    # Single check, then exit
    python3 sentinel-daemon.py --config sentinel.yaml --dry-run # Check but don't restart

Example sentinel.yaml:

    check_interval: 30          # seconds between health check rounds
    log_file: logs/sentinel.log
    flap_threshold: 5           # max restarts in flap_window before giving up
    flap_window: 300            # seconds

    # Optional: LLM diagnosis for repeated failures
    llm:
      enabled: false
      api_key_env: LLM_API_KEY  # environment variable name
      model: claude-haiku-4-20250514
      provider: anthropic       # anthropic or openai

    services:
      agent-runner:
        health_url: http://localhost:8080/health
        restart_command: "systemctl restart agent-runner"
        initial_backoff: 5      # seconds before first restart attempt
        max_backoff: 300        # max seconds between restarts
        timeout: 10             # health check timeout in seconds

      api-gateway:
        health_url: http://localhost:3000/health
        restart_command: "docker compose restart api-gateway"
        initial_backoff: 3
        max_backoff: 120
        timeout: 5
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

try:
    import yaml
except ImportError:
    print("PyYAML required: pip install pyyaml", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Service state tracking
# ---------------------------------------------------------------------------

class ServiceState:
    """Tracks health check state and restart history for a single service."""

    def __init__(self, name: str, config: dict):
        self.name = name
        self.health_url = config["health_url"]
        self.restart_command = config.get("restart_command", "")
        self.initial_backoff = config.get("initial_backoff", 5)
        self.max_backoff = config.get("max_backoff", 300)
        self.timeout = config.get("timeout", 10)

        # Runtime state
        self.consecutive_failures = 0
        self.current_backoff = self.initial_backoff
        self.last_restart_time: float = 0
        self.restart_timestamps: list[float] = []
        self.last_error: str = ""
        self.healthy = True

    def record_success(self):
        """Reset failure counters on successful health check."""
        self.consecutive_failures = 0
        self.current_backoff = self.initial_backoff
        self.healthy = True
        self.last_error = ""

    def record_failure(self, error: str):
        """Increment failure counter and update backoff."""
        self.consecutive_failures += 1
        self.last_error = error
        self.healthy = False

    def bump_backoff(self):
        """Double the backoff (exponential), capped at max_backoff."""
        self.current_backoff = min(self.current_backoff * 2, self.max_backoff)

    def record_restart(self):
        """Record a restart timestamp for flap detection."""
        now = time.time()
        self.last_restart_time = now
        self.restart_timestamps.append(now)

    def is_flapping(self, threshold: int, window: int) -> bool:
        """Check if restarts exceed threshold within the time window."""
        cutoff = time.time() - window
        self.restart_timestamps = [t for t in self.restart_timestamps if t > cutoff]
        return len(self.restart_timestamps) >= threshold

    def time_until_next_restart(self) -> float:
        """Seconds until next restart attempt is allowed."""
        if self.last_restart_time == 0:
            return 0
        elapsed = time.time() - self.last_restart_time
        remaining = self.current_backoff - elapsed
        return max(0, remaining)


# ---------------------------------------------------------------------------
# Sentinel Daemon
# ---------------------------------------------------------------------------

class SentinelDaemon:
    """Main daemon loop: check services, restart failures, detect flaps."""

    def __init__(self, config: dict, dry_run: bool = False):
        self.config = config
        self.dry_run = dry_run
        self.check_interval = config.get("check_interval", 30)
        self.flap_threshold = config.get("flap_threshold", 5)
        self.flap_window = config.get("flap_window", 300)

        # Initialize service states
        self.services: dict[str, ServiceState] = {}
        for name, svc_config in config.get("services", {}).items():
            self.services[name] = ServiceState(name, svc_config)

        # Set up logging
        self._setup_logging(config.get("log_file", "logs/sentinel.log"))

        # LLM diagnosis config
        self.llm_config = config.get("llm", {})
        self.llm_enabled = self.llm_config.get("enabled", False)

    def _setup_logging(self, log_file: str):
        """Configure file + console logging."""
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger("sentinel")
        self.logger.setLevel(logging.DEBUG)

        fmt = logging.Formatter(
            '{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
            datefmt="%Y-%m-%dT%H:%M:%S"
        )

        fh = logging.FileHandler(log_file)
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        self.logger.addHandler(fh)

        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)
        ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        self.logger.addHandler(ch)

    def check_health(self, service: ServiceState) -> tuple[bool, str]:
        """
        Hit the service's health endpoint.
        Returns (is_healthy, error_message).
        """
        try:
            req = urllib.request.Request(service.health_url, method="GET")
            with urllib.request.urlopen(req, timeout=service.timeout) as resp:
                if resp.status == 200:
                    return True, ""
                else:
                    return False, f"HTTP {resp.status}"
        except urllib.error.URLError as e:
            return False, f"Connection failed: {e.reason}"
        except Exception as e:
            return False, str(e)

    def restart_service(self, service: ServiceState) -> bool:
        """Execute the restart command. Returns True on success."""
        if not service.restart_command:
            self.logger.warning(f"[{service.name}] No restart_command configured, skipping")
            return False

        if self.dry_run:
            self.logger.info(f"[{service.name}] DRY RUN: would execute: {service.restart_command}")
            return True

        self.logger.info(f"[{service.name}] Restarting: {service.restart_command}")
        try:
            result = subprocess.run(
                service.restart_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode == 0:
                self.logger.info(f"[{service.name}] Restart succeeded")
                return True
            else:
                self.logger.error(
                    f"[{service.name}] Restart failed (exit {result.returncode}): {result.stderr.strip()}"
                )
                return False
        except subprocess.TimeoutExpired:
            self.logger.error(f"[{service.name}] Restart command timed out (60s)")
            return False
        except Exception as e:
            self.logger.error(f"[{service.name}] Restart error: {e}")
            return False

    def diagnose_with_llm(self, service: ServiceState) -> str | None:
        """
        Call a cheap LLM to diagnose why a service keeps failing.
        Returns diagnosis text or None if LLM is disabled/unavailable.
        """
        if not self.llm_enabled:
            return None

        api_key_env = self.llm_config.get("api_key_env", "LLM_API_KEY")
        api_key = os.environ.get(api_key_env)
        if not api_key:
            return None

        provider = self.llm_config.get("provider", "anthropic")
        model = self.llm_config.get("model", "claude-haiku-4-20250514")

        prompt = (
            f"A service called '{service.name}' has failed {service.consecutive_failures} "
            f"health checks in a row. The health endpoint is {service.health_url}. "
            f"The last error was: {service.last_error}. "
            f"It has been restarted {len(service.restart_timestamps)} times recently. "
            f"What are the most likely causes and what should I check? Be concise (3-5 lines)."
        )

        try:
            if provider == "anthropic":
                url = "https://api.anthropic.com/v1/messages"
                data = json.dumps({
                    "model": model,
                    "max_tokens": 256,
                    "messages": [{"role": "user", "content": prompt}]
                }).encode()
                req = urllib.request.Request(url, data=data, method="POST")
                req.add_header("Content-Type", "application/json")
                req.add_header("x-api-key", api_key)
                req.add_header("anthropic-version", "2023-06-01")
            elif provider == "openai":
                url = "https://api.openai.com/v1/chat/completions"
                data = json.dumps({
                    "model": model,
                    "max_tokens": 256,
                    "messages": [{"role": "user", "content": prompt}]
                }).encode()
                req = urllib.request.Request(url, data=data, method="POST")
                req.add_header("Content-Type", "application/json")
                req.add_header("Authorization", f"Bearer {api_key}")
            else:
                return None

            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read())
                if provider == "anthropic":
                    return body["content"][0]["text"]
                else:
                    return body["choices"][0]["message"]["content"]

        except Exception as e:
            self.logger.warning(f"LLM diagnosis failed: {e}")
            return None

    def run_once(self):
        """Perform one round of health checks on all services."""
        for name, svc in self.services.items():
            healthy, error = self.check_health(svc)

            if healthy:
                if not svc.healthy:
                    self.logger.info(f"[{name}] Recovered after {svc.consecutive_failures} failures")
                svc.record_success()
                continue

            # Service is unhealthy
            svc.record_failure(error)
            self.logger.warning(
                f"[{name}] Health check failed ({svc.consecutive_failures}x): {error}"
            )

            # Check flap detection
            if svc.is_flapping(self.flap_threshold, self.flap_window):
                self.logger.error(
                    f"[{name}] FLAPPING — {len(svc.restart_timestamps)} restarts in "
                    f"{self.flap_window}s window. Backing off. Manual intervention needed."
                )
                # Try LLM diagnosis on flapping services
                if svc.consecutive_failures == self.flap_threshold:
                    diagnosis = self.diagnose_with_llm(svc)
                    if diagnosis:
                        self.logger.info(f"[{name}] LLM diagnosis: {diagnosis}")
                continue

            # Check backoff timer
            wait = svc.time_until_next_restart()
            if wait > 0:
                self.logger.debug(f"[{name}] Backoff: {wait:.0f}s remaining before next restart")
                continue

            # Attempt restart
            success = self.restart_service(svc)
            svc.record_restart()
            svc.bump_backoff()

            if not success and svc.consecutive_failures >= 3:
                diagnosis = self.diagnose_with_llm(svc)
                if diagnosis:
                    self.logger.info(f"[{name}] LLM diagnosis: {diagnosis}")

    def run_forever(self):
        """Main loop: check, sleep, repeat."""
        self.logger.info(
            f"Sentinel started — monitoring {len(self.services)} services, "
            f"check interval {self.check_interval}s"
        )
        for name in self.services:
            self.logger.info(f"  - {name}: {self.services[name].health_url}")

        try:
            while True:
                self.run_once()
                time.sleep(self.check_interval)
        except KeyboardInterrupt:
            self.logger.info("Sentinel stopped (keyboard interrupt)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def load_config(path: str) -> dict:
    """Load and validate the YAML config file."""
    config_path = Path(path)
    if not config_path.exists():
        print(f"Config file not found: {path}", file=sys.stderr)
        sys.exit(1)

    with open(config_path) as f:
        config = yaml.safe_load(f)

    if not config:
        print("Config file is empty", file=sys.stderr)
        sys.exit(1)

    if "services" not in config or not config["services"]:
        print("Config must define at least one service under 'services:'", file=sys.stderr)
        sys.exit(1)

    for name, svc in config["services"].items():
        if "health_url" not in svc:
            print(f"Service '{name}' missing required field 'health_url'", file=sys.stderr)
            sys.exit(1)

    return config


def main():
    parser = argparse.ArgumentParser(
        description="Sentinel Daemon — monitor and restart services",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example config (sentinel.yaml):

  check_interval: 30
  log_file: logs/sentinel.log
  flap_threshold: 5
  flap_window: 300

  services:
    my-api:
      health_url: http://localhost:8080/health
      restart_command: "systemctl restart my-api"
      initial_backoff: 5
      max_backoff: 300
      timeout: 10
        """
    )
    parser.add_argument(
        "--config", "-c",
        required=True,
        help="Path to sentinel YAML config file"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one check cycle and exit"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check health but don't actually restart anything"
    )

    args = parser.parse_args()
    config = load_config(args.config)

    daemon = SentinelDaemon(config, dry_run=args.dry_run)

    if args.once:
        daemon.run_once()
    else:
        daemon.run_forever()


if __name__ == "__main__":
    main()

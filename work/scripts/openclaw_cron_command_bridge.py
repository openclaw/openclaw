#!/usr/bin/env python3
"""Deterministic command bridge for OpenClaw cron-owned local automations.

This keeps scheduled script work out of model prompts. Each recipe is explicit,
shell-free, and bounded so cron can execute the intended local command directly.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
KALSHI_ROOT = REPO_ROOT / "work" / "scripts" / "kalshi"
YOUTUBE_AUTOMATION = REPO_ROOT / "youtube-v1" / "scripts" / "youtube-v1-automation.mjs"
TAIL_CHARS = 6000


@dataclass(frozen=True)
class Step:
    label: str
    argv: tuple[str, ...]
    cwd: Path
    timeout_seconds: int = 180
    stop_after_lock_skip: bool = False


@dataclass(frozen=True)
class Recipe:
    description: str
    steps: tuple[Step, ...]
    run_dashboard_after_success: bool = False


def _python(script_name: str, *args: str, timeout_seconds: int = 180, label: str | None = None) -> Step:
    return Step(
        label=label or script_name,
        argv=(sys.executable, str(KALSHI_ROOT / script_name), *args),
        cwd=KALSHI_ROOT,
        timeout_seconds=timeout_seconds,
    )


def _learning_step(script_name: str, *args: str, timeout_seconds: int = 600) -> Step:
    return Step(
        label=script_name,
        argv=(sys.executable, str(KALSHI_ROOT / script_name), *args),
        cwd=KALSHI_ROOT,
        timeout_seconds=timeout_seconds,
        stop_after_lock_skip=True,
    )


def _youtube(command: str, *args: str, timeout_seconds: int = 300) -> Step:
    node = shutil.which("node") or "/opt/homebrew/bin/node"
    return Step(
        label=f"youtube-v1 {command}",
        argv=(node, str(YOUTUBE_AUTOMATION), command, *args),
        cwd=REPO_ROOT,
        timeout_seconds=timeout_seconds,
    )


RECIPES: dict[str, Recipe] = {
    "kalshi-position-exposure-compact-audit": Recipe(
        description="Compact paper-only exposure, risk, outcome, and live-readiness monitoring for Kalshi.",
        steps=(
            _python(
                "kalshi_position_exposure_audit.py",
                "--top-categories",
                "20",
                timeout_seconds=180,
            ),
        ),
    ),
    "kalshi-weather-outcome-resolver": Recipe(
        description="Scores settled weather paper trades and validates the outcome log.",
        steps=(
            _python(
                "kalshi_weather_outcome_resolver.py",
                "--decisions-log",
                str(KALSHI_ROOT / "logs" / "paper_decisions.jsonl"),
                "--max-decisions",
                "1000",
                timeout_seconds=240,
            ),
            _python("kalshi_outcome_log.py", timeout_seconds=120),
        ),
    ),
    "kalshi-evidence-gate-audit": Recipe(
        description="Audits paper evidence validators and live-readiness blockers.",
        steps=(
            _python("kalshi_outcome_log.py", timeout_seconds=120),
            _python("kalshi_risk_controller.py", timeout_seconds=120),
            _python("kalshi_live_readiness_gate.py", timeout_seconds=120),
            _python("kalshi_validate_no_live_trading.py", timeout_seconds=120),
        ),
    ),
    "kalshi-historical-research-batch": Recipe(
        description="Runs bounded read-only historical research to generate forward-paper hypotheses.",
        steps=(
            _python(
                "kalshi_research_batch.py",
                "--limit",
                "200",
                "--max-pages",
                "1",
                "--minimum-records",
                "100",
                "--minimum-test-trades",
                "30",
                timeout_seconds=900,
            ),
        ),
    ),
    "kalshi-clean-paper-evidence-flywheel": Recipe(
        description="Paper-only general Kalshi learning cycle with dashboard refresh after successful work.",
        steps=(
            _learning_step(
                "kalshi_scheduled_learning.py",
                "--observe-limit",
                "30",
                "--max-orderbooks",
                "15",
                "--focused-watchlist",
                "--max-watchlist-markets",
                "35",
                "--max-auto-candidates",
                "18",
                timeout_seconds=1200,
            ),
        ),
        run_dashboard_after_success=True,
    ),
    "kalshi-strategy-improvement-loop": Recipe(
        description="Runs paper-only self-improvement, scorecard, and learner updates.",
        steps=(
            _python("kalshi_self_improvement.py", timeout_seconds=120),
            _python("kalshi_strategy_scorecard.py", timeout_seconds=120),
            _python("kalshi_paper_strategy_learner.py", timeout_seconds=120),
        ),
    ),
    "kalshi-opportunity-scan": Recipe(
        description="Runs paper-only shadow, inverse, and opportunity diagnostics.",
        steps=(
            _python("kalshi_shadow_score.py", timeout_seconds=120),
            _python("kalshi_inverse_strategy_audit.py", timeout_seconds=120),
            _python("kalshi_opportunity_engine.py", timeout_seconds=120),
        ),
    ),
    "kalshi-weather-evidence-flywheel": Recipe(
        description="Paper-only weather evidence cycle with dashboard refresh after successful work.",
        steps=(
            _learning_step(
                "kalshi_weather_learning_cycle.py",
                "--limit",
                "30",
                "--max-series",
                "20",
                "--max-source-markets",
                "10",
                "--max-paper-candidates",
                "10",
                "--skip-cache-warmup",
                "--stale-lock-seconds",
                "240",
                timeout_seconds=600,
            ),
        ),
        run_dashboard_after_success=True,
    ),
    "youtube-v1-daily-trend-loop": Recipe(
        description="Generates the daily Pattern Lab trend report.",
        steps=(_youtube("daily", timeout_seconds=300),),
    ),
    "youtube-v1-launch-package-refresh": Recipe(
        description="Refreshes the launch package for the first Pattern Lab video.",
        steps=(_youtube("next", "01", timeout_seconds=300),),
    ),
    "youtube-v1-weekly-planning-loop": Recipe(
        description="Generates the weekly Pattern Lab production plan.",
        steps=(_youtube("weekly", timeout_seconds=300),),
    ),
    "youtube-v1-health-check": Recipe(
        description="Checks whether the YouTube V1 automation outputs are present and validated.",
        steps=(_youtube("health", timeout_seconds=300),),
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def tail(value: str) -> str:
    if len(value) <= TAIL_CHARS:
        return value
    return value[-TAIL_CHARS:]


def parse_json_object(text: str) -> dict[str, Any] | None:
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def looks_like_expected_lock_skip(step: Step, parsed: dict[str, Any] | None, stdout: str) -> bool:
    if not step.stop_after_lock_skip:
        return False
    status = parsed.get("status") if parsed else None
    if status == "SKIPPED_LOCK_ACTIVE":
        return True
    return "SKIPPED_LOCK_ACTIVE" in stdout or "learning lock is active" in stdout


def run_step(step: Step) -> dict[str, Any]:
    proc = subprocess.run(
        list(step.argv),
        cwd=str(step.cwd),
        env={
            **os.environ,
            "PATH": f"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{os.environ.get('PATH', '')}",
        },
        text=True,
        capture_output=True,
        timeout=step.timeout_seconds,
        check=False,
    )
    parsed = parse_json_object(proc.stdout)
    skipped = looks_like_expected_lock_skip(step, parsed, proc.stdout)
    return {
        "label": step.label,
        "argv": list(step.argv),
        "cwd": str(step.cwd),
        "returncode": proc.returncode,
        "ok": proc.returncode == 0,
        "expected_lock_skip": skipped,
        "stdout_tail": tail(proc.stdout).strip(),
        "stderr_tail": tail(proc.stderr).strip(),
        "json_summary": parsed,
    }


def run_recipe(name: str) -> int:
    recipe = RECIPES[name]
    steps: list[dict[str, Any]] = []
    ok = True
    skipped = False
    for step in recipe.steps:
        result = run_step(step)
        steps.append(result)
        if result["expected_lock_skip"]:
            skipped = True
            break
        if not result["ok"]:
            ok = False
            break

    if ok and not skipped and recipe.run_dashboard_after_success:
        result = run_step(_python("kalshi_dashboard.py", timeout_seconds=180, label="kalshi_dashboard.py"))
        steps.append(result)
        if not result["ok"]:
            ok = False

    envelope = {
        "ok": ok,
        "skipped": skipped,
        "skip_reason": "expected learning lock active" if skipped else None,
        "job": name,
        "description": recipe.description,
        "mode": "PAPER_ONLY_OR_READ_ONLY",
        "live_trading_enabled": False,
        "timestamp_utc": utc_now(),
        "steps": steps,
    }
    print(json.dumps(envelope, indent=2, sort_keys=True))
    return 0 if ok else 1


def validate_recipe(name: str) -> dict[str, Any]:
    recipe = RECIPES[name]
    checks = []
    ok = True
    for step in recipe.steps:
        executable = Path(step.argv[0])
        exists = executable.exists() if executable.is_absolute() else shutil.which(step.argv[0]) is not None
        script_paths = [Path(arg) for arg in step.argv[1:] if arg.startswith(str(REPO_ROOT))]
        missing_scripts = [str(path) for path in script_paths if not path.exists()]
        item_ok = bool(exists) and not missing_scripts and step.cwd.exists()
        checks.append(
            {
                "label": step.label,
                "executable": step.argv[0],
                "executable_found": bool(exists),
                "cwd": str(step.cwd),
                "cwd_found": step.cwd.exists(),
                "missing_scripts": missing_scripts,
                "ok": item_ok,
            }
        )
        ok = ok and item_ok
    return {"job": name, "description": recipe.description, "ok": ok, "checks": checks}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a named OpenClaw cron command recipe.")
    parser.add_argument("job", nargs="?", choices=sorted(RECIPES))
    parser.add_argument("--list", action="store_true", help="List available recipes.")
    parser.add_argument("--validate", action="store_true", help="Validate recipe executables and script paths.")
    parser.add_argument("--validate-all", action="store_true", help="Validate all recipes.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.list:
        print(json.dumps({name: recipe.description for name, recipe in sorted(RECIPES.items())}, indent=2))
        return 0
    if args.validate_all:
        results = [validate_recipe(name) for name in sorted(RECIPES)]
        print(json.dumps({"ok": all(item["ok"] for item in results), "recipes": results}, indent=2))
        return 0 if all(item["ok"] for item in results) else 1
    if not args.job:
        build_parser().error("job is required unless --list or --validate-all is used")
    if args.validate:
        result = validate_recipe(args.job)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1
    return run_recipe(args.job)


if __name__ == "__main__":
    raise SystemExit(main())

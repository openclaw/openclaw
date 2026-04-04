#!/usr/bin/env python3
"""
CI Metrics Collector — tracks pass rate, mean time to green, failure trends.
Run: python3 workspace/tools/ci-dashboard/collect-metrics.py
"""
import subprocess, json, sys, os
from datetime import datetime, timedelta

REPO = "tangcruz/clawd"
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "metrics.json")

def get_runs(limit=100):
    """Fetch recent workflow runs via gh CLI."""
    try:
        result = subprocess.run(
            ["gh", "run", "list", "--repo", REPO, "--limit", str(limit),
             "--json", "status,conclusion,name,createdAt,updatedAt,headBranch"],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return []
        return json.loads(result.stdout)
    except Exception:
        return []

def calculate_metrics(runs):
    """Calculate CI health metrics."""
    completed = [r for r in runs if r.get("status") == "completed"]
    if not completed:
        return {"error": "no completed runs"}

    # Pass rate
    successes = sum(1 for r in completed if r.get("conclusion") == "success")
    failures = sum(1 for r in completed if r.get("conclusion") == "failure")
    skipped = sum(1 for r in completed if r.get("conclusion") == "skipped")
    total = len(completed)

    # Per-workflow breakdown
    by_workflow = {}
    for r in completed:
        name = r.get("name", "unknown")
        if name not in by_workflow:
            by_workflow[name] = {"success": 0, "failure": 0, "skipped": 0, "total": 0}
        by_workflow[name]["total"] += 1
        conclusion = r.get("conclusion", "unknown")
        if conclusion in by_workflow[name]:
            by_workflow[name][conclusion] += 1

    # Calculate pass rates per workflow
    for name, stats in by_workflow.items():
        non_skipped = stats["total"] - stats["skipped"]
        stats["pass_rate"] = round(stats["success"] / non_skipped * 100, 1) if non_skipped > 0 else 0

    return {
        "collected_at": datetime.utcnow().isoformat() + "Z",
        "total_runs": total,
        "successes": successes,
        "failures": failures,
        "skipped": skipped,
        "overall_pass_rate": round(successes / (total - skipped) * 100, 1) if (total - skipped) > 0 else 0,
        "by_workflow": by_workflow,
    }

def main():
    runs = get_runs()
    metrics = calculate_metrics(runs)

    with open(OUTPUT, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"CI Metrics collected: {metrics.get('total_runs', 0)} runs")
    print(f"Overall pass rate: {metrics.get('overall_pass_rate', 0)}%")
    print(f"Saved to: {OUTPUT}")

if __name__ == "__main__":
    main()

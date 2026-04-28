#!/usr/bin/env python3
import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def load_payload(payload_file: str | None) -> dict | None:
    if not payload_file:
        return None

    with open(payload_file, "r", encoding="utf-8") as handle:
        return json.load(handle)


def build_request(
    kind: str,
    output_path: str | None,
    request_id: str | None,
    days_back: int | None,
    max_results: int | None,
    scopes: list[str] | None,
    request_payload: dict | None,
) -> dict:
    rid = request_id or f"{kind}-{uuid.uuid4().hex[:12]}"
    request = {
        "requestId": rid,
        "kind": kind,
        "createdAtUtc": utc_now_iso(),
        "status": "pending",
    }
    if output_path:
        request["outputPath"] = output_path
    if days_back is not None:
        request["daysBack"] = days_back
    if max_results is not None:
        request["maxResults"] = max_results
    if scopes:
        request["scopes"] = scopes
    if request_payload is not None:
        request["payload"] = request_payload
    return request


def main() -> int:
    parser = argparse.ArgumentParser(description="Enqueue a Windows bridge request and optionally wait for the result.")
    parser.add_argument("kind", choices=["capability-probe", "dotnet-info", "outlook-job-signal-scan", "graph-auth-status", "graph-auth-login", "graph-mail-job-signal-scan", "sketchup-poc-action"])
    parser.add_argument("--queue-root", default="/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/queue")
    parser.add_argument("--output-path")
    parser.add_argument("--request-id")
    parser.add_argument("--days-back", type=int)
    parser.add_argument("--max-results", type=int)
    parser.add_argument("--scope", action="append", dest="scopes")
    parser.add_argument("--payload-file")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=60)
    args = parser.parse_args()

    queue_root = Path(args.queue_root)
    inbound = queue_root / "inbound"
    outbound = queue_root / "outbound"
    inbound.mkdir(parents=True, exist_ok=True)
    outbound.mkdir(parents=True, exist_ok=True)

    request_payload = load_payload(args.payload_file)
    request = build_request(args.kind, args.output_path, args.request_id, args.days_back, args.max_results, args.scopes, request_payload)
    request_id = request["requestId"]
    request_path = inbound / f"{request_id}.json"
    result_path = outbound / f"{request_id}.result.json"

    with request_path.open("w", encoding="utf-8") as f:
        json.dump(request, f, indent=2)
        f.write("\n")

    response = {
        "requestId": request_id,
        "requestPath": str(request_path),
        "resultPath": str(result_path),
        "waited": False,
        "result": None,
    }

    if args.wait:
        deadline = time.time() + args.timeout_seconds
        while time.time() < deadline:
            if result_path.exists():
                with result_path.open("r", encoding="utf-8") as f:
                    response["result"] = json.load(f)
                response["waited"] = True
                print(json.dumps(response, indent=2))
                return 0
            time.sleep(1)

        response["waited"] = True
        response["error"] = {
            "message": f"Timed out waiting for result file: {result_path}",
            "type": "TimeoutError",
        }
        print(json.dumps(response, indent=2))
        return 2

    print(json.dumps(response, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

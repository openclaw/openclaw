#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

QUEUE_ROOT = Path('/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/queue')
RUNNER_PATH = Path('/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/windows-helper/runner.ps1')
POWERSHELL = 'pwsh'


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description='Enqueue, trigger Windows helper RunOnce, and wait for result.')
    parser.add_argument('kind', choices=['capability-probe', 'dotnet-info', 'outlook-job-signal-scan', 'graph-auth-status', 'graph-auth-login', 'graph-mail-job-signal-scan', 'sketchup-poc-action'])
    parser.add_argument('--output-path')
    parser.add_argument('--request-id')
    parser.add_argument('--days-back', type=int)
    parser.add_argument('--max-results', type=int)
    parser.add_argument('--scope', action='append', dest='scopes')
    parser.add_argument('--payload-file')
    parser.add_argument('--timeout-seconds', type=int, default=90)
    parser.add_argument('--queue-root', default=str(QUEUE_ROOT))
    parser.add_argument('--runner-path', default=str(RUNNER_PATH))
    args = parser.parse_args()

    queue_root = Path(args.queue_root)
    request_id = args.request_id or f"{args.kind}-{uuid4().hex[:12]}"

    enqueue_cmd = [
        sys.executable,
        str(Path('/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/scripts/enqueue-bridge-request.py')),
        args.kind,
        '--queue-root', str(queue_root),
        '--request-id', request_id,
    ]
    if args.output_path:
        enqueue_cmd.extend(['--output-path', args.output_path])
    if args.days_back is not None:
        enqueue_cmd.extend(['--days-back', str(args.days_back)])
    if args.max_results is not None:
        enqueue_cmd.extend(['--max-results', str(args.max_results)])
    if args.scopes:
        for scope in args.scopes:
            enqueue_cmd.extend(['--scope', scope])
    if args.payload_file:
        enqueue_cmd.extend(['--payload-file', args.payload_file])

    enqueue_proc = run(enqueue_cmd)
    if enqueue_proc.returncode != 0:
        print(json.dumps({
            'status': 'failed',
            'step': 'enqueue',
            'returncode': enqueue_proc.returncode,
            'stdout': enqueue_proc.stdout,
            'stderr': enqueue_proc.stderr,
        }, indent=2))
        return enqueue_proc.returncode

    runner_cmd = [
        POWERSHELL,
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', str(Path(args.runner_path)),
        '-QueueRoot', str(queue_root),
        '-RunOnce',
    ]

    runner_proc = run(runner_cmd)
    if runner_proc.returncode != 0:
        print(json.dumps({
            'status': 'failed',
            'step': 'runner',
            'requestId': request_id,
            'returncode': runner_proc.returncode,
            'stdout': runner_proc.stdout,
            'stderr': runner_proc.stderr,
        }, indent=2))
        return runner_proc.returncode

    result_path = queue_root / 'outbound' / f'{request_id}.result.json'
    deadline = time.time() + args.timeout_seconds
    while time.time() < deadline:
        if result_path.exists():
            result = json.loads(result_path.read_text(encoding='utf-8'))
            print(json.dumps({
                'status': 'succeeded',
                'requestId': request_id,
                'resultPath': str(result_path),
                'result': result,
                'runner': {
                    'stdout': runner_proc.stdout,
                    'stderr': runner_proc.stderr,
                }
            }, indent=2))
            return 0
        time.sleep(1)

    print(json.dumps({
        'status': 'failed',
        'step': 'wait-result',
        'requestId': request_id,
        'resultPath': str(result_path),
        'error': {
            'message': f'Timed out waiting for result file: {result_path}',
            'type': 'TimeoutError'
        },
        'runner': {
            'stdout': runner_proc.stdout,
            'stderr': runner_proc.stderr,
        }
    }, indent=2))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())

import json
import urllib.request
import base64
import time
import sys
from datetime import datetime, timezone

BASE_URL = "http://localhost:8080"

def log_step(step):
    print(f"\n[STEP] {step}")

def send_command(transcript):
    log_step(f"Sending command: '{transcript}'")
    # Fake audio base64
    fake_audio = base64.b64encode(b"fake audio data").decode("utf-8")
    
    payload = {
        "audio_data": fake_audio,
        "format": "m4a",
        "client_timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "transcript": transcript
    }
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{BASE_URL}/api/v1/watch/command", data=data)
    req.add_header("Content-Type", "application/json")
    
    with urllib.request.urlopen(req) as response:
        resp_data = response.read()
        resp_json = json.loads(resp_data)
        print(f"Response: {resp_json.get('summary_text')}")
        return resp_json

def check_job_status(job_id):
    log_step(f"Checking status for job: {job_id}")
    req = urllib.request.Request(f"{BASE_URL}/api/v1/jobs/{job_id}/summarize", method="POST")
    with urllib.request.urlopen(req) as response:
        resp_data = response.read()
        resp_json = json.loads(resp_data)
        print(f"Status: {resp_json.get('status')} - Summary: {resp_json.get('summary')}")
        return resp_json

def test_deploy_flow():
    print("\n=== TESTING DEPLOY FLOW ===")
    resp = send_command("Deploy main branch to production")
    job_id = resp.get("job_id")
    if job_id:
        time.sleep(1)
        check_job_status(job_id)

def test_pr_review_flow():
    print("\n=== TESTING PR REVIEW FLOW ===")
    resp = send_command("Review PR #42 and approve if tests passed")
    job_id = resp.get("job_id")
    if job_id:
        time.sleep(1)
        check_job_status(job_id)

def test_incident_triage_flow():
    print("\n=== TESTING INCIDENT TRIAGE FLOW ===")
    resp = send_command("Triage the high CPU incident on the database")
    job_id = resp.get("job_id")
    if job_id:
        time.sleep(1)
        check_job_status(job_id)

def test_offline_retry_mechanism():
    print("\n=== TESTING OFFLINE RETRY MECHANISM ===")
    log_step("Simulating Offline state in WatchSessionManager")
    # In a real app, WCSession.isReachable would be false.
    # Here we simulate the queuing logic.
    queued_commands = []
    
    def queue_command(transcript):
        print(f"Watch: Offline. Queuing command: '{transcript}'")
        queued_commands.append(transcript)
    
    queue_command("Fix the broken build")
    
    log_step("Simulating Online state and processing queue")
    if queued_commands:
        print(f"Watch: Back online. Processing {len(queued_commands)} commands.")
        for cmd in queued_commands:
            send_command(cmd)

def main():
    try:
        test_deploy_flow()
        test_pr_review_flow()
        test_incident_triage_flow()
        test_offline_retry_mechanism()
        print("\n[SUCCESS] All demo flows and offline mechanism tests completed.")
    except urllib.error.HTTPError as e:
        print(f"\n[ERROR] Test failed with HTTP {e.code}: {e.read().decode()}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] Test failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

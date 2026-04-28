import json
import urllib.request
import base64
import time
import sys
from datetime import datetime, timezone

BASE_URL = "http://localhost:8080"

def log_step(step):
    print(f"\n[STEP] {step}")

def send_command(transcript, audio_data=None):
    log_step(f"Sending command: '{transcript}'")
    # Fake audio base64 if not provided
    fake_audio = audio_data or base64.b64encode(b"fake audio data").decode("utf-8")
    
    payload = {
        "audio_data": fake_audio,
        "format": "m4a",
        "client_timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "transcript": transcript
    }
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{BASE_URL}/api/v1/watch/command", data=data)
    req.add_header("Content-Type", "application/json")
    
    try:
        with urllib.request.urlopen(req) as response:
            resp_data = response.read()
            resp_json = json.loads(resp_data)
            print(f"Response: {resp_json.get('summary_text')}")
            return resp_json
    except Exception as e:
        print(f"Error sending command: {e}")
        return None

def check_job_status(job_id):
    log_step(f"Checking status for job: {job_id}")
    req = urllib.request.Request(f"{BASE_URL}/api/v1/jobs/{job_id}/summarize", method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            resp_data = response.read()
            resp_json = json.loads(resp_data)
            print(f"Status: {resp_json.get('status')} - Summary: {resp_json.get('summary')}")
            return resp_json
    except Exception as e:
        print(f"Error checking status: {e}")
        return None

def run_flow(name, transcript):
    print(f"\n=== TESTING {name} FLOW ===")
    resp = send_command(transcript)
    if not resp:
        return
    job_id = resp.get("job_id")
    if job_id:
        time.sleep(1)
        check_job_status(job_id)

def test_offline_retry():
    print("\n=== TESTING OFFLINE RETRY MECHANISM ===")
    log_step("Simulating Offline state in WatchSessionManager")
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
    print("iOS Simulator Script (Watch Ceviz)")
    print("-------------------------------")
    
    run_flow("DEPLOY", "Deploy main branch to production")
    run_flow("PR REVIEW", "Review PR #42 and approve if tests passed")
    run_flow("INCIDENT TRIAGE", "Triage the high CPU incident on the database")
    
    test_offline_retry()
    
    print("\n--- All tests completed. ---")

if __name__ == "__main__":
    main()

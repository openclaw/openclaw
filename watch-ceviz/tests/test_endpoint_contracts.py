import copy
import json
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib import request

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from stt import TranscriptionResult  # noqa: E402


class EndpointContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_jobs_db = copy.deepcopy(main.jobs_db)
        main.jobs_db.update({
            "job-101": {
                "id": "job-101",
                "name": "Ongoing Task",
                "status": "running",
                "created_at": main.time.time(),
                "elapsed_seconds": 15,
                "category": "Genel",
                "canned_result": "Processing...",
                "watch_summary": "Görev devam ediyor.",
                "phone_report": "Details will follow.",
                "transcript": "durum nedir",
                "stt_source": "openai",
                "stt_error": "",
                "next_action": None,
            },
            "job-102": {
                "id": "job-102",
                "name": "Recent Code Fix",
                "status": "completed",
                "created_at": 0,
                "elapsed_seconds": 45,
                "category": "Yazılım / Kod",
                "canned_result": "Bug fixed.",
                "watch_summary": "Hata giderildi.",
                "phone_report": "Fixed indentation in main.py",
                "transcript": "hatayı çöz",
                "stt_source": "openai",
                "stt_error": "",
                "next_action": "Telefonda son kontrol yap.",
            }
        })
        self.server = main.HTTPServer(("127.0.0.1", 0), main.WatchCevizHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        main.jobs_db.clear()
        main.jobs_db.update(self.original_jobs_db)

    def _get_json(self, path: str) -> tuple[int, dict]:
        with request.urlopen(f"{self.base_url}{path}") as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def _post_json(self, path: str, payload: dict) -> tuple[int, dict]:
        req = request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def _post(self, path: str, body: bytes | None = None, headers: dict | None = None) -> tuple[int, dict]:
        req = request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers or {},
            method="POST",
        )
        with request.urlopen(req) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_active_jobs_response_matches_contract_and_embeds_structured_fields(self) -> None:
        main.jobs_db["job-active-handoff"] = {
            "id": "job-active-handoff",
            "name": "Deploy Failure",
            "status": "completed",
            "created_at": 0,
            "elapsed_seconds": 19,
            "category": "DevOps",
            "canned_result": "fallback",
            "watch_summary": "Deploy tamamlanmadı.",
            "phone_report": "ERROR: deploy failed\nTraceback\nline 42",
            "transcript": "deploy durumunu özetle",
            "stt_source": "client",
            "stt_error": "",
            "next_action": None,
        }

        status, payload = self._get_json("/api/v1/jobs/active")

        self.assertEqual(status, 200)
        self.assertEqual(main.validate_payload(payload, main.load_contract("active-jobs-response.schema.json")), [])
        self.assertGreaterEqual(len(payload["jobs"]), 2)

        completed_job = next(job for job in payload["jobs"] if job["id"] == "job-102")
        self.assertEqual(completed_job["report_meta"]["category"], "Yazılım / Kod")
        self.assertEqual(completed_job["preview_sections"][0]["id"], "category")
        self.assertIn("watch-summary", [section["id"] for section in completed_job["preview_sections"]])

        running_job = next(job for job in payload["jobs"] if job["id"] == "job-101")
        self.assertIn("summarize-progress", [action["id"] for action in running_job["next_actions"]])
        self.assertIn("cancel-job", [action["id"] for action in running_job["next_actions"]])

        handoff_job = next(job for job in payload["jobs"] if job["id"] == "job-active-handoff")
        self.assertEqual(handoff_job["deep_link"], "ceviz://job/job-active-handoff")
        self.assertTrue(handoff_job["requires_phone_handoff"])
        self.assertEqual([action["id"] for action in handoff_job["next_actions"]], [
            "open-on-phone",
        ])

    def test_job_report_response_matches_contract_with_full_section_shape(self) -> None:
        main.jobs_db["job-contract"] = {
            "id": "job-contract",
            "name": "Calendar Follow-up",
            "status": "completed",
            "created_at": 0,
            "elapsed_seconds": 18,
            "category": "Takvim / Program",
            "canned_result": "Takvim özeti oluşturuldu.",
            "watch_summary": "Toplantı özeti hazır.",
            "requires_phone_handoff": True,
            "phone_report": "1. Kısa durum\nToplantı notları derlendi.",
            "transcript": "yarınki toplantıyı özetle",
            "stt_source": "client",
            "stt_error": "",
            "next_action": "Telefonda katılımcı listesini kontrol et.",
        }

        status, payload = self._get_json("/api/v1/jobs/job-contract/report")

        self.assertEqual(status, 200)
        self.assertEqual(main.validate_payload(payload, main.load_contract("job-report-response.schema.json")), [])
        self.assertEqual(payload["job_id"], "job-contract")
        self.assertEqual(payload["deep_link"], "ceviz://job/job-contract")
        self.assertEqual(payload["handoff_reason"], "action_required")
        self.assertEqual(payload["report_meta"]["category"], "Takvim / Program")
        self.assertEqual(payload["report_meta"]["status"], "completed")
        self.assertEqual([section["id"] for section in payload["report_sections"]], [
            "watch-summary",
            "expanded-analysis",
            "suggested-next-action",
        ])
        self.assertEqual([section["id"] for section in payload["preview_sections"]], [
            "category",
            "watch-summary",
            "suggested-next-action",
        ])

    def test_summarize_response_for_completed_job_keeps_watch_friendly_shape(self) -> None:
        main.jobs_db["job-summary-ok"] = {
            "id": "job-summary-ok",
            "name": "Quick Reply",
            "status": "completed",
            "created_at": 0,
            "elapsed_seconds": 24,
            "category": "Mesaj / Yanıt",
            "canned_result": "Taslak hazır.",
            "watch_summary": "Mesaj özeti hazır.",
            "requires_phone_handoff": False,
            "phone_report": "Kısa yanıt taslağı oluşturuldu.",
            "transcript": "mesajı özetle",
            "next_action": "İstersen gönderimden önce telefonda son kontrol yap.",
        }

        status, payload = self._post("/api/v1/jobs/job-summary-ok/summarize")

        self.assertEqual(status, 200)
        self.assertEqual(main.validate_payload(payload, main.load_contract("job-summary-response.schema.json")), [])
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["summary"], "Mesaj özeti hazır.")
        self.assertFalse(payload["requires_phone_handoff"])
        self.assertNotIn("handoff_url", payload)
        self.assertEqual(payload["transcript"], "mesajı özetle")
        self.assertEqual(payload["report_meta"]["category"], "Mesaj / Yanıt")
        self.assertEqual([section["id"] for section in payload["preview_sections"]], [
            "category",
            "watch-summary",
            "suggested-next-action",
        ])

    def test_summarize_response_adds_handoff_url_for_running_job_with_phone_handoff(self) -> None:
        main.jobs_db["job-summary-handoff"] = {
            "id": "job-summary-handoff",
            "name": "Noisy Voice Command",
            "status": "running",
            "created_at": main.time.time(),
            "elapsed_seconds": 5,
            "category": "OpenClaw Asistan",
            "canned_result": "İşleniyor.",
            "watch_summary": "Ses alındı ama komut netleşmedi.",
            "requires_phone_handoff": False,
            "phone_report": "Telefonda hata notu gösterilecek.",
            "transcript": "",
            "stt_error": "Arka plan gürültüsü yüzünden komut ayrışmadı",
            "next_action": "Telefonda hata detayını aç.",
        }

        status, payload = self._post("/api/v1/jobs/job-summary-handoff/summarize")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "running")
        self.assertTrue(payload["requires_phone_handoff"])
        self.assertEqual(payload["deep_link"], "ceviz://job/job-summary-handoff")
        self.assertEqual(payload["handoff_url"], "ceviz://job/job-summary-handoff")
        self.assertEqual(payload["report_meta"]["requires_phone_handoff"], True)
        self.assertEqual([action["id"] for action in payload["next_actions"]], [
            "open-on-phone",
            "summarize-progress",
            "cancel-job",
            "suggested-next-action",
        ])
        self.assertIn("sn)", payload["summary"])

    def test_report_and_summarize_share_same_structured_report_fields_for_existing_job(self) -> None:
        main.jobs_db["job-shared-shape"] = {
            "id": "job-shared-shape",
            "name": "Shared Shape Check",
            "status": "completed",
            "created_at": 0,
            "elapsed_seconds": 12,
            "category": "Takvim / Program",
            "canned_result": "Takvim özeti oluşturuldu.",
            "watch_summary": "Toplantı özeti hazır.",
            "requires_phone_handoff": True,
            "phone_report": "Toplantı notları ve katılımcılar derlendi.",
            "transcript": "yarınki toplantıyı özetle",
            "next_action": "Telefonda katılımcı listesini kontrol et.",
        }

        _, report_payload = self._get_json("/api/v1/jobs/job-shared-shape/report")
        _, summarize_payload = self._post("/api/v1/jobs/job-shared-shape/summarize")
        expected = main.build_structured_report_fields(main.jobs_db["job-shared-shape"])

        self.assertEqual(report_payload["report_meta"], expected["report_meta"])
        self.assertEqual(report_payload["preview_sections"], expected["preview_sections"])
        self.assertEqual(summarize_payload["report_meta"], expected["report_meta"])
        self.assertEqual(summarize_payload["preview_sections"], expected["preview_sections"])

    def test_report_endpoint_escalates_long_detail_to_phone_handoff_even_without_explicit_flag(self) -> None:
        main.jobs_db["job-long-detail"] = {
            "id": "job-long-detail",
            "name": "Incident Digest",
            "status": "completed",
            "created_at": 0,
            "elapsed_seconds": 33,
            "category": "Operasyon",
            "canned_result": "fallback",
            "watch_summary": "Kısa özet hazır.",
            "phone_report": "Detay " * 60,
            "transcript": "incident özetle",
            "stt_source": "client",
            "stt_error": "",
            "next_action": None,
        }

        status, payload = self._get_json("/api/v1/jobs/job-long-detail/report")

        self.assertEqual(status, 200)
        self.assertTrue(payload["requires_phone_handoff"])
        self.assertEqual(payload["handoff_reason"], "long_detail")
        self.assertEqual(payload["deep_link"], "ceviz://job/job-long-detail")
        self.assertEqual(payload["report_meta"]["requires_phone_handoff"], True)

    def test_summarize_response_for_missing_job_returns_missing_fallback_shape(self) -> None:
        status, payload = self._post("/api/v1/jobs/job-missing/summarize")

        self.assertEqual(status, 200)
        self.assertEqual(main.validate_payload(payload, main.load_contract("job-summary-response.schema.json")), [])
        self.assertEqual(payload["status"], "missing")
        self.assertEqual(payload["summary"], "Job job-missing bulunamadı.")
        self.assertTrue(payload["requires_phone_handoff"])
        self.assertNotIn("handoff_url", payload)
        self.assertEqual(payload["transcript"], "")
        self.assertEqual(payload["phone_report"], "")
        self.assertIsNotNone(payload["report_meta"])
        self.assertEqual(payload["report_meta"]["status"], "failed")
        self.assertEqual([section["id"] for section in payload["preview_sections"]], [
            "category",
            "watch-summary",
            "suggested-next-action",
        ])

    def test_watch_command_response_matches_contract_and_exposes_handoff_shape(self) -> None:
        fake_invocation = SimpleNamespace(
            process=mock.Mock(),
            log_path="/tmp/fake-watch-job.log",
            prompt="test prompt",
            command=["openclaw", "agent"],
            started_at=123.0,
        )

        with mock.patch.object(
            main.stt_client,
            "transcribe_watch_payload",
            return_value=TranscriptionResult(transcript="", source="none", error="OPENAI_API_KEY tanımlı değil"),
        ), mock.patch.object(
            main.openclaw_client,
            "invoke_watch_command",
            return_value=fake_invocation,
        ):
            status, payload = self._post_json(
                "/api/v1/watch/command",
                {
                    "audio_data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                    "format": "aac",
                    "client_timestamp": "2026-04-10T19:30:00Z",
                },
            )

        self.assertEqual(status, 200)
        self.assertEqual(main.validate_payload(payload, main.load_contract("watch-command-response.schema.json")), [])
        self.assertEqual(payload["status"], "processing")
        self.assertTrue(payload["requires_phone_handoff"])
        self.assertTrue(payload["deep_link"].startswith("ceviz://job/"))
        self.assertEqual(payload["handoff_url"], payload["deep_link"])
        self.assertEqual(payload["report_meta"]["requires_phone_handoff"], True)
        self.assertEqual([section["id"] for section in payload["preview_sections"]], [
            "category",
            "watch-summary",
            "suggested-next-action",
        ])


if __name__ == "__main__":
    unittest.main()

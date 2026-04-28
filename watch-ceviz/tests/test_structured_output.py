import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from openclaw_client import OpenClawClient  # noqa: E402


class OpenClawClientStructuredOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = OpenClawClient(runtime_dir=tempfile.mkdtemp())

    def _write_log(self, text: str) -> str:
        payload = {
            "result": {
                "payloads": [
                    {"text": text},
                ]
            }
        }
        handle = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8")
        json.dump(payload, handle, ensure_ascii=False)
        handle.close()
        return handle.name

    def test_extract_result_prefers_structured_blocks(self) -> None:
        text = """
<watch_ceviz_phone_report>
1. Kısa durum
PR #42 incelendi ve risk görülmedi.
2. Ne anlaşıldı / sınırlama
Sadece verilen diff değerlendirildi.
3. Önerilen sonraki adım
PR #42 için merge akışına geç.
</watch_ceviz_phone_report>
<watch_ceviz_meta>
{"watch_summary":"PR #42 hazır, telefonda son kontrol yap.","next_action":"PR #42 için merge akışına geç.","requires_phone_handoff":true,"category":"Yazılım / Kod"}
</watch_ceviz_meta>
        """.strip()

        result = self.client.extract_result(self._write_log(text))

        self.assertEqual(result.category, "Yazılım / Kod")
        self.assertEqual(result.watch_summary, "PR #42 hazır, telefonda son kontrol yap.")
        self.assertTrue(result.requires_phone_handoff)
        self.assertIn("PR #42 incelendi", result.phone_report)
        self.assertEqual(result.next_action, "PR #42 için merge akışına geç.")

    def test_extract_result_falls_back_when_meta_is_missing(self) -> None:
        text = """
1. Kısa durum
Takvim notu hazır.
2. Ne anlaşıldı / sınırlama
Toplantı başlığı net ama katılımcılar belirsiz.
3. Önerilen sonraki adım
Takvim etkinliğini telefonda açıp katılımcıları kontrol et.
        """.strip()

        result = self.client.extract_result(self._write_log(text))

        self.assertEqual(result.category, "Takvim / Program")
        self.assertIn("Takvim notu hazır.", result.phone_report)
        self.assertEqual(result.next_action, "Takvim etkinliğini telefonda açıp katılımcıları kontrol et.")
        self.assertTrue(result.requires_phone_handoff)
        self.assertIn("Takvim notu hazır", result.watch_summary)


class ReportBuilderTests(unittest.TestCase):
    def test_build_report_meta_normalizes_core_fields(self) -> None:
        job = {
            "name": "Code Review",
            "status": "completed",
            "category": "Yazılım / Kod",
            "watch_summary": "Özet tamam.   ",
            "requires_phone_handoff": False,
            "phone_report": "  Ayrıntılı rapor burada.  ",
            "next_action": "Telefonda son kontrolü yap.",
            "canned_result": "fallback",
        }

        meta = main.build_report_meta(job)

        self.assertEqual(meta["title"], "Code Review")
        self.assertEqual(meta["status"], "completed")
        self.assertEqual(meta["severity"], "low")
        self.assertEqual(meta["category"], "Yazılım / Kod")
        self.assertEqual(meta["watch_summary"], "Özet tamam.")
        self.assertFalse(meta["requires_phone_handoff"])
        self.assertIsNone(meta["handoff_reason"])
        self.assertEqual(meta["phone_report"], "Ayrıntılı rapor burada.")
        self.assertEqual(meta["next_action"], "Telefonda son kontrolü yap.")

    def test_build_report_sections_excludes_category_and_uses_completed_fallbacks(self) -> None:
        job = {
            "name": "Code Review",
            "status": "completed",
            "elapsed_seconds": 42,
            "category": "Yazılım / Kod",
            "watch_summary": "Saat özeti hazır.",
            "phone_report": "Detaylı analiz burada.",
            "next_action": None,
            "canned_result": "fallback",
        }

        sections = main.build_report_sections(job)

        self.assertEqual([section["id"] for section in sections], [
            "watch-summary",
            "expanded-analysis",
            "suggested-next-action",
        ])
        self.assertEqual(sections[1]["content"], "Detaylı analiz burada.")
        self.assertIn("telefonda devam et", sections[2]["content"].lower())

    def test_build_report_sections_failed_job_uses_failure_fallbacks(self) -> None:
        job = {
            "name": "Outlook Triage",
            "status": "failed",
            "elapsed_seconds": 17,
            "category": "E-posta İşlemleri",
            "watch_summary": "",
            "phone_report": "",
            "next_action": None,
            "canned_result": "",
            "stt_error": "Arka plan gürültüsü yüzünden komut ayrışmadı",
        }

        sections = main.build_report_sections(job)
        by_id = {section["id"]: section for section in sections}

        self.assertEqual(by_id["expanded-analysis"]["content"], "Görev tamamlanamadı, ayrıntı bulunamadı.")
        self.assertIn("yeniden dene", by_id["suggested-next-action"]["content"].lower())

    def test_build_preview_sections_keeps_only_preview_items_and_trims(self) -> None:
        long_category = "Kategori " + ("çok uzun " * 20)
        long_summary = "Özet " + ("uzun içerik " * 20)
        long_next_action = "Sonraki adım " + ("telefonda devam et " * 20)
        job = {
            "name": "Long Report",
            "status": "completed",
            "category": long_category,
            "watch_summary": long_summary,
            "phone_report": "Detaylı rapor",
            "next_action": long_next_action,
            "canned_result": "fallback",
        }

        sections = main.build_preview_sections(job)

        self.assertEqual([section["id"] for section in sections], [
            "category",
            "watch-summary",
            "suggested-next-action",
        ])
        self.assertLessEqual(len(sections[0]["content"]), 80)
        self.assertLessEqual(len(sections[1]["content"]), 120)
        self.assertLessEqual(len(sections[2]["content"]), 120)
        self.assertNotIn("expanded-analysis", [section["id"] for section in sections])

    def test_build_structured_report_fields_uses_shared_report_meta_and_preview_shapes(self) -> None:
        job = {
            "name": "Calendar Follow-up",
            "status": "completed",
            "category": "Takvim / Program",
            "watch_summary": "Toplantı özeti hazır.",
            "requires_phone_handoff": True,
            "phone_report": "Toplantı notları ve katılımcılar derlendi.",
            "next_action": "Telefonda katılımcı listesini kontrol et.",
            "canned_result": "fallback",
        }

        structured = main.build_structured_report_fields(job)

        self.assertEqual(list(structured.keys()), ["report_meta", "preview_sections"])
        self.assertEqual(list(structured["report_meta"].keys()), list(main.REPORT_META_FIELDS))
        self.assertEqual([section["id"] for section in structured["preview_sections"]], list(main.PREVIEW_SECTION_IDS))
        self.assertTrue(all(list(section.keys()) == list(main.SECTION_FIELDS) for section in structured["preview_sections"]))

    def test_classify_handoff_reason_detects_logs_without_explicit_flag(self) -> None:
        job = {
            "name": "Deploy Failure",
            "status": "completed",
            "category": "DevOps",
            "watch_summary": "Deploy tamamlanmadı.",
            "phone_report": "ERROR: deploy failed\nTraceback\nline 42\nstdout: retry budget exhausted",
            "next_action": None,
            "canned_result": "fallback",
        }

        self.assertEqual(main.build_handoff_reason(job), "logs_and_code")
        self.assertTrue(main.derive_job_handoff(job))

    def test_classify_handoff_reason_detects_low_confidence(self) -> None:
        job = {
            "name": "Ambiguous Summary",
            "status": "completed",
            "category": "OpenClaw Asistan",
            "watch_summary": "İki yorum arasında kaldım.",
            "phone_report": "Çıktı kısa ama güven düşük.",
            "confidence": 0.31,
            "next_action": None,
            "canned_result": "fallback",
        }

        self.assertEqual(main.build_handoff_reason(job), "low_confidence")
        self.assertTrue(main.derive_job_handoff(job))

    def test_build_next_actions_merges_explicit_actions_with_open_on_phone(self) -> None:
        job = {
            "id": "job-merge-actions",
            "name": "PR Review",
            "status": "completed",
            "category": "Yazılım / Kod",
            "watch_summary": "PR hazır.",
            "requires_phone_handoff": True,
            "phone_report": "Kısa rapor ama telefonda devam et.",
            "next_action": "Telefonda son kontrolü yap.",
            "next_actions": [
                {"id": "approve", "label": "Approve PR", "kind": "api_call", "target": "/approve/pr/42"},
                {"id": "copy-link", "label": "Copy Link", "kind": "copy", "target": "https://example.test/pr/42"},
            ],
            "canned_result": "fallback",
        }

        actions = main.build_next_actions(job)

        self.assertEqual([action["id"] for action in actions], [
            "open-on-phone",
            "approve",
            "copy-link",
            "suggested-next-action",
        ])

    def test_build_next_actions_adds_runtime_api_actions_for_running_jobs(self) -> None:
        job = {
            "id": "job-running-actions",
            "name": "Windows Build",
            "status": "running",
            "category": "Build",
            "watch_summary": "Build sürüyor.",
            "transcript": "build durumunu özetle",
            "requires_phone_handoff": False,
            "phone_report": "Derleme devam ediyor.",
            "next_action": None,
            "canned_result": "fallback",
        }

        actions = main.build_next_actions(job)

        self.assertEqual([action["id"] for action in actions], [
            "summarize-progress",
            "cancel-job",
        ])
        self.assertEqual(actions[0]["kind"], "api_call")
        self.assertEqual(actions[0]["target"], "/api/v1/jobs/job-running-actions/summarize")
        self.assertEqual(actions[1]["target"], "/api/v1/jobs/job-running-actions/cancel")


class PayloadValidationTests(unittest.TestCase):
    def test_validate_payload_rejects_nested_extra_fields(self) -> None:
        schema = main.load_contract("watch-command-response.schema.json")
        payload = {
            "status": "processing",
            "transcript": "komut",
            "summary_text": "İşleniyor.",
            "requires_phone_handoff": True,
            "report_meta": {
                "title": "İşleniyor",
                "status": "processing",
                "severity": "medium",
                "category": "OpenClaw Asistan",
                "watch_summary": "İşleniyor.",
                "requires_phone_handoff": True,
                "handoff_reason": "needs_clarification",
                "phone_report": "Detay telefonda.",
                "next_action": None,
                "unexpected": "x",
            },
            "preview_sections": [
                {
                    "id": "category",
                    "title": "Kategori",
                    "eyebrow": "Durum",
                    "icon": "folder",
                    "content": "OpenClaw Asistan",
                    "extra": "x",
                }
            ],
        }

        errors = main.validate_payload(payload, schema)

        self.assertIn("Unexpected field: report_meta.unexpected", errors)
        self.assertIn("Unexpected field: preview_sections[0].extra", errors)

    def test_validate_payload_rejects_invalid_nested_section_enum_from_allof_ref(self) -> None:
        schema = main.load_contract("job-report-response.schema.json")
        payload = {
            "job_id": "job-1",
            "status": "completed",
            "report_title": "Rapor",
            "report_content": "İçerik",
            "report_sections": [
                {
                    "id": "category",
                    "title": "Kategori",
                    "eyebrow": "Durum",
                    "icon": "folder",
                    "content": "Takvim / Program",
                }
            ],
            "preview_sections": [
                {
                    "id": "category",
                    "title": "Kategori",
                    "eyebrow": "Durum",
                    "icon": "folder",
                    "content": "Takvim / Program",
                }
            ],
            "report_meta": {
                "title": "Rapor",
                "status": "completed",
                "severity": "low",
                "category": "Takvim / Program",
                "watch_summary": "Hazır.",
                "requires_phone_handoff": False,
                "handoff_reason": None,
                "phone_report": "Detaylı rapor",
                "next_action": None,
            },
        }

        errors = main.validate_payload(payload, schema)

        self.assertIn("Invalid enum value for report_sections[0].id: category", errors)


if __name__ == "__main__":
    unittest.main()

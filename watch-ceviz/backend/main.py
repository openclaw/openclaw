import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import time
import uuid

logging.basicConfig(level=logging.INFO)

CONTRACTS_DIR = Path(__file__).resolve().parents[1] / "contracts"

# Dynamic job store for real OpenClaw processes
jobs_db = {}

from openclaw_client import OpenClawClient
from stt import WatchSTT

openclaw_client = OpenClawClient()
stt_client = WatchSTT()


def load_contract(name: str) -> dict:
    with (CONTRACTS_DIR / name).open("r") as f:
        return json.load(f)


def _schema_pointer(schema: dict, ref: str) -> dict:
    if not ref.startswith("#/"):
        raise ValueError(f"Unsupported schema ref: {ref}")

    node: dict | list = schema
    for part in ref[2:].split("/"):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(f"Schema ref not found: {ref}")
        node = node[part]

    if not isinstance(node, dict):
        raise ValueError(f"Schema ref does not resolve to an object schema: {ref}")
    return node


def _matches_type(value, expected_type: str) -> bool:
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "null":
        return value is None
    return True


def _validate_against_schema(value, schema_node: dict, root_schema: dict, path: str) -> list[str]:
    errors: list[str] = []

    if "$ref" in schema_node:
        return _validate_against_schema(value, _schema_pointer(root_schema, schema_node["$ref"]), root_schema, path)

    if "allOf" in schema_node:
        for part in schema_node["allOf"]:
            errors.extend(_validate_against_schema(value, part, root_schema, path))
        return errors

    expected_type = schema_node.get("type")
    if isinstance(expected_type, list):
        if not any(_matches_type(value, type_name) for type_name in expected_type):
            errors.append(f"Invalid type for {path}, expected one of {expected_type}")
            return errors
    elif isinstance(expected_type, str) and not _matches_type(value, expected_type):
        errors.append(f"Invalid type for {path}, expected {expected_type}")
        return errors

    if "enum" in schema_node and value not in schema_node["enum"]:
        errors.append(f"Invalid enum value for {path}: {value}")

    if isinstance(value, dict):
        properties = schema_node.get("properties", {})
        required = schema_node.get("required", [])

        for req in required:
            if req not in value:
                errors.append(f"Missing required field: {path}.{req}" if path else f"Missing required field: {req}")

        if schema_node.get("additionalProperties") is False:
            for prop in value:
                if prop not in properties:
                    errors.append(f"Unexpected field: {path}.{prop}" if path else f"Unexpected field: {prop}")

        for prop, prop_schema in properties.items():
            if prop in value:
                child_path = f"{path}.{prop}" if path else prop
                errors.extend(_validate_against_schema(value[prop], prop_schema, root_schema, child_path))

    if isinstance(value, list) and "items" in schema_node:
        item_schema = schema_node["items"]
        for index, item in enumerate(value):
            errors.extend(_validate_against_schema(item, item_schema, root_schema, f"{path}[{index}]"))

    return errors


def validate_payload(payload: dict, schema: dict) -> list[str]:
    return _validate_against_schema(payload, schema, schema, "")


def trim_watch_text(text: str, max_len: int = 200) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 1].rstrip() + "…"


PHONE_HANDOFF_DETAIL_THRESHOLD = 140
PHONE_HANDOFF_ACTION_LIMIT = 3
LOW_CONFIDENCE_THRESHOLD = 0.55
CODE_OR_LOG_MARKERS = (
    "```",
    "traceback",
    "exception",
    "stack trace",
    "diff --git",
    "stderr",
    "stdout",
    "error:",
    "warn:",
    "info:",
    "log:",
    "logs:",
    "[error]",
    "[warn]",
    "[info]",
)
APPROVAL_MARKERS = (
    "onay",
    "approve",
    "approval",
    "izin gerekiyor",
    "requires approval",
)


def clean_text(value: str | None) -> str:
    return (value or "").strip()


def has_code_or_logs(text: str) -> bool:
    lowered = clean_text(text).lower()
    if not lowered:
        return False

    if any(marker in lowered for marker in CODE_OR_LOG_MARKERS):
        return True

    return any(token in lowered for token in (".py:", ".ts:", ".cs:", "line ", "stack", "terminal"))


def get_explicit_next_actions(job: dict) -> list[dict[str, str | None]]:
    raw_actions = job.get("next_actions")
    if not isinstance(raw_actions, list):
        return []

    normalized: list[dict[str, str | None]] = []
    for index, action in enumerate(raw_actions, start=1):
        if not isinstance(action, dict):
            continue

        label = clean_text(action.get("label") or action.get("title") or action.get("id") or f"Action {index}")
        kind = clean_text(action.get("kind") or "hint")
        action_id = clean_text(action.get("id") or f"action-{index}")
        target = clean_text(action.get("target")) or None

        normalized.append({
            "id": action_id,
            "label": trim_watch_text(label, max_len=80),
            "kind": kind,
            "target": target,
        })

    return normalized


def requires_phone_approval(job: dict) -> bool:
    if bool(job.get("requires_approval")) or bool(job.get("approval_required")):
        return True

    text_fragments = [
        clean_text(job.get("next_action")),
        clean_text(job.get("phone_report")),
        clean_text(job.get("canned_result")),
    ]
    text_fragments.extend(
        filter(
            None,
            [
                clean_text(action.get("label"))
                for action in get_explicit_next_actions(job)
            ],
        )
    )
    combined = " ".join(text_fragments).lower()
    return any(marker in combined for marker in APPROVAL_MARKERS)


def classify_handoff_reason(job: dict) -> str | None:
    status = clean_text(job.get("status")).lower()
    transcript = clean_text(job.get("transcript"))
    detail = clean_text(job.get("phone_report") or job.get("canned_result"))
    watch_summary = clean_text(job.get("watch_summary"))
    stt_error = clean_text(job.get("stt_error"))
    explicit_requires_handoff = job.get("requires_phone_handoff")
    explicit_actions = get_explicit_next_actions(job)
    confidence = job.get("confidence")
    low_confidence = bool(job.get("low_confidence"))

    if status == "failed":
        return "failure_diagnosis"

    if stt_error or (status in {"running", "processing"} and not transcript):
        return "needs_clarification"

    if requires_phone_approval(job):
        return "approval_required"

    if len(explicit_actions) > PHONE_HANDOFF_ACTION_LIMIT:
        return "too_many_actions"

    if low_confidence:
        return "low_confidence"

    if isinstance(confidence, (int, float)) and confidence < LOW_CONFIDENCE_THRESHOLD:
        return "low_confidence"

    if has_code_or_logs(detail):
        return "logs_and_code"

    if len(detail) > PHONE_HANDOFF_DETAIL_THRESHOLD or len(watch_summary) > 200:
        return "long_detail"

    if explicit_requires_handoff is True and clean_text(job.get("next_action")):
        return "action_required"

    if explicit_requires_handoff is True:
        return "phone_review"

    return None


def build_processing_summary(stt_source: str, transcript: str, stt_error: str | None = None) -> str:
    transcript = (transcript or "").strip()
    stt_error = (stt_error or "").strip()

    if transcript:
        transcript_preview = trim_watch_text(f'"{transcript}"', max_len=96)
        if stt_source == "openai":
            return trim_watch_text(f"Komut alındı: {transcript_preview}. İşleniyor.")
        return trim_watch_text(f"Transkript alındı: {transcript_preview}. İşleniyor.")

    if stt_error:
        return trim_watch_text("Ses alındı ama komut netleşmedi. Telefonda ayrıntı ve yeniden deneme önerisi var.")

    return "Ses alındı. Komut işleniyor."


def derive_job_handoff(job: dict) -> bool:
    return classify_handoff_reason(job) is not None


def build_job_watch_summary(job: dict) -> str:
    status = job.get("status")
    if status == "running":
        base = job.get("watch_summary") or f"{job.get('name', 'Görev')} işleniyor."
        return trim_watch_text(f"{base} ({job.get('elapsed_seconds', 0)} sn)")
    if status == "failed":
        stt_error = (job.get("stt_error") or "").strip()
        if stt_error:
            return trim_watch_text(f"Komut netleşmedi: {stt_error}")
        return trim_watch_text(job.get("watch_summary") or "Görev tamamlanamadı. Telefonda ayrıntı var.")
    return trim_watch_text(job.get("watch_summary") or job.get("canned_result") or "Sonuç hazır.")


REPORT_META_FIELDS = (
    "title",
    "status",
    "severity",
    "category",
    "watch_summary",
    "requires_phone_handoff",
    "handoff_reason",
    "phone_report",
    "next_action",
    "retry_count",
    "failure_code",
    "failure_message",
)

SECTION_FIELDS = (
    "id",
    "title",
    "eyebrow",
    "icon",
    "content",
)

PREVIEW_SECTION_IDS = (
    "category",
    "watch-summary",
    "suggested-next-action",
)


def build_handoff_deep_link(job_id: str | None) -> str | None:
    cleaned = (job_id or "").strip()
    if not cleaned:
        return None
    return f"ceviz://job/{cleaned}"


def derive_job_severity(job: dict) -> str:
    status = (job.get("status") or "").strip().lower()
    if status == "failed":
        return "high"
    if status == "running":
        return "medium"
    return "low"


def build_handoff_reason(job: dict) -> str | None:
    return classify_handoff_reason(job)


def build_handoff_copy(job: dict) -> str | None:
    reason = build_handoff_reason(job)
    if not reason:
        return None

    if reason == "needs_clarification":
        return "Komut net değil. Telefonda ayrıntı ve yeniden deneme var."
    if reason == "failure_diagnosis":
        return "Sorun ayrıntılı görünüyor. Loglar ve sonraki adım telefonda."
    if reason == "approval_required":
        return "Onay gerekiyor. Telefonda devam etmek daha güvenli."
    if reason == "too_many_actions":
        return "Birden fazla aksiyon var. Telefonda seçim yapmak daha güvenli."
    if reason == "low_confidence":
        return "Yanıt güveni düşük. Telefonda ayrıntı ve yönlendirme var."
    if reason == "logs_and_code":
        return "Kod veya log var. Telefonda açıp inceleyelim."
    if reason == "action_required":
        return "Devam etmek için telefonda onay veya seçim gerekiyor."
    if reason == "long_detail":
        return "Detay uzun. Telefonda daha rahat inceleyebilirsin."
    if reason == "job_missing":
        return "Görev bulunamadı. Telefonda tekrar deneyebilirsin."
    return "Detay telefonda daha net."


def build_next_actions(job: dict) -> list[dict[str, str | None]]:
    actions: list[dict[str, str | None]] = []
    seen: set[tuple[str, str | None, str]] = set()
    job_id = clean_text(job.get("id"))
    deep_link = build_handoff_deep_link(job_id)
    next_action = clean_text(job.get("next_action"))
    status = clean_text(job.get("status")).lower()

    def append_action(action: dict[str, str | None]) -> None:
        key = (action["kind"] or "", action.get("target"), action["label"] or "")
        if key in seen:
            return
        seen.add(key)
        actions.append(action)

    if derive_job_handoff(job) and deep_link:
        append_action({
            "id": "open-on-phone",
            "label": "Open on Phone",
            "kind": "deeplink",
            "target": deep_link,
        })

    if job_id and status in {"running", "queued"}:
        append_action({
            "id": "summarize-progress",
            "label": "Summarize Progress",
            "kind": "api_call",
            "target": f"/api/v1/jobs/{job_id}/summarize",
        })
        append_action({
            "id": "cancel-job",
            "label": "Stop Job",
            "kind": "api_call",
            "target": f"/api/v1/jobs/{job_id}/cancel",
        })

    for action in get_explicit_next_actions(job):
        append_action(action)

    if next_action:
        append_action({
            "id": "suggested-next-action",
            "label": trim_watch_text(next_action, max_len=80),
            "kind": "hint",
            "target": None,
        })

    return actions


def build_report_meta(job: dict) -> dict:
    meta = {
        "title": (job.get("name") or "OpenClaw Task").strip(),
        "status": (job.get("status") or "unknown").strip(),
        "severity": derive_job_severity(job),
        "category": (job.get("category") or "OpenClaw Asistan").strip(),
        "watch_summary": build_job_watch_summary(job),
        "requires_phone_handoff": derive_job_handoff(job),
        "handoff_reason": build_handoff_reason(job),
        "phone_report": (job.get("phone_report") or "").strip(),
        "next_action": job.get("next_action") or None,
        "retry_count": job.get("retry_count") or 0,
        "failure_code": job.get("failure_code") or None,
        "failure_message": job.get("failure_message") or None,
    }
    return {field: meta[field] for field in REPORT_META_FIELDS}


def build_section(*, section_id: str, title: str, eyebrow: str, icon: str, content: str) -> dict[str, str]:
    section = {
        "id": section_id,
        "title": title,
        "eyebrow": eyebrow,
        "icon": icon,
        "content": content,
    }
    return {field: section[field] for field in SECTION_FIELDS}


def build_structured_report_fields(job: dict) -> dict:
    return {
        "report_meta": build_report_meta(job),
        "preview_sections": build_preview_sections(job),
    }


def build_common_sections(job: dict) -> list[dict[str, str]]:
    report_meta = build_report_meta(job)
    watch_summary = report_meta["watch_summary"]
    detail = (job.get("phone_report") or job.get("canned_result") or "").strip()

    if job["status"] == "running":
        analysis_content = (
            "Görev şu anda OpenClaw üzerinde işleniyor. "
            f"Geçen süre: {job['elapsed_seconds']} saniye. Yenile ile güncel durumu çekebilirsin."
        )
        next_action_content = "Biraz bekleyip bu ekranı yenile, ardından güncellenen raporu telefonda incele."
    elif job["status"] == "failed":
        analysis_content = detail or "Görev tamamlanamadı, ayrıntı bulunamadı."
        next_action_content = (
            job.get("next_action")
            or "Hata detayını kontrol et, sonra saatten yeniden dene veya komutu daha net söyleyip tekrar gönder."
        )
    else:
        analysis_content = detail or "Sonuç verisi bulunamadı."
        next_action_content = (
            job.get("next_action")
            or (
                "Saat özetini hızlı sonuç olarak kullan, gerekiyorsa aşağıdaki ayrıntılı analize göre telefonda devam et."
                if watch_summary
                else "Aşağıdaki ayrıntılı sonuca göre telefonda devam et."
            )
        )

    sections: list[dict[str, str]] = []

    category = report_meta["category"]
    if category:
        sections.append(build_section(
            section_id="category",
            title="Category",
            eyebrow="META",
            icon="tag",
            content=category,
        ))

    if watch_summary:
        sections.append(build_section(
            section_id="watch-summary",
            title="Watch summary",
            eyebrow="WATCH",
            icon="applewatch",
            content=watch_summary,
        ))

    sections.append(build_section(
        section_id="expanded-analysis",
        title="Expanded analysis",
        eyebrow="IPHONE DETAIL",
        icon="text.alignleft",
        content=analysis_content,
    ))

    sections.append(build_section(
        section_id="suggested-next-action",
        title="Suggested next action",
        eyebrow="NEXT",
        icon="arrow.forward.circle",
        content=next_action_content,
    ))

    return sections


def build_report_sections(job: dict) -> list[dict[str, str]]:
    return [
        section
        for section in build_common_sections(job)
        if section["id"] != "category"
    ]


def build_preview_sections(job: dict) -> list[dict[str, str]]:
    common_sections = build_common_sections(job)
    sections = [
        {
            **section,
            "content": trim_watch_text(section["content"], max_len=80 if section["id"] == "category" else 120),
        }
        for section in common_sections
        if section["id"] in PREVIEW_SECTION_IDS
    ]

    if sections:
        return sections

    analysis_section = next((section for section in common_sections if section["id"] == "expanded-analysis"), None)
    if analysis_section:
        return [{
            **analysis_section,
            "content": trim_watch_text(analysis_section["content"], max_len=120),
        }]

    return [build_section(
        section_id="capture",
        title="Capture",
        eyebrow="WATCH",
        icon="waveform.badge.mic",
        content="Transcript unavailable",
    )]



def build_job_report(job: dict) -> tuple[str, str]:
    report_meta = build_report_meta(job)
    category_text = f"[{report_meta['category']}]"
    watch_summary = report_meta["watch_summary"]
    requires_phone_handoff = report_meta["requires_phone_handoff"]
    transcript = (job.get("transcript") or "").strip() or "Yok"
    stt_source = job.get("stt_source") or "unknown"
    stt_error = (job.get("stt_error") or "").strip()

    meta_lines = [
        f"Kategori: {category_text}",
        f"Saat özeti: {watch_summary}",
        f"Telefona devret: {'Evet' if requires_phone_handoff else 'Hayır'}",
        f"Transkript: {transcript}",
        f"STT kaynağı: {stt_source}",
    ]
    if stt_error:
        meta_lines.append(f"STT notu: {stt_error}")

    if job["status"] == "running":
        return (
            f"Görev Çalışıyor: {job['name']}",
            "\n".join(meta_lines)
            + f"\n\nGörev şu anda OpenClaw üzerinde işleniyor...\nGeçen süre: {job['elapsed_seconds']} saniye.\n\nLütfen güncel durumu görmek için Yenile butonuna dokunun.",
        )

    if job["status"] == "failed":
        detail = job.get("phone_report") or job.get("canned_result") or "Hata detayı bulunamadı."
        return (
            f"Hata: {job['name']}",
            "\n".join(meta_lines)
            + "\n\nDetay:\n"
            + detail
            + f"\n\nİşlem süresi: {job['elapsed_seconds']} saniye.",
        )

    detail = job.get("phone_report") or job.get("canned_result") or "Sonuç verisi bulunamadı."
    return (
        f"Rapor: {job['name']}",
        "\n".join(meta_lines)
        + "\n\nİşlem Sonucu:\n"
        + detail
        + f"\n\nİşlem süresi: {job['elapsed_seconds']} saniye.\n\nNot: Bu rapor backend üzerinden gerçek OpenClaw CLI çağrısının çıktısından üretildi.",
    )


def sync_job_status(job: dict) -> None:
    now = time.time()
    job["elapsed_seconds"] = max(0, int(now - job["created_at"]))
    invocation = job.get("invocation")
    if not invocation or job["status"] not in {"running", "processing"}:
        if job["status"] == "running" and job["elapsed_seconds"] >= 10 and "invocation" not in job:
            job["status"] = "completed"
        return

    process = invocation["process"]
    return_code = process.poll()
    if return_code is None:
        job["status"] = "running"
        return

    if return_code == 0:
        try:
            result = openclaw_client.extract_result(invocation["log_path"])
            job["status"] = "completed"
            job["category"] = result.category
            job["canned_result"] = result.canned_result
            job["watch_summary"] = result.watch_summary
            job["requires_phone_handoff"] = result.requires_phone_handoff
            job["phone_report"] = result.phone_report
            job["next_action"] = result.next_action
        except Exception as exc:
            logging.exception("Failed to parse OpenClaw result for job %s", job["id"])
            job["status"] = "failed"
            job["category"] = "OpenClaw Hatası"
            job["canned_result"] = (
                "OpenClaw çağrısı tamamlandı ama yanıt çözümlenemedi.\n\n"
                f"Hata: {exc}\n\n"
                f"Log özeti:\n{openclaw_client.read_log_tail(invocation['log_path'])}"
            )
        return

    job["status"] = "failed"
    job["category"] = "OpenClaw Hatası"
    job["canned_result"] = (
        f"OpenClaw komutu {return_code} koduyla başarısız oldu.\n\n"
        f"Log özeti:\n{openclaw_client.read_log_tail(invocation['log_path'])}"
    )


class WatchCevizHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/v1/jobs/active":
            active_jobs = []
            for jid, job in list(jobs_db.items()):
                sync_job_status(job)
                structured_fields = build_structured_report_fields(job)
                deep_link = build_handoff_deep_link(job["id"]) if derive_job_handoff(job) else None
                active_jobs.append({
                    "id": job["id"],
                    "name": job["name"],
                    "status": job["status"],
                    "elapsed_seconds": job["elapsed_seconds"],
                    "summary_text": build_job_watch_summary(job),
                    "requires_phone_handoff": derive_job_handoff(job),
                    "transcript": (job.get("transcript") or "").strip(),
                    "phone_report": job.get("phone_report") or "",
                    "next_actions": build_next_actions(job),
                    **structured_fields,
                    **({"deep_link": deep_link} if deep_link else {}),
                })

            resp_payload = {
                "jobs": active_jobs
            }

            resp_schema = load_contract("active-jobs-response.schema.json")
            resp_errors = validate_payload(resp_payload, resp_schema)
            if resp_errors:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Response validation failed", "details": resp_errors}).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp_payload).encode("utf-8"))
        elif self.path.startswith("/api/v1/jobs/") and self.path.endswith("/report"):
            job_id = self.path.split("/")[4]
            now = time.time()

            job = jobs_db.get(job_id)
            if not job:
                job = {
                    "id": job_id,
                    "name": "Unknown Task",
                    "status": "completed",
                    "created_at": now - 30,
                    "elapsed_seconds": 30,
                    "category": "Bilinmeyen",
                    "canned_result": "Detay bulunamadı.",
                    "watch_summary": "Görev bulunamadı.",
                    "requires_phone_handoff": True,
                    "phone_report": "Detay bulunamadı.",
                    "transcript": "",
                    "stt_source": "unknown",
                    "stt_error": "",
                    "next_action": None,
                }
            else:
                sync_job_status(job)

            report_title, report_content = build_job_report(job)
            structured_fields = build_structured_report_fields(job)
            deep_link = build_handoff_deep_link(job_id) if derive_job_handoff(job) else None
            resp_payload = {
                "job_id": job_id,
                "status": job["status"],
                "report_title": report_title,
                "report_content": report_content,
                "report_sections": build_report_sections(job),
                "watch_summary": build_job_watch_summary(job),
                "requires_phone_handoff": derive_job_handoff(job),
                "handoff_reason": build_handoff_reason(job),
                "next_action": job.get("next_action") or None,
                "next_actions": build_next_actions(job),
                **structured_fields,
            }
            if deep_link:
                resp_payload["deep_link"] = deep_link

            resp_schema = load_contract("job-report-response.schema.json")
            resp_errors = validate_payload(resp_payload, resp_schema)
            if resp_errors:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Response validation failed", "details": resp_errors}).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp_payload).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error": "Not found"}')

    def do_POST(self):
        import traceback
        try:
            self._do_POST_impl()
        except Exception as e:
            print(f"ERROR: {e}", flush=True)
            traceback.print_exc()
            self.send_response(500)
            self.end_headers()
    def _do_POST_impl(self):
        if self.path.startswith("/api/v1/jobs/") and self.path.endswith("/cancel"):
            job_id = self.path.split("/")[4]
            job = jobs_db.get(job_id)
            if job:
                sync_job_status(job)
                invocation = job.get("invocation")
                if invocation and invocation["process"].poll() is None:
                    invocation["process"].terminate()
                    job["status"] = "failed"
                    job["canned_result"] = "Görev kullanıcı tarafından iptal edildi."

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "cancelled", "job_id": job_id}).encode("utf-8"))
            return
        elif self.path.startswith("/api/v1/jobs/") and self.path.endswith("/summarize"):
            job_id = self.path.split("/")[4]
            job = jobs_db.get(job_id)
            if not job:
                summary = f"Job {job_id} bulunamadı."
                requires_phone_handoff = True
                handoff_url = None
                deep_link = None
                job_status = "missing"
                handoff_reason = "job_missing"
                next_actions = []
            else:
                sync_job_status(job)
                summary = build_job_watch_summary(job)
                requires_phone_handoff = derive_job_handoff(job)
                deep_link = build_handoff_deep_link(job_id) if requires_phone_handoff else None
                handoff_url = deep_link
                job_status = job.get("status", "unknown")
                structured_fields = build_structured_report_fields(job)
                handoff_reason = build_handoff_reason(job)
                next_actions = build_next_actions(job)
                report_meta = structured_fields["report_meta"]
                preview_sections = structured_fields["preview_sections"]

            response_payload = {
                "summary": summary,
                "requires_phone_handoff": requires_phone_handoff,
                "status": job_status,
                "transcript": (job.get("transcript") or "").strip() if job else "",
                "phone_report": (job.get("phone_report") or "") if job else "",
                "handoff_reason": handoff_reason,
                "next_actions": next_actions,
                "report_meta": report_meta if job else build_report_meta({
                    "status": "failed",
                    "category": "OpenClaw Asistan",
                    "watch_summary": summary,
                    "phone_report": summary,
                    "name": "Unknown Task"
                }),
                "preview_sections": preview_sections if job else build_preview_sections({
                    "status": "failed",
                    "category": "OpenClaw Asistan",
                    "watch_summary": summary,
                    "phone_report": summary,
                }),
            }
            if deep_link:
                response_payload["deep_link"] = deep_link
            if handoff_url:
                response_payload["handoff_url"] = handoff_url

            resp_schema = load_contract("job-summary-response.schema.json")
            resp_errors = validate_payload(response_payload, resp_schema)
            if resp_errors:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Response validation failed", "details": resp_errors}).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response_payload).encode("utf-8"))
            return
        elif self.path == "/api/v1/watch/command":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Invalid JSON"}')
                return

            req_schema = load_contract("watch-command-request.schema.json")
            errors = validate_payload(payload, req_schema)
            if errors:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Validation failed", "details": errors}).encode("utf-8"))
                return

            stt_result = stt_client.transcribe_watch_payload(payload)
            effective_transcript = stt_result.transcript.strip()

            new_job_id = f"job-{uuid.uuid4().hex[:8]}"
            task_name = (effective_transcript or payload.get("client_timestamp") or "Watch Audio Command").strip()
            if not task_name:
                task_name = "Watch Audio Command"

            invocation_payload = dict(payload)
            invocation_payload["transcript"] = effective_transcript
            invocation_payload["_stt_source"] = stt_result.source
            invocation_payload["_stt_error"] = stt_result.error or ""

            invocation = openclaw_client.invoke_watch_command(invocation_payload)
            initial_requires_phone_handoff = not bool(effective_transcript)
            summary_text = build_processing_summary(stt_result.source, effective_transcript, stt_result.error)
            phone_report = (
                "OpenClaw çağrısı başlatıldı."
                if effective_transcript
                else "OpenClaw çağrısı başlatıldı ancak transkript üretilemedi. Telefonda hata notu ve yeniden deneme önerisi gösterilecek."
            )

            jobs_db[new_job_id] = {
                "id": new_job_id,
                "name": task_name,
                "status": "running",
                "created_at": time.time(),
                "elapsed_seconds": 0,
                "category": "OpenClaw Asistan",
                "canned_result": "OpenClaw çağrısı başlatıldı, sonuç bekleniyor.",
                "watch_summary": summary_text,
                "requires_phone_handoff": initial_requires_phone_handoff,
                "phone_report": phone_report,
                "transcript": effective_transcript,
                "stt_source": stt_result.source,
                "stt_error": stt_result.error or "",
                "next_action": None,
                "invocation": {
                    "process": invocation.process,
                    "log_path": invocation.log_path,
                    "prompt": invocation.prompt,
                    "command": invocation.command,
                    "started_at": invocation.started_at,
                }
            }

            structured_fields = build_structured_report_fields(jobs_db[new_job_id])
            resp_payload = {
                "status": "processing",
                "transcript": effective_transcript,
                "summary_text": summary_text,
                "tts_audio_data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                "tts_format": "aac",
                "requires_phone_handoff": initial_requires_phone_handoff,
                "handoff_reason": "needs_clarification" if initial_requires_phone_handoff else None,
                "job_id": new_job_id,
                "phone_report": phone_report,
                "next_actions": build_next_actions(jobs_db[new_job_id]),
                **structured_fields,
            }
            if initial_requires_phone_handoff:
                deep_link = build_handoff_deep_link(new_job_id)
                resp_payload["deep_link"] = deep_link
                resp_payload["handoff_url"] = deep_link

            resp_schema = load_contract("watch-command-response.schema.json")
            resp_errors = validate_payload(resp_payload, resp_schema)
            if resp_errors:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Response validation failed", "details": resp_errors}).encode("utf-8"))
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp_payload).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error": "Not found"}')


def run(port=8080):
    server_address = ('', port)
    httpd = HTTPServer(server_address, WatchCevizHandler)
    logging.info(f"Starting watch-ceviz stub server on port {port}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    logging.info("Server stopped.")


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    run(port)

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class TaskResult:
    category: str
    canned_result: str
    watch_summary: str
    requires_phone_handoff: bool
    phone_report: str
    next_action: str | None


@dataclass
class InvocationHandle:
    command: list[str]
    log_path: str
    started_at: float
    process: subprocess.Popen[Any]
    prompt: str


class OpenClawClient:
    """Thin OpenClaw CLI integration for watch-originated jobs."""

    REPORT_START = "<watch_ceviz_phone_report>"
    REPORT_END = "</watch_ceviz_phone_report>"
    META_START = "<watch_ceviz_meta>"
    META_END = "</watch_ceviz_meta>"

    def __init__(
        self,
        agent: str | None = None,
        runtime_dir: str | os.PathLike[str] | None = None,
    ) -> None:
        self.agent = agent or os.environ.get("OPENCLAW_WATCH_AGENT", "main")
        self.runtime_dir = Path(
            runtime_dir
            or os.environ.get("OPENCLAW_WATCH_RUNTIME_DIR")
            or (Path(tempfile.gettempdir()) / "watch-ceviz-openclaw")
        )
        self.runtime_dir.mkdir(parents=True, exist_ok=True)

    def invoke_watch_command(self, payload: dict[str, Any]) -> InvocationHandle:
        prompt = self._build_prompt(payload)
        log_path = self.runtime_dir / f"watch-job-{uuid.uuid4().hex}.log"
        log_file = log_path.open("w", encoding="utf-8")
        command = [
            "openclaw",
            "agent",
            "--agent",
            self.agent,
            "--json",
            "--message",
            prompt,
        ]
        process = subprocess.Popen(  # noqa: S603
            command,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
        )
        log_file.close()
        return InvocationHandle(
            command=command,
            log_path=str(log_path),
            started_at=time.time(),
            process=process,
            prompt=prompt,
        )

    def extract_result(self, log_path: str) -> TaskResult:
        raw_output = Path(log_path).read_text(encoding="utf-8")
        parsed = json.loads(raw_output)
        payloads = parsed.get("result", {}).get("payloads", [])
        response_text = "\n\n".join(
            payload.get("text", "").strip()
            for payload in payloads
            if payload.get("text")
        ).strip()
        if not response_text:
            response_text = "OpenClaw çağrısı tamamlandı ama metin yanıtı dönmedi."

        structured = self._extract_structured_payload(response_text)
        clean_text = structured["phone_report"] or response_text

        return TaskResult(
            category=structured["category"] or self._categorize_text(clean_text),
            canned_result=clean_text,
            watch_summary=structured["watch_summary"] or self._build_watch_summary(clean_text),
            requires_phone_handoff=(
                structured["requires_phone_handoff"]
                if structured["requires_phone_handoff"] is not None
                else self._requires_phone_handoff(clean_text)
            ),
            phone_report=self._build_phone_report(clean_text),
            next_action=structured["next_action"] or self._extract_next_action(clean_text),
        )

    def read_log_tail(self, log_path: str, max_chars: int = 1200) -> str:
        if not Path(log_path).exists():
            return ""
        contents = Path(log_path).read_text(encoding="utf-8", errors="replace")
        return contents[-max_chars:].strip()

    def _build_prompt(self, payload: dict[str, Any]) -> str:
        audio_format = payload.get("format", "unknown")
        client_timestamp = payload.get("client_timestamp", "unknown")
        audio_size = len(payload.get("audio_data", ""))
        optional_transcript = (payload.get("transcript") or "").strip()
        stt_source = (payload.get("_stt_source") or "unknown").strip()
        stt_error = (payload.get("_stt_error") or "").strip()

        transcript_line = (
            f"Çözümlenen transkript: {optional_transcript}\n"
            if optional_transcript
            else "Transkript üretilemedi.\n"
        )
        stt_status_line = f"STT kaynağı: {stt_source}\n"
        stt_error_line = f"STT fallback nedeni: {stt_error}\n" if stt_error else ""

        return (
            "Bu istek Apple Watch kaynaklı Watch Ceviz backend entegrasyonundan geliyor. "
            "Amaç, saatten gelen kısa komutları telefona devredilebilir net bir sonuca çevirmek.\n\n"
            f"Ses formatı: {audio_format}\n"
            f"İstemci zaman damgası: {client_timestamp}\n"
            f"Base64 ses yükü uzunluğu: {audio_size}\n"
            f"{stt_status_line}"
            f"{stt_error_line}"
            f"{transcript_line}\n"
            "Lütfen Türkçe yanıt ver. Eğer gerçek transkript yoksa bunu açıkça söyle ve en güvenli bir sonraki adımı öner. "
            "Yanıtı iki blok halinde üret ve marker metinlerini aynen koru.\n"
            f"1) İlk blok tam olarak {self.REPORT_START} ile başlayıp {self.REPORT_END} ile bitsin. "
            "Bu blokta telefonda gösterilecek doğal Türkçe rapor olsun. Raporda şu sırayı kullan: "
            "1. Kısa durum, 2. Ne anlaşıldı / sınırlama, 3. Önerilen sonraki adım.\n"
            f"2) İkinci blok tam olarak {self.META_START} ile başlayıp {self.META_END} ile bitsin. "
            "Bu blokta tek satır geçerli JSON nesnesi ver. Şema: "
            '{"watch_summary":"...","next_action":"..."|null,"requires_phone_handoff":true,"category":"..."}. '
            "watch_summary tek cümle ve 160 karakter altında olsun. next_action net, uygulanabilir tek adım olsun. "
            "JSON dışında meta bloğunda başka açıklama yazma."
        )

    def _extract_structured_payload(self, text: str) -> dict[str, Any]:
        phone_report = self._extract_tagged_block(text, self.REPORT_START, self.REPORT_END)
        meta_raw = self._extract_tagged_block(text, self.META_START, self.META_END)
        meta: dict[str, Any] = {}

        if meta_raw:
            try:
                parsed_meta = json.loads(meta_raw)
                if isinstance(parsed_meta, dict):
                    meta = parsed_meta
            except json.JSONDecodeError:
                meta = {}

        return {
            "phone_report": (phone_report or self._strip_structured_blocks(text)).strip(),
            "watch_summary": self._clean_optional_text(meta.get("watch_summary")),
            "next_action": self._clean_optional_text(meta.get("next_action")),
            "category": self._clean_optional_text(meta.get("category")),
            "requires_phone_handoff": self._coerce_optional_bool(meta.get("requires_phone_handoff")),
        }

    def _extract_tagged_block(self, text: str, start_tag: str, end_tag: str) -> str | None:
        pattern = re.escape(start_tag) + r"\s*(.*?)\s*" + re.escape(end_tag)
        match = re.search(pattern, text, flags=re.DOTALL)
        if not match:
            return None
        block = match.group(1).strip()
        return block or None

    def _strip_structured_blocks(self, text: str) -> str:
        stripped = re.sub(
            re.escape(self.REPORT_START) + r".*?" + re.escape(self.REPORT_END),
            "",
            text,
            flags=re.DOTALL,
        )
        stripped = re.sub(
            re.escape(self.META_START) + r".*?" + re.escape(self.META_END),
            "",
            stripped,
            flags=re.DOTALL,
        )
        return stripped.strip()

    def _clean_optional_text(self, value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if text.lower() == "null":
            return None
        return text or None

    def _coerce_optional_bool(self, value: Any) -> bool | None:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "yes", "1", "evet"}:
                return True
            if normalized in {"false", "no", "0", "hayır", "hayir"}:
                return False
        return None

    def _categorize_text(self, text: str) -> str:
        text_lower = text.lower()
        if any(word in text_lower for word in ["mail", "e-posta", "posta"]):
            return "E-posta İşlemleri"
        if any(word in text_lower for word in ["takvim", "calendar", "meeting", "toplantı"]):
            return "Takvim / Program"
        if any(word in text_lower for word in ["kod", "git", "pull request", "pr", "review"]):
            return "Yazılım / Kod"
        return "OpenClaw Asistan"

    def _build_watch_summary(self, text: str, max_len: int = 200) -> str:
        normalized = " ".join(part.strip() for part in text.splitlines() if part.strip())
        normalized = re.sub(r"\b[123]\s*[\.)]\s*", "", normalized).strip()
        if not normalized:
            return "Sonuç üretildi ama özet metni boş döndü."

        preferred_chunks = []
        for separator in [". ", "\n", "; "]:
            preferred_chunks.extend(chunk.strip() for chunk in normalized.split(separator) if chunk.strip())
        preferred_chunks.append(normalized)

        for chunk in preferred_chunks:
            if len(chunk) < 8:
                continue
            if len(chunk) <= max_len:
                return chunk

        return normalized[: max_len - 1].rstrip() + "…"

    def _requires_phone_handoff(self, text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True

        lines = [line.strip() for line in stripped.splitlines() if line.strip()]
        text_lower = stripped.lower()
        code_markers = ["```", "def ", "class ", "diff ", "+++", "---", "{" , "}"]
        has_code_like_content = any(marker in stripped for marker in code_markers)
        has_list_like_content = sum(line.startswith(("-", "*", "•")) for line in lines) >= 3
        has_many_lines = len(lines) >= 5
        is_long = len(stripped) > 280
        has_dense_guidance = any(keyword in text_lower for keyword in ["adım", "next", "sonraki adım", "checklist", "liste"]) and len(stripped) > 180
        return has_code_like_content or has_list_like_content or has_many_lines or is_long or has_dense_guidance

    def _build_phone_report(self, text: str) -> str:
        return text.strip() or "OpenClaw çağrısı tamamlandı ama ayrıntılı rapor boş döndü."

    def _extract_next_action(self, text: str) -> str | None:
        stripped = text.strip()
        if not stripped:
            return None

        lines = [line.strip() for line in stripped.splitlines() if line.strip()]
        heading_markers = [
            "3. önerilen sonraki adım",
            "3) önerilen sonraki adım",
            "önerilen sonraki adım:",
            "sonraki adım:",
            "suggested next action:",
            "next action:",
        ]

        for index, line in enumerate(lines):
            normalized = line.lower()
            if normalized in heading_markers:
                collected: list[str] = []
                for candidate in lines[index + 1 :]:
                    candidate_lower = candidate.lower()
                    if any(
                        candidate_lower.startswith(prefix)
                        for prefix in ["1.", "2.", "3.", "1)", "2)", "3)"]
                    ):
                        break
                    collected.append(candidate.lstrip("-• ").strip())
                result = " ".join(part for part in collected if part).strip()
                if result:
                    return result

            for marker in heading_markers:
                if normalized.startswith(marker):
                    inline = line[len(marker):].lstrip(" :-").strip()
                    if inline:
                        return inline

        return None

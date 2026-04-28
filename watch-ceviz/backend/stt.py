from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass
class TranscriptionResult:
    transcript: str
    source: str
    error: str | None = None


class WatchSTT:
    def __init__(self) -> None:
        self.api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        self.base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.model = os.environ.get("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")
        self.language = os.environ.get("OPENAI_STT_LANGUAGE", "tr").strip()

    def transcribe_watch_payload(self, payload: dict[str, Any]) -> TranscriptionResult:
        provided_transcript = (payload.get("transcript") or "").strip()
        if provided_transcript:
            return TranscriptionResult(transcript=provided_transcript, source="client")

        audio_b64 = (payload.get("audio_data") or "").strip()
        if not audio_b64:
            return TranscriptionResult(transcript="", source="none", error="audio_data boş")

        try:
            audio_bytes = base64.b64decode(audio_b64, validate=True)
        except Exception:
            return TranscriptionResult(transcript="", source="none", error="audio_data base64 olarak çözülemedi")

        if not audio_bytes:
            return TranscriptionResult(transcript="", source="none", error="çözülen ses verisi boş")

        if not self.api_key:
            return TranscriptionResult(transcript="", source="none", error="OPENAI_API_KEY tanımlı değil")

        try:
            transcript = self._transcribe_with_openai(audio_bytes, payload.get("format", "m4a"))
        except urllib.error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            return TranscriptionResult(transcript="", source="none", error=f"STT HTTP {exc.code}: {details}")
        except urllib.error.URLError as exc:
            return TranscriptionResult(transcript="", source="none", error=f"STT ağ hatası: {exc}")
        except Exception as exc:
            return TranscriptionResult(transcript="", source="none", error=f"STT hatası: {exc}")

        transcript = transcript.strip()
        if not transcript:
            return TranscriptionResult(transcript="", source="none", error="STT boş metin döndürdü")

        return TranscriptionResult(transcript=transcript, source="openai")

    def _transcribe_with_openai(self, audio_bytes: bytes, audio_format: str) -> str:
        boundary = f"----WatchCevizBoundary{uuid.uuid4().hex}"
        filename = f"watch-command.{audio_format or 'm4a'}"
        content_type = self._guess_content_type(filename)

        body = bytearray()
        body.extend(self._field(boundary, "model", self.model))
        if self.language:
            body.extend(self._field(boundary, "language", self.language))
        body.extend(self._file(boundary, "file", filename, content_type, audio_bytes))
        body.extend(f"--{boundary}--\r\n".encode("utf-8"))

        request = urllib.request.Request(
            url=f"{self.base_url}/audio/transcriptions",
            data=bytes(body),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Accept": "application/json",
            },
            method="POST",
        )

        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))

        return str(payload.get("text") or "")

    def _field(self, boundary: str, name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode("utf-8")

    def _file(self, boundary: str, name: str, filename: str, content_type: str, data: bytes) -> bytes:
        head = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
        return head + data + b"\r\n"

    def _guess_content_type(self, filename: str) -> str:
        guessed, _ = mimetypes.guess_type(filename)
        return guessed or "application/octet-stream"

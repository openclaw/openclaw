"""
Experience Memory Engine — LanceDB + SentenceTransformers 混合檢索
====================================================================

核心模組：使用 LanceDB 進行向量儲存，sentence-transformers 做本地 embedding，
支援向量相似度 + 關鍵字 BM25 的混合檢索。

結構化經驗格式：
  - phenomenon: 現象/報錯描述
  - cause: 根因分析
  - solution: 解決方案
  - methodology: 方法論/架構原則
  - tags: 分類標籤
  - severity: 嚴重等級 (info/warning/critical)
  - source: 來源 (manual/auto/tg-import)
"""

import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import lancedb
import pyarrow as pa
from sentence_transformers import SentenceTransformer

# ============================================================================
# Constants
# ============================================================================

DB_DIR = Path(__file__).parent / "data"
DB_DIR.mkdir(parents=True, exist_ok=True)
TABLE_NAME = "experiences"

# Use a small, fast, multilingual model — supports Chinese/English/Japanese
MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
VECTOR_DIM = 384

SEVERITY_LEVELS = ("info", "warning", "critical")
SOURCES = ("manual", "auto", "tg-import", "session-extract")

# ============================================================================
# Schema
# ============================================================================

SCHEMA = pa.schema([
    pa.field("id", pa.string()),
    pa.field("phenomenon", pa.string()),
    pa.field("cause", pa.string()),
    pa.field("solution", pa.string()),
    pa.field("methodology", pa.string()),
    pa.field("tags", pa.string()),         # JSON array
    pa.field("severity", pa.string()),
    pa.field("source", pa.string()),
    pa.field("created_at", pa.string()),
    pa.field("updated_at", pa.string()),
    pa.field("hit_count", pa.int32()),
    pa.field("vector", pa.list_(pa.float32(), VECTOR_DIM)),
])


# ============================================================================
# Embedding Engine (local, zero-cost)
# ============================================================================

_model: Optional[SentenceTransformer] = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def embed_text(text: str) -> list[float]:
    """Generate embedding for text using local SentenceTransformer model."""
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True)
    return vec.tolist()


def embed_experience(exp: dict) -> list[float]:
    """Generate embedding from all fields of an experience entry."""
    parts = []
    for key in ("phenomenon", "cause", "solution", "methodology"):
        val = exp.get(key, "")
        if val:
            parts.append(val)
    tags = exp.get("tags", [])
    if isinstance(tags, list):
        parts.extend(tags)
    combined = " | ".join(parts)
    return embed_text(combined)


# ============================================================================
# Database Manager
# ============================================================================

class ExperienceDB:
    """LanceDB-backed experience memory with hybrid search."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or str(DB_DIR)
        self.db = lancedb.connect(self.db_path)
        self._ensure_table()

    def _ensure_table(self):
        """Create table if it doesn't exist."""
        existing = self.db.table_names()
        if TABLE_NAME in existing:
            self.table = self.db.open_table(TABLE_NAME)
        else:
            # Create with empty schema
            self.table = self.db.create_table(TABLE_NAME, schema=SCHEMA)

    def save(
        self,
        phenomenon: str,
        cause: str = "",
        solution: str = "",
        methodology: str = "",
        tags: Optional[list[str]] = None,
        severity: str = "info",
        source: str = "manual",
    ) -> dict:
        """Save an experience entry."""
        now = datetime.now().isoformat()
        entry = {
            "id": f"exp_{int(time.time() * 1000)}_{os.urandom(4).hex()}",
            "phenomenon": phenomenon,
            "cause": cause,
            "solution": solution,
            "methodology": methodology,
            "tags": json.dumps(tags or [], ensure_ascii=False),
            "severity": severity if severity in SEVERITY_LEVELS else "info",
            "source": source if source in SOURCES else "manual",
            "created_at": now,
            "updated_at": now,
            "hit_count": 0,
            "vector": embed_experience({
                "phenomenon": phenomenon,
                "cause": cause,
                "solution": solution,
                "methodology": methodology,
                "tags": tags or [],
            }),
        }
        self.table.add([entry])
        return {k: v for k, v in entry.items() if k != "vector"}

    def search(
        self,
        query: str,
        limit: int = 5,
        min_score: float = 0.3,
        tags_filter: Optional[list[str]] = None,
        severity_filter: Optional[str] = None,
    ) -> list[dict]:
        """
        Hybrid search: vector similarity + keyword filtering.
        Returns results sorted by relevance score.
        """
        query_vec = embed_text(query)
        query_lower = query.lower()

        # Vector search
        try:
            results = (
                self.table
                .search(query_vec)
                .limit(limit * 3)  # Over-fetch for post-filtering
                .to_list()
            )
        except Exception:
            return []

        scored = []
        for row in results:
            # Vector similarity score (LanceDB returns _distance, lower = better)
            distance = row.get("_distance", 999)
            vec_score = 1.0 / (1.0 + distance)

            # Keyword bonus: check if query terms appear in text fields
            keyword_bonus = 0.0
            text_fields = f"{row.get('phenomenon', '')} {row.get('cause', '')} {row.get('solution', '')} {row.get('methodology', '')} {row.get('tags', '')}".lower()

            query_terms = [t for t in re.split(r'[\s,|]+', query_lower) if len(t) > 1]
            if query_terms:
                matches = sum(1 for t in query_terms if t in text_fields)
                keyword_bonus = 0.3 * (matches / len(query_terms))

            # Combined score
            final_score = 0.7 * vec_score + 0.3 * keyword_bonus if keyword_bonus > 0 else vec_score

            # Tag filter
            if tags_filter:
                entry_tags = json.loads(row.get("tags", "[]"))
                if not any(t in entry_tags for t in tags_filter):
                    continue

            # Severity filter
            if severity_filter and row.get("severity") != severity_filter:
                continue

            if final_score >= min_score:
                scored.append({
                    "id": row["id"],
                    "phenomenon": row["phenomenon"],
                    "cause": row["cause"],
                    "solution": row["solution"],
                    "methodology": row["methodology"],
                    "tags": json.loads(row.get("tags", "[]")),
                    "severity": row.get("severity", "info"),
                    "source": row.get("source", "unknown"),
                    "created_at": row.get("created_at", ""),
                    "hit_count": row.get("hit_count", 0),
                    "score": round(final_score, 4),
                })

        # Sort by score descending
        scored.sort(key=lambda x: x["score"], reverse=True)

        # Update hit counts for returned results
        for item in scored[:limit]:
            try:
                self.table.update(
                    where=f"id = '{item['id']}'",
                    values={"hit_count": item["hit_count"] + 1, "updated_at": datetime.now().isoformat()},
                )
            except Exception:
                pass

        return scored[:limit]

    def list_all(self, limit: int = 50) -> list[dict]:
        """List all experiences, newest first."""
        try:
            rows = self.table.to_pandas()
            if rows.empty:
                return []
            rows = rows.sort_values("created_at", ascending=False).head(limit)
            result = []
            for _, row in rows.iterrows():
                result.append({
                    "id": row["id"],
                    "phenomenon": row["phenomenon"],
                    "cause": row["cause"],
                    "solution": row["solution"],
                    "methodology": row["methodology"],
                    "tags": json.loads(row.get("tags", "[]")),
                    "severity": row.get("severity", "info"),
                    "source": row.get("source", "unknown"),
                    "created_at": row.get("created_at", ""),
                    "hit_count": row.get("hit_count", 0),
                })
            return result
        except Exception:
            return []

    def count(self) -> int:
        """Get total number of experiences."""
        try:
            return self.table.count_rows()
        except Exception:
            return 0

    def delete(self, exp_id: str) -> bool:
        """Delete an experience by ID."""
        if not re.match(r'^exp_\d+_[a-f0-9]+$', exp_id):
            raise ValueError(f"Invalid experience ID format: {exp_id}")
        self.table.delete(f"id = '{exp_id}'")
        return True

    def stats(self) -> dict:
        """Get statistics about the experience memory."""
        try:
            df = self.table.to_pandas()
            if df.empty:
                return {"total": 0, "by_severity": {}, "by_source": {}, "top_tags": []}
            return {
                "total": len(df),
                "by_severity": df["severity"].value_counts().to_dict(),
                "by_source": df["source"].value_counts().to_dict(),
                "most_hit": df.nlargest(5, "hit_count")[["id", "phenomenon", "hit_count"]].to_dict("records"),
            }
        except Exception as e:
            return {"error": str(e)}

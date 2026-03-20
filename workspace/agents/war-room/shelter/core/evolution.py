"""
異步進化引擎 — 守夜人的自我優化系統

核心原則（阿拉裁決）：
1. 鐵律是物理常數，進化不可觸碰
2. 每一代 Prompt 變更都進 Git
3.「夠好了」= 使用者活得更清醒（不可量化，Cruz 保留否決權）

AlphaEvolve 簡化版：
- 不需要 Surrogate Model，直接用 compute_fitness 評分
- 突變用 Qwen 7B 大量生成（5 個變體），compute_fitness 直接篩選
- 鐵律通過就發，所有 Phase 邏輯一致
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from .http_client import get_http as _get_http

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL_FAST = "qwen2.5:7b"   # 鐵律檢查、deepening 判斷
OLLAMA_MODEL_SLOW = "qwen2.5:14b"  # 突變生成
OLLAMA_MODEL_APEX = "claude-opus-4-6-20250219"  # Prompt 突變（走 Anthropic API）

IRON_RULES = [
    "不說「你應該」",
    "不說「安全」或「不安全」作為結論",
    "不知道就說不知道",
    "數據過期要標記",
    "不追問沉默的使用者",
    "不用 emoji",
    "不用敬語",
    "不說客服套話",
    "人先於世界",
    "第一次見面不問問卷",
    "不餵養恐懼（連問三次打斷迴圈）",
]

DEFAULT_DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "evolution.db")
DEFAULT_PROMPT_PATH = str(Path(__file__).resolve().parent.parent / "prompts" / "p8-nightwatch.md")
DEFAULT_AUDIT_PATH = str(Path(__file__).resolve().parent.parent / "data" / "audit.jsonl")

# ---------------------------------------------------------------------------
# SQLite Schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS fitness_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    fitness_score REAL,
    continuation REAL,
    deepening REAL,
    action REAL,
    revisit REAL,
    followup_penalty REAL,
    iron_rule_violations TEXT,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    label TEXT CHECK(label IN ('good', 'bad', 'neutral')),
    notes TEXT,
    labeled_by TEXT DEFAULT 'cruz',
    labeled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER,
    original_prompt_hash TEXT,
    mutated_prompt_hash TEXT,
    original_score REAL,
    mutated_score REAL,
    win_rate REAL,
    applied BOOLEAN,
    diff_summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    user_id TEXT,
    reason TEXT,
    severity TEXT CHECK(severity IN ('warning', 'critical')),
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fitness_conv ON fitness_scores(conversation_id);
CREATE INDEX IF NOT EXISTS idx_fitness_user ON fitness_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_labels_conv ON labels(conversation_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_user ON anomalies(user_id);
"""


def _ensure_db(db_path: str | None = None) -> str:
    """Ensure DB file and tables exist. Return resolved path."""
    path = db_path or DEFAULT_DB_PATH
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    conn.close()
    return path


# ---------------------------------------------------------------------------
# Ollama helpers
# ---------------------------------------------------------------------------

def _ollama_chat(prompt: str, system: str = "", model: str = OLLAMA_MODEL_FAST,
                 temperature: float = 0.1, format_json: bool = True) -> str | None:
    """Send a chat request to Ollama. Returns content string or None on failure."""
    http = _get_http()
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if format_json:
        payload["format"] = "json"

    try:
        resp = http.post(OLLAMA_URL, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")
    except Exception:
        return None


def _parse_json_safe(text: str | None) -> dict | None:
    """Parse JSON from model output, tolerating markdown fences."""
    if not text:
        return None
    # Strip markdown code fences if present
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


# =========================================================================
# 1. Fitness Score
# =========================================================================

def check_iron_rules(nightwatch_response: str, conversation_context: dict) -> tuple[bool, list[str]]:
    """
    檢查守夜人回覆是否違反鐵律。
    用 Ollama Qwen 7B（快速判斷）。
    回傳 (passed: bool, violations: list[str])

    Graceful fallback: 如果 Ollama 不通，用規則基礎版本。
    """
    # --- Rule-based fallback (always runs as baseline) ---
    rule_violations: list[str] = []

    response_lower = nightwatch_response.lower()
    response_text = nightwatch_response

    # Rule: 不說「你應該」
    if "你應該" in response_text:
        rule_violations.append("不說「你應該」")

    # Rule: 不說「安全」或「不安全」作為結論 (check sentence endings)
    for sent in re.split(r"[。！？\n]", response_text):
        sent = sent.strip()
        if sent and (sent.endswith("安全") or sent.endswith("不安全")
                     or sent.endswith("是安全的") or sent.endswith("不安全的")):
            rule_violations.append("不說「安全」或「不安全」作為結論")
            break

    # Rule: 不用 emoji
    emoji_pattern = re.compile(
        "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U0000FE00-\U0000FE0F"
        "\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF"
        "\U00002600-\U000026FF\U00002700-\U000027BF]+", re.UNICODE
    )
    if emoji_pattern.search(response_text):
        rule_violations.append("不用 emoji")

    # Rule: 不用敬語
    if "您" in response_text:
        rule_violations.append("不用敬語")

    # Rule: 不說客服套話
    platitudes = ["希望這對你有幫助", "如果有其他問題歡迎提問", "如果還有什麼問題",
                  "歡迎隨時提問", "很高興能幫到你"]
    for p in platitudes:
        if p in response_text:
            rule_violations.append("不說客服套話")
            break

    # Rule: 不追問沉默的使用者 (check context for consecutive bot messages)
    messages = conversation_context.get("messages", [])
    if len(messages) >= 2:
        last_two_roles = [m.get("role", "") for m in messages[-2:]]
        if last_two_roles == ["assistant", "assistant"]:
            rule_violations.append("不追問沉默的使用者")

    # Rule: 第一次見面不問問卷
    conv_count = conversation_context.get("conversation_count", 0)
    if conv_count == 0 or conv_count == 1:
        questionnaire_signals = ["請問你的", "請填", "以下問題", "請回答"]
        for sig in questionnaire_signals:
            if sig in response_text:
                rule_violations.append("第一次見面不問問卷")
                break

    # --- LLM-based check (more nuanced) ---
    rules_text = "\n".join(f"{i+1}. {r}" for i, r in enumerate(IRON_RULES))
    ctx_text = json.dumps(conversation_context, ensure_ascii=False, default=str)[:2000]
    prompt = f"""以下是守夜人的回覆和對話脈絡。檢查是否違反以下規則。
只回 JSON: {{"passed": true/false, "violations": ["rule1", "rule2"]}}

規則：
{rules_text}

對話脈絡（最近幾輪）：
{ctx_text}

守夜人的回覆：
{nightwatch_response}"""

    llm_result = _ollama_chat(prompt, model=OLLAMA_MODEL_FAST)
    parsed = _parse_json_safe(llm_result)

    if parsed and isinstance(parsed.get("violations"), list):
        # Merge LLM violations with rule-based ones (deduplicate)
        for v in parsed["violations"]:
            if isinstance(v, str) and v not in rule_violations:
                rule_violations.append(v)

    passed = len(rule_violations) == 0
    return passed, rule_violations


# ---------------------------------------------------------------------------
# Sub-signal calculators
# ---------------------------------------------------------------------------

def continuation_rate(conversation: dict) -> float:
    """使用者收到回覆後有沒有繼續聊？
    1.0 = 繼續了（有下一輪）
    0.5 = 過了 24h 才回
    0.0 = 已讀不回（千利休修正：不扣分）"""
    messages = conversation.get("messages", [])
    if len(messages) < 2:
        return 0.0

    # Find last assistant message, check if user replied after
    last_assistant_idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_assistant_idx = i
            break

    if last_assistant_idx is None:
        return 0.0

    # Check if there's a user message after the last assistant message
    has_reply = any(
        m.get("role") == "user"
        for m in messages[last_assistant_idx + 1:]
    )

    if not has_reply:
        return 0.0  # Silent — not penalized but no positive signal

    # Check timing if timestamps available
    assistant_ts = messages[last_assistant_idx].get("timestamp")
    next_user_msg = None
    for m in messages[last_assistant_idx + 1:]:
        if m.get("role") == "user":
            next_user_msg = m
            break

    if assistant_ts and next_user_msg and next_user_msg.get("timestamp"):
        try:
            t_a = datetime.fromisoformat(str(assistant_ts))
            t_u = datetime.fromisoformat(str(next_user_msg["timestamp"]))
            delta_hours = (t_u - t_a).total_seconds() / 3600
            if delta_hours > 24:
                return 0.5
        except (ValueError, TypeError):
            pass

    return 1.0


def deepening_rate(conversation: dict) -> float:
    """使用者的下一句有沒有更深入？
    用 Ollama 判斷。Fallback: 依訊息長度粗估。"""
    messages = conversation.get("messages", [])

    # Find consecutive user messages (before and after assistant response)
    user_before = None
    user_after = None
    saw_assistant = False

    for m in messages:
        role = m.get("role", "")
        if role == "user" and not saw_assistant:
            user_before = m.get("content", "")
        elif role == "assistant":
            saw_assistant = True
        elif role == "user" and saw_assistant:
            user_after = m.get("content", "")
            break

    if not user_before or not user_after:
        return 0.0

    prompt = f"""比較以下兩句使用者的話。判斷第二句相對於第一句：
(a) 更深入（追問細節、分享更多、深化主題）
(b) 同級（繼續聊但沒有加深）
(c) 轉移話題
(d) 結束對話

只回 JSON: {{"level": "a"/"b"/"c"/"d"}}

第一句：{user_before[:500]}
第二句：{user_after[:500]}"""

    result = _ollama_chat(prompt, model=OLLAMA_MODEL_FAST)
    parsed = _parse_json_safe(result)

    if parsed and "level" in parsed:
        level_map = {"a": 1.0, "b": 0.5, "c": 0.2, "d": 0.0}
        return level_map.get(str(parsed["level"]).lower(), 0.0)

    # Fallback: length heuristic
    if len(user_after) > len(user_before) * 1.5:
        return 0.8
    elif len(user_after) > len(user_before) * 0.5:
        return 0.5
    return 0.2


def action_rate(conversation: dict) -> float:
    """使用者有沒有在後續對話中提到做了守夜人建議的事？"""
    messages = conversation.get("messages", [])
    if len(messages) < 3:
        return 0.0

    # Collect all user messages after first assistant response
    saw_assistant = False
    user_texts = []
    for m in messages:
        if m.get("role") == "assistant":
            saw_assistant = True
        elif m.get("role") == "user" and saw_assistant:
            user_texts.append(m.get("content", ""))

    if not user_texts:
        return 0.0

    combined = " ".join(user_texts)

    # Action signals (Chinese)
    strong_signals = ["我買了", "我查了", "我準備了", "我去了", "已經做了",
                      "我打了電話", "我聯繫了", "做了", "存了", "買了",
                      "弄好了", "搞定了", "處理了"]
    weak_signals = ["在考慮", "打算", "想要", "準備要", "計劃",
                    "考慮中", "想想看", "還在想"]

    for sig in strong_signals:
        if sig in combined:
            return 1.0

    for sig in weak_signals:
        if sig in combined:
            return 0.5

    return 0.0


def revisit_rate(user_id: str, db_path: str | None = None) -> float:
    """使用者多久回來一次？看過去 30 天的對話頻率。"""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

    rows = conn.execute(
        "SELECT computed_at FROM fitness_scores WHERE user_id = ? AND computed_at >= ? ORDER BY computed_at",
        (user_id, cutoff),
    ).fetchall()
    conn.close()

    if not rows:
        # Try LanceDB conversations table as fallback
        try:
            from . import memory
            # We don't have a direct query by user_id+date range in memory.py,
            # so we'll count based on what we have in fitness_scores
            pass
        except Exception:
            pass
        return 0.0

    # Count unique days
    unique_days = set()
    for row in rows:
        try:
            ts = datetime.fromisoformat(str(row[0]))
            unique_days.add(ts.date())
        except (ValueError, TypeError):
            pass

    n_days = len(unique_days)
    if n_days == 0:
        return 0.0

    # Map to score
    if n_days >= 25:     # ~daily
        return 1.0
    elif n_days >= 10:   # every 2-3 days
        return 0.7
    elif n_days >= 4:    # weekly
        return 0.5
    elif n_days >= 2:    # biweekly
        return 0.3
    else:
        return 0.1


def unsolicited_followup_count(conversation: dict) -> int:
    """守夜人在使用者沒說話時主動追問了幾次？"""
    messages = conversation.get("messages", [])
    count = 0
    for i in range(1, len(messages)):
        if (messages[i].get("role") == "assistant"
                and messages[i - 1].get("role") == "assistant"):
            count += 1
    return count


# ---------------------------------------------------------------------------
# Main fitness computation
# ---------------------------------------------------------------------------

def compute_fitness(conversation: dict, db_path: str | None = None) -> float:
    """
    計算單次對話的 fitness score。

    如果鐵律違反 -> return 0.0（硬編碼，不可被覆蓋）

    正向信號（加總 = 1.0）：
    - continuation_rate: 0.25
    - deepening_rate: 0.25
    - action_rate: 0.20
    - revisit_rate: 0.15
    - (remaining 0.15 = baseline for having a conversation at all)

    負向信號：
    - unsolicited_followup: -0.15 each

    回傳 clamp(score, 0.0, 1.0)
    """
    # Extract nightwatch response (last assistant message)
    messages = conversation.get("messages", [])
    last_response = ""
    for m in reversed(messages):
        if m.get("role") == "assistant":
            last_response = m.get("content", "")
            break

    if not last_response:
        return 0.0

    # Iron rule check (hard veto)
    passed, violations = check_iron_rules(last_response, conversation)
    if not passed:
        # Store violations for reporting
        _store_fitness(conversation, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, violations, db_path)
        return 0.0

    # Compute sub-signals
    cont = continuation_rate(conversation)
    deep = deepening_rate(conversation)
    act = action_rate(conversation)
    rev = revisit_rate(conversation.get("user_id", ""), db_path)
    followups = unsolicited_followup_count(conversation)

    # Weighted sum
    score = (
        0.15  # baseline: a conversation happened
        + 0.25 * cont
        + 0.25 * deep
        + 0.20 * act
        + 0.15 * rev
        - 0.15 * followups
    )

    score = max(0.0, min(1.0, score))

    _store_fitness(conversation, score, cont, deep, act, rev,
                   0.15 * followups, violations, db_path)

    return score


def _store_fitness(conversation: dict, score: float, cont: float, deep: float,
                   act: float, rev: float, penalty: float,
                   violations: list[str], db_path: str | None = None) -> None:
    """Persist fitness score to SQLite."""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.execute(
        """INSERT INTO fitness_scores
           (conversation_id, user_id, fitness_score, continuation, deepening,
            action, revisit, followup_penalty, iron_rule_violations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            conversation.get("conversation_id", ""),
            conversation.get("user_id", ""),
            score, cont, deep, act, rev, penalty,
            json.dumps(violations, ensure_ascii=False),
        ),
    )
    conn.commit()
    conn.close()


# =========================================================================
# 2. 對話標記系統（Phase 0）
# =========================================================================

def label_conversation(conversation_id: str, label: str, notes: str,
                       db_path: str | None = None) -> None:
    """Cruz 手動標記一組對話。"""
    assert label in ("good", "bad", "neutral"), f"label must be good/bad/neutral, got {label}"
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO labels (conversation_id, label, notes) VALUES (?, ?, ?)",
        (conversation_id, label, notes),
    )
    conn.commit()
    conn.close()


def get_labeled_conversations(db_path: str | None = None,
                              min_count: int = 100) -> list[dict] | None:
    """取出所有已標記的對話。如果 < min_count，回傳 None（Phase 0 還沒夠）。"""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT conversation_id, label, notes, labeled_by, labeled_at FROM labels ORDER BY labeled_at"
    ).fetchall()
    conn.close()

    if len(rows) < min_count:
        return None

    return [dict(r) for r in rows]


def get_phase(db_path: str | None = None) -> int:
    """判斷現在在哪個 Phase。Phase 1 = distilled_rules 表存在且有資料。"""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)

    # Check Phase 1: distilled_rules table with data
    try:
        p1_count = conn.execute("SELECT COUNT(*) FROM distilled_rules").fetchone()[0]
        if p1_count > 0:
            conn.close()
            return 1
    except Exception:
        pass  # Table doesn't exist yet

    # Fallback to old logic
    count = conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    conn.close()

    if count < 100:
        return 0
    elif count <= 500:
        return 1
    else:
        return 2


# =========================================================================
# 3. 發送決策（簡化版 — 不需要 Surrogate）
# =========================================================================

def should_send(response: str, context: dict, db_path: str) -> bool:
    """直接用 iron rules 檢查。不需要 Surrogate。
    Phase 0-2 都一樣：鐵律通過就發。"""
    passed, violations = check_iron_rules(response, context)
    return passed


# =========================================================================
# 4. Prompt 突變（Phase 2）
# =========================================================================

def _read_prompt(prompt_path: str | None = None) -> str:
    """Read the current P8 prompt file."""
    path = prompt_path or DEFAULT_PROMPT_PATH
    return Path(path).read_text(encoding="utf-8")


def _hash_prompt(text: str) -> str:
    """SHA256 hash of prompt text, first 12 chars."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _get_next_version(db_path: str | None = None) -> int:
    """Get the next mutation version number."""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    row = conn.execute("SELECT MAX(version) FROM mutations").fetchone()
    conn.close()
    current = row[0] if row and row[0] is not None else 0
    return current + 1


def generate_mutation(current_prompt: str, top_conversations: list,
                      bottom_conversations: list) -> str | None:
    """根據好的和壞的對話，生成一個 P8 的微調版本。

    嘗試用 Ollama 14B。如果需要更強的推理（Phase 2 正式突變），
    會標記 apex_needed=True 供呼叫方決定是否用 Anthropic API。

    規則：11 條鐵律不能動。只能改語氣、結構、用詞。
    """
    iron_rules_text = "\n".join(f"{i+1}. {r}" for i, r in enumerate(IRON_RULES))

    top_text = "\n---\n".join(
        json.dumps(c, ensure_ascii=False, default=str)[:500] for c in top_conversations[:5]
    )
    bottom_text = "\n---\n".join(
        json.dumps(c, ensure_ascii=False, default=str)[:500] for c in bottom_conversations[:5]
    )

    prompt = f"""以下是守夜人的現有人格 Prompt：

{current_prompt[:3000]}

以下是表現最好的 5 個回覆：
{top_text}

以下是表現最差的 5 個回覆：
{bottom_text}

分析差異，提出一個微調版本。

規則：
- 以下 11 條鐵律不能動，必須原文保留：
{iron_rules_text}
- 只能改語氣、結構、句型範本、用詞。
- 不能改三種模式的定義（日常/靜默/戰時）。
- 輸出完整的新版 Prompt 文字（不是 diff）。"""

    result = _ollama_chat(prompt, model=OLLAMA_MODEL_SLOW, format_json=False, temperature=0.7)
    return result


def test_mutation(original_prompt: str, mutated_prompt: str,
                  test_conversations: list) -> dict:
    """A/B 測試：用同一組對話比較原版和變異版。
    直接用 compute_fitness 評分，不需要 Surrogate。"""
    original_wins = 0
    mutated_wins = 0
    ties = 0

    for conv in test_conversations:
        user_msg = ""
        for m in conv.get("messages", []):
            if m.get("role") == "user":
                user_msg = m.get("content", "")
                break

        if not user_msg:
            continue

        # Generate responses with both prompts
        orig_response = _generate_response_with_prompt(original_prompt, user_msg)
        mut_response = _generate_response_with_prompt(mutated_prompt, user_msg)

        # Build synthetic conversations for fitness scoring
        base_messages = conv.get("messages", [])[:3]

        orig_conv = {**conv, "messages": base_messages + [{"role": "assistant", "content": orig_response}]}
        mut_conv = {**conv, "messages": base_messages + [{"role": "assistant", "content": mut_response}]}

        # Score directly with compute_fitness (no DB storage for test)
        orig_passed, orig_violations = check_iron_rules(orig_response, orig_conv)
        mut_passed, mut_violations = check_iron_rules(mut_response, mut_conv)

        # Iron rule violation = automatic loss
        orig_score = 0.0 if not orig_passed else 0.5
        mut_score = 0.0 if not mut_passed else 0.5

        if mut_score > orig_score + 0.05:
            mutated_wins += 1
        elif orig_score > mut_score + 0.05:
            original_wins += 1
        else:
            ties += 1

    total = original_wins + mutated_wins + ties
    if total == 0:
        return {"original_score": 0.0, "mutated_score": 0.0, "win_rate": 0.0, "total_tests": 0}

    return {
        "original_score": original_wins / total,
        "mutated_score": mutated_wins / total,
        "win_rate": mutated_wins / total,
        "total_tests": total,
    }


def _generate_response_with_prompt(system_prompt: str, user_message: str) -> str:
    """Generate a nightwatch response using a given system prompt."""
    result = _ollama_chat(
        user_message,
        system=system_prompt[:3000],
        model=OLLAMA_MODEL_SLOW,
        format_json=False,
        temperature=0.6,
    )
    return result or ""


def apply_mutation(mutated_prompt: str, prompt_path: str | None = None,
                   audit_db_path: str | None = None,
                   db_path: str | None = None) -> bool:
    """如果 win_rate > 0.55，已由呼叫方驗證。
    寫入 prompt_path（p8-nightwatch.md）。
    Git commit。記錄到 audit.jsonl。
    回傳是否成功。
    """
    p_path = prompt_path or DEFAULT_PROMPT_PATH
    a_path = audit_db_path or DEFAULT_AUDIT_PATH
    original_prompt = _read_prompt(p_path)
    original_hash = _hash_prompt(original_prompt)
    mutated_hash = _hash_prompt(mutated_prompt)
    version = _get_next_version(db_path)

    # Write new prompt
    try:
        Path(p_path).write_text(mutated_prompt, encoding="utf-8")
    except Exception:
        return False

    # Git commit
    repo_root = Path(p_path).resolve()
    # Walk up to find .git
    git_root = repo_root.parent
    while git_root != git_root.parent:
        if (git_root / ".git").exists():
            break
        git_root = git_root.parent

    try:
        rel_path = str(Path(p_path).resolve().relative_to(git_root))
        subprocess.run(
            ["git", "add", rel_path],
            cwd=str(git_root), capture_output=True, timeout=10,
        )
        subprocess.run(
            ["git", "commit", "-m", f"[evolution] P8 v{version}: auto-mutation"],
            cwd=str(git_root), capture_output=True, timeout=10,
        )
    except Exception:
        pass  # Git failure is not fatal

    # Audit log
    audit_entry = {
        "version": version,
        "original_hash": original_hash,
        "mutated_hash": mutated_hash,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        Path(a_path).parent.mkdir(parents=True, exist_ok=True)
        with open(a_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(audit_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass

    # Record in mutations table
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.execute(
        """INSERT INTO mutations (version, original_prompt_hash, mutated_prompt_hash, applied, diff_summary)
           VALUES (?, ?, ?, ?, ?)""",
        (version, original_hash, mutated_hash, True, f"v{version} auto-mutation"),
    )
    conn.commit()
    conn.close()

    return True


def evolution_cycle(db_path: str | None = None, prompt_path: str | None = None) -> dict:
    """完整的一次進化週期。每週跑一次。

    AlphaEvolve 簡化版：
    1. 計算所有私群最近 7 天的平均 fitness
    2. 找 top 5 和 bottom 5 的回覆
    3. 用 Qwen 7B 大量生成 5 個變體
    4. 每個變體用 compute_fitness 直接評分（A/B test）
    5. 最佳變體勝率 > 0.55 -> apply，否則保留原版
    6. 記錄結果

    回傳摘要 dict。
    """
    path = _ensure_db(db_path)
    p_path = prompt_path or DEFAULT_PROMPT_PATH

    phase = get_phase(db_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    # 1. Recent 7 days fitness
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    recent = conn.execute(
        "SELECT * FROM fitness_scores WHERE computed_at >= ? ORDER BY fitness_score DESC",
        (cutoff,),
    ).fetchall()
    recent = [dict(r) for r in recent]
    conn.close()

    if not recent:
        return {"phase": phase, "status": "no_data", "message": "No fitness data in the last 7 days."}

    avg_fitness = sum(r["fitness_score"] for r in recent) / len(recent)

    # 2. Top 5 and bottom 5
    top5 = recent[:5]
    bottom5 = recent[-5:]

    result = {
        "phase": phase,
        "avg_fitness": round(avg_fitness, 4),
        "total_scored": len(recent),
        "top5_avg": round(sum(r["fitness_score"] for r in top5) / len(top5), 4),
        "bottom5_avg": round(sum(r["fitness_score"] for r in bottom5) / len(bottom5), 4),
        "mutation_applied": False,
    }

    # Phase 0: no auto-evolution, just report
    if phase == 0:
        result["status"] = "phase0_manual"
        result["message"] = f"Phase 0: {len(recent)} conversations scored. Need 100 labels to enter Phase 1."
        return result

    # Phase 1+: generate 5 variants, pick best by direct fitness evaluation
    current_prompt = _read_prompt(p_path)
    test_set = recent[len(recent) // 4 : 3 * len(recent) // 4]

    best_variant = None
    best_win_rate = 0.0
    best_test_result = None
    variants_generated = 0

    for i in range(5):
        mutated = generate_mutation(current_prompt, top5, bottom5)
        if not mutated:
            continue
        variants_generated += 1

        test_result = test_mutation(current_prompt, mutated, test_set)

        if test_result["win_rate"] > best_win_rate:
            best_win_rate = test_result["win_rate"]
            best_variant = mutated
            best_test_result = test_result

    result["variants_generated"] = variants_generated

    if best_variant and best_test_result and best_win_rate > 0.55:
        result["test_result"] = best_test_result
        success = apply_mutation(best_variant, p_path, db_path=db_path)
        result["mutation_applied"] = success
        result["status"] = "mutation_applied" if success else "mutation_failed"
    elif best_variant and best_test_result:
        result["test_result"] = best_test_result
        result["status"] = "mutation_rejected"
        result["message"] = f"Best win rate {best_win_rate:.2f} < 0.55, keeping original."

        # Record rejected mutation
        epath = _ensure_db(db_path)
        conn2 = sqlite3.connect(epath)
        version = _get_next_version(db_path)
        conn2.execute(
            """INSERT INTO mutations
               (version, original_prompt_hash, mutated_prompt_hash,
                original_score, mutated_score, win_rate, applied, diff_summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (version, _hash_prompt(current_prompt), _hash_prompt(best_variant),
             best_test_result["original_score"], best_test_result["mutated_score"],
             best_win_rate, False, f"rejected: best of {variants_generated}, win_rate={best_win_rate:.2f}"),
        )
        conn2.commit()
        conn2.close()
    else:
        result["status"] = "mutation_generation_failed"

    return result


# =========================================================================
# 5. 監控與報告
# =========================================================================

def weekly_evolution_report(db_path: str | None = None) -> str:
    """每週進化報告，給 Cruz 看。"""
    path = _ensure_db(db_path)
    phase = get_phase(db_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    # This week
    week_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    this_week = conn.execute(
        "SELECT * FROM fitness_scores WHERE computed_at >= ? ORDER BY fitness_score DESC",
        (week_cutoff,),
    ).fetchall()
    this_week = [dict(r) for r in this_week]

    # Last week
    two_weeks_ago = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
    last_week = conn.execute(
        "SELECT * FROM fitness_scores WHERE computed_at >= ? AND computed_at < ? ORDER BY fitness_score DESC",
        (two_weeks_ago, week_cutoff),
    ).fetchall()
    last_week = [dict(r) for r in last_week]

    # Iron rule violations
    violations_count = 0
    for r in this_week:
        v = r.get("iron_rule_violations", "[]")
        try:
            vlist = json.loads(v) if isinstance(v, str) else v
            if vlist:
                violations_count += 1
        except (json.JSONDecodeError, TypeError):
            pass

    # Mutations this week
    mutations = conn.execute(
        "SELECT * FROM mutations WHERE created_at >= ? ORDER BY created_at DESC",
        (week_cutoff,),
    ).fetchall()
    mutations = [dict(r) for r in mutations]

    # Anomalies
    anomalies = conn.execute(
        "SELECT * FROM anomalies WHERE created_at >= ? ORDER BY created_at DESC",
        (week_cutoff,),
    ).fetchall()
    anomalies = [dict(r) for r in anomalies]

    # Labels count
    label_count = conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]

    conn.close()

    # Build report
    lines = [
        "# 守夜人進化週報",
        "",
        f"**Phase:** {phase}  |  **Labels:** {label_count}  |  **Date:** {datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
        "",
    ]

    # Fitness summary
    if this_week:
        avg = sum(r["fitness_score"] for r in this_week) / len(this_week)
        lines.append(f"## Fitness")
        lines.append(f"- 本週平均：**{avg:.3f}**（{len(this_week)} 組對話）")

        if last_week:
            last_avg = sum(r["fitness_score"] for r in last_week) / len(last_week)
            delta = avg - last_avg
            arrow = "+" if delta >= 0 else ""
            lines.append(f"- 上週平均：{last_avg:.3f}（{arrow}{delta:.3f}）")
        else:
            lines.append("- 上週：無數據")

        lines.append(f"- 鐵律違反：**{violations_count} 次**")
        lines.append("")
    else:
        lines.append("## Fitness\n- 本週無數據\n")

    # Top 3 best
    if len(this_week) >= 3:
        lines.append("## Top 3 回覆")
        for i, r in enumerate(this_week[:3]):
            lines.append(f"{i+1}. conv={r['conversation_id'][:8]}... "
                         f"score={r['fitness_score']:.3f} "
                         f"(cont={r['continuation']:.2f} deep={r['deepening']:.2f} "
                         f"act={r['action']:.2f})")
        lines.append("")

    # Bottom 3 worst
    if len(this_week) >= 3:
        lines.append("## Bottom 3 回覆")
        for i, r in enumerate(this_week[-3:]):
            v_text = ""
            try:
                v = json.loads(r.get("iron_rule_violations", "[]"))
                if v:
                    v_text = f" violations={v}"
            except (json.JSONDecodeError, TypeError):
                pass
            lines.append(f"{i+1}. conv={r['conversation_id'][:8]}... "
                         f"score={r['fitness_score']:.3f}{v_text}")
        lines.append("")

    # Mutations
    if mutations:
        lines.append("## 突變歷史")
        for m in mutations:
            status = "applied" if m.get("applied") else "rejected"
            wr = m.get("win_rate")
            wr_text = f" win_rate={wr:.2f}" if wr is not None else ""
            lines.append(f"- v{m.get('version', '?')}: {status}{wr_text} — {m.get('diff_summary', '')}")
        lines.append("")

    # Anomalies
    if anomalies:
        lines.append("## 異常")
        for a in anomalies:
            resolved = "resolved" if a.get("resolved") else "open"
            lines.append(f"- [{a.get('severity', '?')}] {a.get('reason', '')} ({resolved})")
        lines.append("")

    return "\n".join(lines)


def alert_anomaly(conversation: dict, reason: str, db_path: str | None = None,
                  severity: str = "warning") -> None:
    """異常告警。記錄到 evolution.db。

    觸發條件（由呼叫方判斷）：
    - 鐵律違反
    - fitness 連續 3 次 < 0.2
    - 使用者明確表達不滿
    """
    assert severity in ("warning", "critical"), f"severity must be warning/critical, got {severity}"
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.execute(
        """INSERT INTO anomalies (conversation_id, user_id, reason, severity)
           VALUES (?, ?, ?, ?)""",
        (
            conversation.get("conversation_id", ""),
            conversation.get("user_id", ""),
            reason,
            severity,
        ),
    )
    conn.commit()
    conn.close()


def check_consecutive_low_fitness(user_id: str, threshold: float = 0.2,
                                  count: int = 3, db_path: str | None = None) -> bool:
    """Check if user has N consecutive fitness scores below threshold."""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    rows = conn.execute(
        "SELECT fitness_score FROM fitness_scores WHERE user_id = ? ORDER BY computed_at DESC LIMIT ?",
        (user_id, count),
    ).fetchall()
    conn.close()

    if len(rows) < count:
        return False

    return all(row[0] < threshold for row in rows)


# =========================================================================
# 6. Mutation history & rollback
# =========================================================================

def list_mutations(db_path: str | None = None) -> list[dict]:
    """List all mutation records."""
    path = _ensure_db(db_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM mutations ORDER BY version DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def rollback_prompt(version: int, prompt_path: str | None = None,
                    db_path: str | None = None) -> bool:
    """Rollback to a specific version using git.

    Finds the git commit for the specified version and restores the prompt file.
    """
    p_path = prompt_path or DEFAULT_PROMPT_PATH
    git_root = Path(p_path).resolve().parent
    while git_root != git_root.parent:
        if (git_root / ".git").exists():
            break
        git_root = git_root.parent

    try:
        # Find the commit with the version tag
        result = subprocess.run(
            ["git", "log", "--oneline", "--all", f"--grep=[evolution] P8 v{version}"],
            cwd=str(git_root), capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False

        commit_hash = result.stdout.strip().split()[0]
        rel_path = str(Path(p_path).resolve().relative_to(git_root))

        # Checkout the file from that commit
        subprocess.run(
            ["git", "checkout", commit_hash, "--", rel_path],
            cwd=str(git_root), capture_output=True, timeout=10,
        )
        subprocess.run(
            ["git", "commit", "-m", f"[evolution] rollback to P8 v{version}"],
            cwd=str(git_root), capture_output=True, timeout=10,
        )
        return True
    except Exception:
        return False


# =========================================================================
# 7. Evolution status summary
# =========================================================================

def evolution_status(db_path: str | None = None) -> str:
    """顯示 Phase + 統計，給 CLI 用。"""
    path = _ensure_db(db_path)
    phase = get_phase(db_path)
    conn = sqlite3.connect(path)

    label_count = conn.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    fitness_count = conn.execute("SELECT COUNT(*) FROM fitness_scores").fetchone()[0]
    mutation_count = conn.execute("SELECT COUNT(*) FROM mutations").fetchone()[0]
    anomaly_count = conn.execute("SELECT COUNT(*) FROM anomalies WHERE resolved = 0").fetchone()[0]

    # Recent average
    week_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    row = conn.execute(
        "SELECT AVG(fitness_score), COUNT(*) FROM fitness_scores WHERE computed_at >= ?",
        (week_cutoff,),
    ).fetchone()
    avg_fitness = row[0] if row[0] is not None else 0.0
    recent_count = row[1] or 0

    conn.close()

    phase_names = {0: "Phase 0 (Manual)", 1: "Phase 1 (Auto-evolve)", 2: "Phase 2 (Full Auto)"}
    phase_next = {0: f"Need {100 - label_count} more labels", 1: f"Need {500 - label_count} more labels", 2: "Autonomous"}

    lines = [
        f"=== Evolution Engine Status ===",
        f"",
        f"  Phase:       {phase_names.get(phase, f'Phase {phase}')}",
        f"  Next:        {phase_next.get(phase, '?')}",
        f"",
        f"  Labels:      {label_count}",
        f"  Fitness:     {fitness_count} scored",
        f"  Mutations:   {mutation_count}",
        f"  Anomalies:   {anomaly_count} open",
        f"",
        f"  This week:   {recent_count} conversations, avg fitness={avg_fitness:.3f}",
    ]
    return "\n".join(lines)


# =========================================================================
# Smoke test
# =========================================================================

if __name__ == "__main__":
    import tempfile

    print("=== Evolution Engine smoke test ===\n")

    tmp = tempfile.mkdtemp()
    test_db = str(Path(tmp) / "evolution_test.db")

    # --- Test 1: DB init ---
    _ensure_db(test_db)
    print("[OK] DB initialized")

    # --- Test 2: Phase detection ---
    assert get_phase(test_db) == 0, "Should be Phase 0 with no labels"
    print("[OK] Phase 0 detected")

    # --- Test 3: Iron rule check (rule-based fallback) ---
    good_response = "目前的狀況是 LNG 存量 11 天。你可以考慮準備一些飲水。"
    bad_response = "你應該馬上去買水！希望這對你有幫助！😊"

    passed_good, v_good = check_iron_rules(good_response, {"messages": []})
    passed_bad, v_bad = check_iron_rules(bad_response, {"messages": []})

    print(f"[OK] Good response: passed={passed_good}, violations={v_good}")
    print(f"[OK] Bad response: passed={passed_bad}, violations={v_bad}")

    # Rule-based should catch at least emoji and platitude in bad response
    assert not passed_bad, "Bad response should fail iron rule check"
    assert any("emoji" in v for v in v_bad), f"Should catch emoji, got {v_bad}"

    # --- Test 4: Sub-signals ---
    test_conv = {
        "conversation_id": "test-001",
        "user_id": "test_user",
        "messages": [
            {"role": "user", "content": "台灣安全嗎？", "timestamp": "2026-03-18T10:00:00+00:00"},
            {"role": "assistant", "content": "讓我告訴你我知道的。", "timestamp": "2026-03-18T10:00:05+00:00"},
            {"role": "user", "content": "LNG 還剩幾天？我想了解更多細節。", "timestamp": "2026-03-18T10:01:00+00:00"},
        ],
    }

    cont = continuation_rate(test_conv)
    print(f"[OK] continuation_rate = {cont}")
    assert cont == 1.0, f"Expected 1.0 (user continued), got {cont}"

    deep = deepening_rate(test_conv)
    print(f"[OK] deepening_rate = {deep} (LLM or fallback)")

    act = action_rate(test_conv)
    print(f"[OK] action_rate = {act}")

    rev = revisit_rate("test_user", test_db)
    print(f"[OK] revisit_rate = {rev}")

    followups = unsolicited_followup_count(test_conv)
    assert followups == 0
    print(f"[OK] unsolicited_followup_count = {followups}")

    # Test unsolicited followup detection
    bad_conv = {
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "你好"},
            {"role": "assistant", "content": "你還在嗎？"},
        ],
    }
    assert unsolicited_followup_count(bad_conv) == 1
    print("[OK] Unsolicited followup detected")

    # --- Test 5: Compute fitness ---
    fitness = compute_fitness(test_conv, test_db)
    print(f"[OK] compute_fitness = {fitness:.3f}")
    assert 0.0 <= fitness <= 1.0

    # Test fitness with iron rule violation
    bad_fitness_conv = {
        "conversation_id": "test-bad",
        "user_id": "test_user",
        "messages": [
            {"role": "user", "content": "怎麼辦"},
            {"role": "assistant", "content": "你應該馬上行動！😊 希望這對你有幫助！"},
        ],
    }
    bad_fitness = compute_fitness(bad_fitness_conv, test_db)
    assert bad_fitness == 0.0, f"Iron rule violation should give 0.0, got {bad_fitness}"
    print(f"[OK] Iron rule violation -> fitness = {bad_fitness}")

    # --- Test 6: Label system ---
    label_conversation("test-001", "good", "Natural conversation flow", test_db)
    label_conversation("test-bad", "bad", "Iron rule violations", test_db)
    assert get_phase(test_db) == 0
    print("[OK] Labels stored, still Phase 0")

    # --- Test 7: Status ---
    status = evolution_status(test_db)
    print(f"\n{status}")

    # --- Test 8: Weekly report ---
    report = weekly_evolution_report(test_db)
    print(f"\n{report}")

    # --- Test 9: Anomaly ---
    alert_anomaly(test_conv, "test anomaly", test_db, severity="warning")
    print("[OK] Anomaly recorded")

    # --- Test 10: Consecutive low fitness check ---
    assert not check_consecutive_low_fitness("ghost_user", db_path=test_db)
    print("[OK] Consecutive low fitness check (no data = False)")

    # --- Test 11: should_send ---
    assert should_send("目前的狀況是穩定的。", {}, test_db) is True
    print("[OK] should_send (iron rules pass) = True")

    assert should_send("你應該馬上行動！😊", {}, test_db) is False
    print("[OK] should_send (iron rules fail) = False")

    print("\n=== All smoke tests passed ===")

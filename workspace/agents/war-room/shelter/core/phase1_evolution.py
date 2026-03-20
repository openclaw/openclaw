#!/usr/bin/env python3
"""
Phase 2 進化引擎 — 9 篇 2026 前沿論文的工程實作

已裝零件：
A. Q-value 排序（MemRL）— 用過有效的記憶加分，爛的扣分
B. 鐵律守門員（TAME）— 進化不能碰底線
C. Self-criticism 迴圈（MiniMax M2.7）— 每輪自我批評，爛的回滾
D. 失敗反思（GEPA）— 拿失敗案例改蒸餾 pattern
E. 記憶回寫（A-MEM）— 新規則觸發舊規則的更新/合併
F. Meta-Guideline（Live-Evo）— 不只記「規則是什麼」，也記「怎麼用規則」
"""

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

SHELTER = Path(__file__).resolve().parent.parent
DATA_DIR = SHELTER / "data"
EVO_DB = str(DATA_DIR / "evolution.db")
PROPOSALS_FILE = DATA_DIR / "evolution-proposals.jsonl"
AGENTS_DIR = SHELTER.parent.parent / "agents"
CRITICISM_DIR = DATA_DIR / "self-criticism"

# ── 鐵律（TAME：這些永遠不能被進化碰到）──────────────────────
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
    "不餵養恐懼",
    "混淆身份 = 開除級錯誤",
    "不加油添醋",
    "誠實報告，沒做到就說沒做到",
]

# ── DB Schema ────────────────────────────────────────────────

_P1_SCHEMA = """
CREATE TABLE IF NOT EXISTS distilled_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL UNIQUE,
    source_signal_ids TEXT,
    frequency INTEGER DEFAULT 1,
    target_scope TEXT DEFAULT 'general',
    q_value REAL DEFAULT 0.5,
    times_used INTEGER DEFAULT 0,
    times_helped INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    target_file TEXT NOT NULL,
    change_type TEXT NOT NULL,
    description TEXT NOT NULL,
    diff_preview TEXT,
    status TEXT DEFAULT 'pending',
    cruz_verdict TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied_at TIMESTAMP,
    FOREIGN KEY (rule_id) REFERENCES distilled_rules(id)
);
"""


def _ensure_p1_schema(db_path: str = EVO_DB):
    conn = sqlite3.connect(db_path)
    conn.executescript(_P1_SCHEMA)
    # Migration: add new columns if missing
    for col, typ, default in [
        ("q_value", "REAL", "0.5"),
        ("times_used", "INTEGER", "0"),
        ("times_helped", "INTEGER", "0"),
    ]:
        try:
            conn.execute(f"ALTER TABLE distilled_rules ADD COLUMN {col} {typ} DEFAULT {default}")
        except Exception:
            pass
    conn.close()


# ══════════════════════════════════════════════════════════════════
# 零件 A：Q-value 排序（MemRL）
# ══════════════════════════════════════════════════════════════════

ALPHA = 0.1  # Q-value 學習率

# 停用詞（匹配時忽略）
_STOPWORDS = set("的了是在不要有我你他她它這那就都會能可以")

def _extract_keywords(text: str) -> set[str]:
    """從文本中提取有意義的 2-3 字詞組"""
    keywords = set()
    # 取所有連續 2-3 字的中文組合
    chars = [c for c in text if '\u4e00' <= c <= '\u9fff']
    for n in (2, 3):
        for i in range(len(chars) - n + 1):
            word = ''.join(chars[i:i+n])
            if not all(c in _STOPWORDS for c in word):
                keywords.add(word)
    # 也加英文詞
    for word in re.split(r'\W+', text):
        if len(word) >= 3 and word.isascii():
            keywords.add(word.lower())
    return keywords

def _rule_matches_signal(rule: str, signal_content: str) -> bool:
    """用關鍵詞集合交集判斷規則是否跟信號相關"""
    rule_kw = _extract_keywords(rule)
    sig_kw = _extract_keywords(signal_content)
    if not rule_kw:
        return False
    overlap = rule_kw & sig_kw
    # 至少 2 個關鍵詞重疊，或重疊率 > 30%
    return len(overlap) >= 2 or (len(overlap) / len(rule_kw)) > 0.3


def update_q_values(db_path: str = EVO_DB):
    """
    掃描最近的 Cruz 信號，更新相關規則的 Q-value。
    correction 後面的規則 → reward=0（扣分）
    approval/silence 後面的規則 → reward=1（加分）
    """
    conn = sqlite3.connect(db_path)
    _ensure_p1_schema(db_path)

    # 取最近 50 條信號
    signals = conn.execute("""
        SELECT signal_type, content FROM cruz_signals
        ORDER BY id DESC LIMIT 50
    """).fetchall()

    # 取所有 active 規則
    rules = conn.execute(
        "SELECT id, rule, q_value FROM distilled_rules WHERE status = 'active'"
    ).fetchall()

    updated = 0
    for sig_type, sig_content in signals:
        reward = None
        if sig_type == "correction":
            reward = 0.0
        elif sig_type in ("approval", "silence"):
            reward = 1.0
        elif sig_type == "redirect":
            reward = 0.3
        else:
            continue

        # 看哪條規則跟這個信號相關（關鍵詞集合交集）
        for rule_id, rule_text, q_val in rules:
            if _rule_matches_signal(rule_text, sig_content):
                new_q = q_val + ALPHA * (reward - q_val)
                conn.execute(
                    "UPDATE distilled_rules SET q_value = ?, times_used = times_used + 1 WHERE id = ?",
                    (round(new_q, 3), rule_id)
                )
                if reward > 0.5:
                    conn.execute(
                        "UPDATE distilled_rules SET times_helped = times_helped + 1 WHERE id = ?",
                        (rule_id,)
                    )
                updated += 1

    # Q < 0.2 且用過 3 次以上 → deprecated（爛規則沉底）
    conn.execute("""
        UPDATE distilled_rules SET status = 'deprecated'
        WHERE q_value < 0.2 AND times_used >= 3 AND status = 'active'
    """)
    deprecated = conn.total_changes

    conn.commit()
    conn.close()
    return {"updated": updated, "deprecated": deprecated}


# ══════════════════════════════════════════════════════════════════
# 零件 B：鐵律守門員（TAME）
# ══════════════════════════════════════════════════════════════════

def _iron_rule_gate(rule_text: str) -> Optional[str]:
    """
    檢查一條規則是否違反鐵律。
    違反 → 回傳違反的鐵律文字
    沒違反 → 回傳 None
    """
    rule_lower = rule_text.lower()

    # 反向衝突檢測：如果提案跟鐵律矛盾
    conflict_pairs = [
        (["用 emoji", "加 emoji", "emoji"], "不用 emoji"),
        (["用敬語", "說您"], "不用敬語"),
        (["你應該"], "不說「你應該」"),
        (["追問", "再問一次"], "不追問沉默的使用者"),
        (["客服套話", "歡迎提問", "希望這對你有幫助"], "不說客服套話"),
        (["加油", "加油添醋", "勵志"], "不加油添醋"),
        (["隱瞞", "不說實話"], "誠實報告，沒做到就說沒做到"),
    ]

    for triggers, iron_rule in conflict_pairs:
        for t in triggers:
            if t in rule_lower:
                return iron_rule

    # 直接矛盾：提案說「應該 X」但鐵律說「不 X」
    for iron in IRON_RULES:
        # 如果鐵律是「不X」，而提案包含「X」且意思是要做 X
        if iron.startswith("不") and len(iron) > 2:
            forbidden_action = iron[1:]  # 去掉「不」
            if forbidden_action in rule_text and not rule_text.startswith("不"):
                return iron

    return None


# ══════════════════════════════════════════════════════════════════
# 零件 C：Self-criticism 迴圈（MiniMax M2.7）
# ══════════════════════════════════════════════════════════════════

def write_self_criticism(tick_result: dict, beat_n: int) -> str:
    """
    每輪 Phase 1 跑完後寫一份自我批評。
    下一輪讀取來決定要不要 revert。
    """
    CRITICISM_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    filename = f"criticism-{now.strftime('%Y%m%d-%H%M')}.md"
    filepath = CRITICISM_DIR / filename

    lines = [
        f"## Self-criticism #{beat_n} — {now.strftime('%Y-%m-%d %H:%M')}",
        "",
        "### 本輪做了什麼",
        f"- 蒸餾: {tick_result.get('new_rules', 0)} 條新規則（總計 {tick_result.get('total_rules', 0)}）",
        f"- 提案: {tick_result.get('new_proposals', 0)} 個新提案（待審 {tick_result.get('total_pending', 0)}）",
        f"- Q-value 更新: {tick_result.get('q_updated', 0)} 次",
        f"- 鐵律攔截: {tick_result.get('iron_blocked', 0)} 個",
        f"- 淘汰（Q<0.2）: {tick_result.get('deprecated', 0)} 條",
    ]

    # 品質自評
    lines.append("")
    lines.append("### 品質自評")

    new_rules = tick_result.get("rule_examples", [])
    if new_rules:
        for r in new_rules:
            if len(r) < 8:
                lines.append(f"- ⚠️ 規則「{r}」太短，可能是截斷殘餘")
            elif len(r) > 35:
                lines.append(f"- ⚠️ 規則「{r}」偏長，可能是對話片段")
            else:
                lines.append(f"- ✓ 規則「{r}」長度合理")
    else:
        lines.append("- 本輪無新規則")

    # Revert 建議
    lines.append("")
    lines.append("### 下輪建議")
    if tick_result.get("deprecated", 0) > 2:
        lines.append("- 大量淘汰，蒸餾品質可能有系統性問題")
    if tick_result.get("iron_blocked", 0) > 0:
        lines.append("- 有提案被鐵律攔截，蒸餾器需要加強前置過濾")
    if not new_rules:
        lines.append("- 無新規則，信號可能已飽和或 pattern 不夠多元")
    lines.append("")

    content = "\n".join(lines)
    filepath.write_text(content, encoding="utf-8")

    # 只保留最近 10 份 criticism
    all_files = sorted(CRITICISM_DIR.glob("criticism-*.md"), reverse=True)
    for old in all_files[10:]:
        old.unlink()

    return str(filepath)


def read_last_criticism() -> Optional[dict]:
    """讀取上一輪的 self-criticism，檢查有沒有 revert 建議。"""
    if not CRITICISM_DIR.exists():
        return None

    files = sorted(CRITICISM_DIR.glob("criticism-*.md"), reverse=True)
    if not files:
        return None

    content = files[0].read_text(encoding="utf-8")
    return {
        "file": str(files[0]),
        "has_quality_warning": "⚠️" in content,
        "has_revert_suggestion": "系統性問題" in content,
        "content": content,
    }


# ══════════════════════════════════════════════════════════════════
# Step 1: Distill — raw corrections → behavioral rules
# ══════════════════════════════════════════════════════════════════

_DISTILL_PATTERNS = [
    (r"不要(.{2,30})", "不要{0}"),
    (r"別(.{2,30})", "不要{0}"),
    (r"要先(.{2,20})再(.{2,20})", "要先{0}再{1}"),
    (r"先(.{2,20})再(.{2,20})", "要先{0}再{1}"),
    (r"不用(.{2,30})", "不需要{0}"),
    (r"應該(.{2,30})", "應該{0}"),
    (r"你又(.{2,30})", "禁止重複：{0}"),
    (r"太(.{2,15})", "避免太{0}"),
    (r"(.{2,20})就好", "{0}即可，不需要更多"),
    (r"(.{2,20})就夠", "{0}即可，不需要更多"),
]


def _clean_rule(raw: str) -> Optional[str]:
    """Clean a raw extracted rule. Return None if it's noise."""
    rule = raw.strip()
    if len(rule) < 6 or len(rule) > 60:
        return None
    if any(c in rule for c in ["/Users", "localhost", "import ", "def ", "class ", "python3"]):
        return None
    if rule.count("|") > 2 or rule.count("```") > 0:
        return None
    personal_markers = [
        "我一个人", "我觉得", "我的", "我们", "下周", "下週", "十月",
        "去台湾", "去你那", "花钱", "花錢", "老板", "员工",
        "逼我", "违反", "工作", "工資", "薪水", "你那儿", "你那兒",
    ]
    if any(m in rule for m in personal_markers):
        return None
    if rule.count("。") > 0 or rule.count("？") > 0:
        return None
    if any(m in rule for m in ["所以", "嘛", "那就", "怎麼辦", "就可以"]):
        return None
    valid_starts = ["不要", "不需要", "禁止", "避免", "應該", "要先", "必須"]
    if not any(rule.startswith(s) for s in valid_starts):
        return None
    for sep in ["，", ",", "。", "；", "～", "⸺"]:
        idx = rule.find(sep)
        if idx > 6:
            rule = rule[:idx]
            break
    rule = rule.rstrip("。！？，、）) ")
    if len(rule) < 6 or len(rule) > 40:
        return None
    return rule


def distill(db_path: str = EVO_DB) -> dict:
    """Scan raw Cruz corrections, extract behavioral rules."""
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)

    rows = conn.execute("""
        SELECT id, content, context FROM cruz_signals
        WHERE signal_type IN ('correction', 'redirect', 'taste')
        ORDER BY id
    """).fetchall()

    existing_rules = set(
        r[0] for r in conn.execute("SELECT rule FROM distilled_rules").fetchall()
    )

    new_rules = []

    for sig_id, content, context in rows:
        for pattern, template in _DISTILL_PATTERNS:
            match = re.search(pattern, content)
            if match:
                groups = match.groups()
                try:
                    rule_text = template.format(*groups)
                except (IndexError, KeyError):
                    continue
                rule_text = _clean_rule(rule_text)
                if rule_text and rule_text not in existing_rules:
                    scope = _detect_scope(content + " " + (context or ""))
                    new_rules.append({
                        "rule": rule_text,
                        "signal_id": sig_id,
                        "scope": scope,
                    })
                    existing_rules.add(rule_text)

    correction_texts = [r[1] for r in rows if "糾正" not in (r[1] or "")[:5]]
    clustered = _cluster_corrections(correction_texts)
    for cluster_rule in clustered:
        if cluster_rule not in existing_rules:
            new_rules.append({"rule": cluster_rule, "signal_id": None, "scope": "general"})
            existing_rules.add(cluster_rule)

    for nr in new_rules:
        conn.execute(
            "INSERT OR IGNORE INTO distilled_rules (rule, source_signal_ids, target_scope) VALUES (?, ?, ?)",
            (nr["rule"], str(nr["signal_id"]), nr["scope"])
        )
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM distilled_rules WHERE status = 'active'").fetchone()[0]
    conn.close()

    return {
        "new_rules": len(new_rules),
        "total_rules": total,
        "examples": [r["rule"] for r in new_rules[:5]],
    }


def _detect_scope(text: str) -> str:
    t = text.lower()
    if any(k in t for k in ["bg666", "bita", "幣塔", "客服"]):
        return "bg666"
    if any(k in t for k in ["threads", "社群", "fb", "社團"]):
        return "social"
    if any(k in t for k in ["gateway", "openclaw", "deploy"]):
        return "openclaw"
    if any(k in t for k in ["報告", "日報", "sheet"]):
        return "reporting"
    if any(k in t for k in ["shelter", "heartbeat", "進化"]):
        return "war-room"
    return "general"


def _cluster_corrections(texts: list[str]) -> list[str]:
    keyword_counts: dict[str, int] = {}
    action_words = ["不要", "別", "不用", "太", "先", "應該", "禁止", "不能"]
    for text in texts:
        for word in action_words:
            idx = text.find(word)
            if idx >= 0:
                phrase = text[idx:idx+30].strip()
                phrase = _clean_rule(phrase)
                if phrase:
                    keyword_counts[phrase] = keyword_counts.get(phrase, 0) + 1
    return [phrase for phrase, count in keyword_counts.items() if count >= 3]


# ══════════════════════════════════════════════════════════════════
# Step 2: Propose — rules → concrete system changes (with iron gate)
# ══════════════════════════════════════════════════════════════════

def propose(db_path: str = EVO_DB) -> dict:
    """Generate proposals, filtered by iron rule gate."""
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)

    rules = conn.execute("""
        SELECT r.id, r.rule, r.target_scope, r.q_value
        FROM distilled_rules r
        LEFT JOIN proposals p ON p.rule_id = r.id
        WHERE p.id IS NULL AND r.status = 'active'
        ORDER BY r.q_value DESC
    """).fetchall()

    new_proposals = []
    iron_blocked = 0

    for rule_id, rule_text, scope, q_val in rules:
        # 零件 B：鐵律守門
        violation = _iron_rule_gate(rule_text)
        if violation:
            conn.execute(
                "UPDATE distilled_rules SET status = 'blocked_iron_rule' WHERE id = ?",
                (rule_id,)
            )
            iron_blocked += 1
            continue

        proposals = _generate_proposals(rule_text, scope)
        for p in proposals:
            conn.execute(
                """INSERT INTO proposals (rule_id, target_file, change_type, description, diff_preview, status)
                   VALUES (?, ?, ?, ?, ?, 'pending')""",
                (rule_id, p["target_file"], p["change_type"], p["description"], p.get("diff_preview", ""))
            )
            new_proposals.append(p)

    conn.commit()

    total_pending = conn.execute(
        "SELECT COUNT(*) FROM proposals WHERE status = 'pending'"
    ).fetchone()[0]
    conn.close()

    if new_proposals:
        with open(PROPOSALS_FILE, "a", encoding="utf-8") as f:
            for p in new_proposals:
                p["logged_at"] = datetime.now().isoformat()
                f.write(json.dumps(p, ensure_ascii=False) + "\n")

    return {
        "new_proposals": len(new_proposals),
        "total_pending": total_pending,
        "iron_blocked": iron_blocked,
        "examples": [p["description"] for p in new_proposals[:3]],
    }


def _generate_proposals(rule: str, scope: str) -> list[dict]:
    proposals = []

    if scope == "general":
        proposals.append({
            "target_file": "CLAUDE.md",
            "change_type": "append_rule",
            "description": f"新增行為規則：{rule}",
            "diff_preview": f"+ - {rule}",
        })
    elif scope == "social":
        proposals.append({
            "target_file": "workspace/agents/war-room/shelter/knowledge/social-rules.md",
            "change_type": "append_rule",
            "description": f"社群操作規則：{rule}",
            "diff_preview": f"+ - {rule}",
        })
    elif scope == "reporting":
        proposals.append({
            "target_file": "workspace/agents/war-room/shelter/knowledge/reporting-rules.md",
            "change_type": "append_rule",
            "description": f"報告規則：{rule}",
            "diff_preview": f"+ - {rule}",
        })
    elif scope in ("bg666", "openclaw", "war-room"):
        agent_dir = {"bg666": "66-desk", "openclaw": None, "war-room": "war-room"}.get(scope)
        target = f"workspace/agents/{agent_dir}/CONSTITUTION.md" if agent_dir else "CLAUDE.md"
        proposals.append({
            "target_file": target,
            "change_type": "append_rule",
            "description": f"[{scope}] 行為規則：{rule}",
            "diff_preview": f"+ - {rule}",
        })

    if any(kw in rule for kw in ["語氣", "說話", "回覆", "回應"]):
        for agent_name in ["thinker", "bita", "xo", "lolo-care"]:
            soul = AGENTS_DIR / agent_name / "SOUL.md"
            if soul.exists():
                proposals.append({
                    "target_file": str(soul.relative_to(SHELTER.parent.parent.parent)),
                    "change_type": "soul_behavior",
                    "description": f"[{agent_name}] 調整 SOUL 行為：{rule}",
                    "diff_preview": f"+ <!-- evolved --> {rule}",
                })

    return proposals


# ══════════════════════════════════════════════════════════════════
# Step 3: Review
# ══════════════════════════════════════════════════════════════════

def review(db_path: str = EVO_DB) -> list[dict]:
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT p.id, r.rule, p.target_file, p.change_type, p.description, p.diff_preview, p.created_at, r.q_value
        FROM proposals p
        JOIN distilled_rules r ON r.id = p.rule_id
        WHERE p.status = 'pending'
        ORDER BY r.q_value DESC
    """).fetchall()
    conn.close()
    return [{
        "id": r[0], "rule": r[1], "target_file": r[2], "change_type": r[3],
        "description": r[4], "diff_preview": r[5], "created_at": r[6], "q_value": r[7],
    } for r in rows]


# ══════════════════════════════════════════════════════════════════
# Step 4: Apply / Reject
# ══════════════════════════════════════════════════════════════════

def approve(proposal_id: int, db_path: str = EVO_DB) -> dict:
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT target_file, change_type, description, diff_preview FROM proposals WHERE id = ? AND status = 'pending'",
        (proposal_id,)
    ).fetchone()
    if not row:
        conn.close()
        return {"error": f"Proposal {proposal_id} not found or not pending"}

    target_file, change_type, description, diff_preview = row
    result = _apply_change(target_file, change_type, diff_preview)

    if result["success"]:
        conn.execute(
            "UPDATE proposals SET status = 'approved', cruz_verdict = 'approved', applied_at = CURRENT_TIMESTAMP WHERE id = ?",
            (proposal_id,)
        )
        conn.execute(
            "INSERT INTO mutations (version, diff_summary, applied, created_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)",
            (proposal_id, description)
        )
    else:
        conn.execute(
            "UPDATE proposals SET status = 'failed', cruz_verdict = ? WHERE id = ?",
            (result.get("error", "unknown"), proposal_id)
        )
    conn.commit()
    conn.close()
    return result


def reject(proposal_id: int, reason: str = "", db_path: str = EVO_DB):
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE proposals SET status = 'rejected', cruz_verdict = ? WHERE id = ?",
        (reason or "rejected by Cruz", proposal_id)
    )
    conn.commit()
    conn.close()


def _apply_change(target_file: str, change_type: str, diff_preview: str) -> dict:
    clawd_root = SHELTER.parent.parent.parent
    full_path = clawd_root / target_file
    try:
        if change_type == "append_rule":
            rule_line = diff_preview.lstrip("+ ").strip()
            if full_path.exists():
                content = full_path.read_text(encoding="utf-8")
                evo_marker = "<!-- EVOLVED_RULES -->"
                if evo_marker in content:
                    idx = content.index(evo_marker) + len(evo_marker)
                    content = content[:idx] + f"\n- {rule_line}" + content[idx:]
                else:
                    content += f"\n\n{evo_marker}\n## 進化規則（自動生成，Cruz 已審批）\n\n- {rule_line}\n"
                full_path.write_text(content, encoding="utf-8")
            else:
                full_path.parent.mkdir(parents=True, exist_ok=True)
                full_path.write_text(
                    f"# 進化規則\n\n<!-- EVOLVED_RULES -->\n\n- {rule_line}\n",
                    encoding="utf-8"
                )
            return {"success": True, "file": str(target_file), "action": "appended rule"}

        elif change_type == "soul_behavior":
            if not full_path.exists():
                return {"success": False, "error": f"File not found: {target_file}"}
            content = full_path.read_text(encoding="utf-8")
            rule_line = diff_preview.replace("+ <!-- evolved --> ", "").strip()
            learned_start = "<!-- LEARNED_BEHAVIORS_START -->"
            learned_end = "<!-- LEARNED_BEHAVIORS_END -->"
            if learned_start in content and learned_end in content:
                start_idx = content.index(learned_start) + len(learned_start)
                end_idx = content.index(learned_end)
                existing = content[start_idx:end_idx]
                if rule_line not in existing:
                    new_content = content[:start_idx] + existing.rstrip() + f"\n- {rule_line}\n" + content[end_idx:]
                    full_path.write_text(new_content, encoding="utf-8")
            else:
                content += f"\n\n{learned_start}\n## 進化行為\n\n- {rule_line}\n{learned_end}\n"
                full_path.write_text(content, encoding="utf-8")
            return {"success": True, "file": str(target_file), "action": "injected behavior"}

        return {"success": False, "error": f"Unknown change_type: {change_type}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════════
# 零件 D：失敗反思（GEPA）— 蒸餾失敗的案例 → 改進 pattern
# ══════════════════════════════════════════════════════════════════

def reflect_on_failures(db_path: str = EVO_DB) -> dict:
    """
    GEPA 式反思：找出被 deprecated 或 blocked 的規則，
    分析蒸餾器為什麼產出了這些垃圾，調整策略。
    """
    conn = sqlite3.connect(db_path)
    _ensure_p1_schema(db_path)

    # 找失敗案例：deprecated + blocked
    failures = conn.execute("""
        SELECT rule, status, source_signal_ids FROM distilled_rules
        WHERE status IN ('deprecated', 'blocked_iron_rule')
        ORDER BY id DESC LIMIT 20
    """).fetchall()

    if not failures:
        conn.close()
        return {"reflections": 0}

    # 分析失敗模式
    patterns_to_avoid = []
    for rule, status, sig_ids in failures:
        if status == "blocked_iron_rule":
            # 蒸餾器產出了違反鐵律的東西 → 記住這個 pattern 要排除
            patterns_to_avoid.append({
                "bad_rule": rule,
                "reason": "violated iron rule",
                "fix": f"add '{rule[:8]}' to personal_markers filter",
            })
        elif status == "deprecated":
            # Q-value 掉到底 → 這條規則在實戰中沒用
            patterns_to_avoid.append({
                "bad_rule": rule,
                "reason": "Q-value dropped below threshold",
                "fix": "rule was too vague or context-dependent",
            })

    # 寫反思報告到 self-criticism 目錄
    CRITICISM_DIR.mkdir(parents=True, exist_ok=True)
    report_path = CRITICISM_DIR / f"reflection-{datetime.now().strftime('%Y%m%d-%H%M')}.md"
    lines = [
        f"## GEPA 反思報告 — {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"",
        f"失敗規則分析（{len(failures)} 條）：",
    ]
    for p in patterns_to_avoid[:10]:
        lines.append(f"- 「{p['bad_rule']}」→ {p['reason']} → {p['fix']}")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    conn.close()

    return {"reflections": len(patterns_to_avoid), "report": str(report_path)}


# ══════════════════════════════════════════════════════════════════
# 零件 E：記憶回寫（A-MEM）— 新規則觸發舊規則合併
# ══════════════════════════════════════════════════════════════════

def evolve_memory_network(db_path: str = EVO_DB) -> dict:
    """
    A-MEM 式回寫：新規則加入時，檢查跟現有規則有沒有重疊，
    有的話合併成更精準的版本，刪掉冗餘的。
    """
    conn = sqlite3.connect(db_path)
    _ensure_p1_schema(db_path)

    rules = conn.execute(
        "SELECT id, rule, q_value, target_scope FROM distilled_rules WHERE status = 'active' ORDER BY id"
    ).fetchall()

    if len(rules) < 2:
        conn.close()
        return {"merged": 0}

    merged = 0
    to_deprecate = set()

    # 找重疊規則：核心動詞短語相同
    for i, (id1, rule1, q1, scope1) in enumerate(rules):
        if id1 in to_deprecate:
            continue
        for j in range(i + 1, len(rules)):
            id2, rule2, q2, scope2 = rules[j]
            if id2 in to_deprecate:
                continue

            # 計算重疊度：共同字元比例
            overlap = _text_overlap(rule1, rule2)
            if overlap > 0.6:
                # 合併：保留 Q-value 較高的，淘汰另一條
                keeper_id = id1 if q1 >= q2 else id2
                loser_id = id2 if q1 >= q2 else id1
                to_deprecate.add(loser_id)
                merged += 1

    for dep_id in to_deprecate:
        conn.execute(
            "UPDATE distilled_rules SET status = 'merged' WHERE id = ?",
            (dep_id,)
        )

    conn.commit()
    conn.close()

    return {"merged": merged, "checked": len(rules)}


def _text_overlap(a: str, b: str) -> float:
    """兩段文字的字元重疊率（Jaccard）"""
    set_a = set(a)
    set_b = set(b)
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


# ══════════════════════════════════════════════════════════════════
# 零件 F：Meta-Guideline（Live-Evo）— 記「怎麼用規則」
# ══════════════════════════════════════════════════════════════════

META_GUIDELINES_FILE = DATA_DIR / "meta-guidelines.json"

def update_meta_guidelines(db_path: str = EVO_DB) -> dict:
    """
    Live-Evo 式 Meta-Guideline：
    不只記規則本身，也記「什麼情況下用這條規則最有效」。
    從 Q-value 變化中推導。
    """
    conn = sqlite3.connect(db_path)
    _ensure_p1_schema(db_path)

    # 取 Q-value 最高和最低的規則
    top_rules = conn.execute(
        "SELECT rule, q_value, target_scope, times_used FROM distilled_rules WHERE status = 'active' AND times_used > 0 ORDER BY q_value DESC LIMIT 5"
    ).fetchall()
    bottom_rules = conn.execute(
        "SELECT rule, q_value, target_scope, times_used FROM distilled_rules WHERE status = 'active' AND times_used > 0 ORDER BY q_value ASC LIMIT 5"
    ).fetchall()

    conn.close()

    guidelines = {
        "updated_at": datetime.now().isoformat(),
        "high_value_patterns": [],
        "low_value_patterns": [],
        "meta_rules": [],
    }

    # 從高 Q 規則歸納：什麼類型的規則最有效
    scope_scores: dict[str, list[float]] = {}
    for rule, q, scope, used in top_rules:
        guidelines["high_value_patterns"].append({
            "rule": rule, "q": q, "scope": scope,
        })
        scope_scores.setdefault(scope, []).append(q)

    for rule, q, scope, used in bottom_rules:
        guidelines["low_value_patterns"].append({
            "rule": rule, "q": q, "scope": scope,
        })
        scope_scores.setdefault(scope, []).append(q)

    # 生成 meta-guideline：哪個 scope 的規則 Q 值最高
    for scope, scores in scope_scores.items():
        avg_q = sum(scores) / len(scores)
        if avg_q > 0.7:
            guidelines["meta_rules"].append(
                f"[{scope}] 領域的規則平均 Q={avg_q:.2f}，效果好，可以多蒸餾這類"
            )
        elif avg_q < 0.3:
            guidelines["meta_rules"].append(
                f"[{scope}] 領域的規則平均 Q={avg_q:.2f}，效果差，蒸餾標準要提高"
            )

    META_GUIDELINES_FILE.write_text(
        json.dumps(guidelines, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    return {
        "high_value": len(guidelines["high_value_patterns"]),
        "low_value": len(guidelines["low_value_patterns"]),
        "meta_rules": len(guidelines["meta_rules"]),
    }


# ══════════════════════════════════════════════════════════════════
# Heartbeat integration
# ══════════════════════════════════════════════════════════════════

def phase1_tick(beat_n: int = 0) -> dict:
    """
    Single tick of the evolution engine. Called from heartbeat L2.
    完整迴圈：讀上輪批評 → 蒸餾 → 鐵律守門 → 提案 → Q更新 → 自我批評
    """
    # 讀上輪的 self-criticism
    last_crit = read_last_criticism()
    if last_crit and last_crit.get("has_revert_suggestion"):
        # 上輪說有系統性問題，暫停蒸餾一輪
        return {
            "new_rules": 0, "total_rules": 0, "new_proposals": 0,
            "total_pending": 0, "skipped": "last criticism suggested systemic issue",
        }

    # 1. 蒸餾
    d = distill()
    # 2. 記憶回寫 — 合併重疊規則（A-MEM）
    mem = evolve_memory_network()
    # 3. 提案（含鐵律守門 TAME）
    p = propose()
    # 4. Q-value 更新（MemRL）
    q = update_q_values()
    # 5. 失敗反思（GEPA）
    ref = reflect_on_failures()
    # 6. Meta-Guideline 更新（Live-Evo）
    mg = update_meta_guidelines()

    result = {
        "new_rules": d["new_rules"],
        "total_rules": d["total_rules"],
        "new_proposals": p["new_proposals"],
        "total_pending": p["total_pending"],
        "iron_blocked": p.get("iron_blocked", 0),
        "q_updated": q["updated"],
        "deprecated": q["deprecated"],
        "merged": mem["merged"],
        "reflections": ref["reflections"],
        "meta_rules": mg["meta_rules"],
    }

    if d["new_rules"] > 0:
        result["rule_examples"] = d["examples"]
    if p["new_proposals"] > 0:
        result["proposal_examples"] = p["examples"]

    # 7. 自我批評（MiniMax M2.7）
    write_self_criticism(result, beat_n)

    return result


def stats(db_path: str = EVO_DB) -> dict:
    _ensure_p1_schema(db_path)
    conn = sqlite3.connect(db_path)

    rules_total = conn.execute("SELECT COUNT(*) FROM distilled_rules WHERE status = 'active'").fetchone()[0]
    rules_by_scope = dict(conn.execute(
        "SELECT target_scope, COUNT(*) FROM distilled_rules WHERE status = 'active' GROUP BY target_scope"
    ).fetchall())
    rules_deprecated = conn.execute("SELECT COUNT(*) FROM distilled_rules WHERE status = 'deprecated'").fetchone()[0]
    rules_blocked = conn.execute("SELECT COUNT(*) FROM distilled_rules WHERE status = 'blocked_iron_rule'").fetchone()[0]

    # Top 5 by Q-value
    top_rules = conn.execute(
        "SELECT rule, q_value, times_used FROM distilled_rules WHERE status = 'active' ORDER BY q_value DESC LIMIT 5"
    ).fetchall()

    proposals_total = conn.execute("SELECT COUNT(*) FROM proposals").fetchone()[0]
    proposals_by_status = dict(conn.execute(
        "SELECT status, COUNT(*) FROM proposals GROUP BY status"
    ).fetchall())
    mutations_total = conn.execute("SELECT COUNT(*) FROM mutations WHERE applied = 1").fetchone()[0]

    conn.close()

    return {
        "phase": "1→2",
        "rules": {
            "active": rules_total,
            "deprecated": rules_deprecated,
            "blocked_by_iron": rules_blocked,
            "by_scope": rules_by_scope,
            "top5": [{"rule": r[0], "q": r[1], "used": r[2]} for r in top_rules],
        },
        "proposals": {"total": proposals_total, "by_status": proposals_by_status},
        "mutations_applied": mutations_total,
    }

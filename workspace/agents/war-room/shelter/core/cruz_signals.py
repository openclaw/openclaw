#!/usr/bin/env python3
"""
Cruz 信號萃取器 — 從所有管道收集進化燃料

Cruz 的每一句「不對」是 fitness=0。
Cruz 的每一句「好」是 fitness=1。
Cruz 的沉默是隱性 approval。
Cruz 的方向性校正是最高價值的訓練數據。

管道：
1. Claude Code session 對話（這個 session 的 jsonl）
2. Threads 互動（post + comments + replies）
3. TG 對話歷史（跟 bot 和群組）
4. 口頭決策（從對話中萃取「不對」「好」「改成X」）
5. 沉默信號（提出方案後 Cruz 沒反對 = 通過）
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


# ── 信號類型 ────────────────────────────────────────────────────

SIGNAL_TYPES = {
    "correction": {
        "description": "Cruz 糾正方向偏離 → 最高價值訓練數據",
        "fitness_impact": 0.0,
        "patterns": [
            # 直接否定
            r"不對", r"錯了", r"不是這樣", r"搞什麼", r"搞啥", r"搞錯",
            r"你搞反了", r"這個不行", r"不要", r"不用", r"別這樣",
            r"為什麼不", r"為啥不", r"應該是", r"才對", r"又在說",
            # 質疑
            r"你確定", r"怎麼會", r"這樣對嗎", r"有這種事",
            r"你又在", r"你當我", r"哪來的", r"誰說的",
            # 要求重做
            r"重做", r"重寫", r"重新", r"再來", r"重構",
            # Threads 風格（Cruz 回覆留言者的糾正語氣）
            r"數據.*錯", r"來源.*不對", r"不是.*這樣解讀",
        ],
    },
    "approval": {
        "description": "Cruz 確認方向正確",
        "fitness_impact": 1.0,
        "patterns": [
            # 直接認可
            r"^好$", r"^ok", r"^OK", r"^go$", r"^開始", r"^啟動",
            r"同意", r"批准", r"就這樣", r"^對$", r"沒錯", r"正確",
            r"繼續", r"^可以", r"^行$", r"部署", r"發出",
            # 推進指令
            r"繼續推進", r"ok go", r"開始建", r"直接做", r"馬上",
            r"Day.*go", r"合稿", r"合併",
            # 品味認可
            r"寫得.*好", r"這個好", r"完美", r"到位", r"精準",
            r"說得.*對", r"對.*說得",
            # Threads 風格（Cruz 在 Threads 的肯定語氣）
            r"完全正確", r"你說對了", r"好問題",
        ],
    },
    "redirect": {
        "description": "Cruz 調整優先級或方向",
        "fitness_impact": 0.3,
        "patterns": [
            r"讓.*來", r"換.*方向", r"先做", r"先.*再",
            r"插播", r"不急", r"等.*再", r"暫停",
            r"這個.*之後", r"回到", r"我們.*先",
            r"你.*去看", r"你要.*讀", r"查.*一下",
        ],
    },
    "taste": {
        "description": "Cruz 的品味/審美信號",
        "fitness_impact": None,
        "patterns": [
            # 負面品味
            r"難看", r"太醜", r"語氣.*不對", r"感覺怪", r"很怪",
            r"有點怪", r"不是在賣", r"太花", r"太複雜", r"廢話",
            r"太慢", r"太重", r"浪費", r"成本",
            # 正面品味
            r"好看", r"語氣.*對了", r"這個好", r"完美", r"簡潔",
            r"乾淨", r"精準", r"力量", r"穿透力",
        ],
    },
    "silence": {
        "description": "提出方案後 Cruz 沒反對，直接進行下一步 → 隱性 approval",
        "fitness_impact": 0.8,  # 高但不是 1.0，因為可能只是沒看到
        "patterns": [],  # 不靠 pattern，靠上下文判斷
    },
}


# ── 從對話中萃取信號 ────────────────────────────────────────────

def extract_cruz_signals(conversation: list[dict]) -> list[dict]:
    """
    從一段 Cruz 的對話（任何管道）中萃取進化信號。

    Input: [{"role": "user"/"assistant", "content": "..."}]
    Output: [{"type": "correction"/"approval"/..., "content": "...",
              "context": "...", "fitness_impact": float, "timestamp": str}]
    """
    signals = []

    for i, msg in enumerate(conversation):
        if msg.get("role") != "user":
            continue

        content = msg.get("content", "")

        # 取前一條（assistant 的回覆）作為 context
        context = ""
        if i > 0 and conversation[i-1].get("role") == "assistant":
            context = conversation[i-1].get("content", "")[:200]

        # 比對每種信號類型
        for sig_type, sig_def in SIGNAL_TYPES.items():
            if sig_type == "silence":
                continue  # silence 單獨處理

            for pattern in sig_def["patterns"]:
                if re.search(pattern, content):
                    signals.append({
                        "type": sig_type,
                        "content": content[:300],
                        "context": context,
                        "fitness_impact": sig_def["fitness_impact"],
                        "timestamp": datetime.now().isoformat(),
                        "pattern_matched": pattern,
                    })
                    break  # 一條訊息只算一個信號（取第一個匹配的）

    # 偵測沉默信號：assistant 提出方案 → user 沒反對直接給新指令
    for i in range(len(conversation) - 2):
        if (conversation[i].get("role") == "assistant" and
            conversation[i+1].get("role") == "user"):
            assistant_msg = conversation[i].get("content", "")
            user_msg = conversation[i+1].get("content", "")

            # 如果 assistant 提了方案（含「要我」「怎麼樣」）
            # 且 user 沒反對（沒匹配 correction patterns）
            if any(kw in assistant_msg for kw in ["要我", "怎麼樣", "要不要", "你看"]):
                is_correction = False
                for pattern in SIGNAL_TYPES["correction"]["patterns"]:
                    if re.search(pattern, user_msg):
                        is_correction = True
                        break

                if not is_correction:
                    signals.append({
                        "type": "silence",
                        "content": f"[方案] {assistant_msg[:100]}... → [回應] {user_msg[:100]}",
                        "context": "",
                        "fitness_impact": 0.8,
                        "timestamp": datetime.now().isoformat(),
                        "pattern_matched": "implicit_approval",
                    })

    return signals


def compute_cruz_fitness(signals: list[dict]) -> dict:
    """
    從一批 Cruz 信號計算整體 fitness。

    Output: {
        "overall": float (0-1),
        "corrections": int,
        "approvals": int,
        "redirects": int,
        "silences": int,
        "correction_details": [str],  # 被糾正的具體內容
    }
    """
    if not signals:
        return {"overall": 0.5, "corrections": 0, "approvals": 0,
                "redirects": 0, "silences": 0, "correction_details": []}

    corrections = [s for s in signals if s["type"] == "correction"]
    approvals = [s for s in signals if s["type"] == "approval"]
    redirects = [s for s in signals if s["type"] == "redirect"]
    silences = [s for s in signals if s["type"] == "silence"]

    # 加權平均
    total_weight = 0
    total_score = 0

    for s in signals:
        impact = s.get("fitness_impact")
        if impact is not None:
            weight = 2.0 if s["type"] == "correction" else 1.0  # 糾正權重加倍
            total_weight += weight
            total_score += impact * weight

    overall = total_score / total_weight if total_weight > 0 else 0.5

    return {
        "overall": round(overall, 3),
        "corrections": len(corrections),
        "approvals": len(approvals),
        "redirects": len(redirects),
        "silences": len(silences),
        "correction_details": [s["content"][:100] for s in corrections],
    }


def extract_evolution_lessons(signals: list[dict]) -> list[str]:
    """
    從 Cruz 的糾正信號中萃取進化教訓。
    每個 correction 變成一條「下次不要做 X，要做 Y」的規則。

    Output: ["不要用模型名稱做匠人，要用人名", "不要一次開 6 個 loop，合併成 1 個", ...]
    """
    lessons = []
    for s in signals:
        if s["type"] == "correction":
            lesson = f"Cruz 糾正：「{s['content'][:80]}」"
            if s.get("context"):
                lesson += f" — 原本是：「{s['context'][:80]}」"
            lessons.append(lesson)
    return lessons


# ── Smoke test ──────────────────────────────────────────────────

if __name__ == "__main__":
    # 模擬 Cruz 的對話片段
    test_conversation = [
        {"role": "assistant", "content": "我用 Opus 4.6, Sonnet 4.5, Haiku 4.5 來分配匠人工作..."},
        {"role": "user", "content": "不對啊 你放模型名稱做啥 當然是人名啊 人才有靈魂"},
        {"role": "assistant", "content": "重寫完了。六個匠人各有名字和靈魂。"},
        {"role": "user", "content": "好"},
        {"role": "assistant", "content": "要我開 6 個 /loop 嗎？"},
        {"role": "user", "content": "開了六個 loop 結果都在睡眠 你當我的 RAM 不用成本嗎"},
        {"role": "assistant", "content": "改成 1 個 heartbeat，每小時跑一次所有任務。"},
        {"role": "user", "content": "ok go"},
    ]

    signals = extract_cruz_signals(test_conversation)
    print(f"萃取到 {len(signals)} 個信號：")
    for s in signals:
        print(f"  [{s['type']}] {s['content'][:60]}... (fitness={s['fitness_impact']})")

    fitness = compute_cruz_fitness(signals)
    print(f"\n整體 fitness: {fitness['overall']}")
    print(f"糾正: {fitness['corrections']}, 認可: {fitness['approvals']}, "
          f"重定向: {fitness['redirects']}, 沉默認可: {fitness['silences']}")

    lessons = extract_evolution_lessons(signals)
    print(f"\n進化教訓 ({len(lessons)} 條)：")
    for l in lessons:
        print(f"  - {l}")


# ── 多管道掃描 ──────────────────────────────────────────────────

def scan_all_channels(clawd_root: str = "/Users/sulaxd/clawd") -> list[dict]:
    """
    掃描 Cruz 所有管道的 input，回傳統一的對話格式。

    管道：
    1. Claude Code sessions（~/.claude/projects/ 下的 .jsonl）
    2. Threads 互動（threads-snapshot.yaml 中 [我] 開頭的回覆）
    3. TG 對話日誌（workspace/agents/*/memory/ 下的 .md）

    回傳：[{"role": "user"/"assistant", "content": "...", "channel": "claude/threads/tg"}]
    """
    import re
    from pathlib import Path

    all_msgs = []

    # 管道 1: Claude Code sessions
    session_dir = Path.home() / ".claude" / "projects" / "-Users-sulaxd-clawd"
    if session_dir.exists():
        session_files = sorted(session_dir.glob("*.jsonl"),
                               key=lambda p: p.stat().st_mtime, reverse=True)  # 全讀，不截斷
        for sf in session_files:
            try:
                lines = sf.read_text(encoding="utf-8", errors="ignore").strip().split("\n")  # 全讀
                for line in lines:
                    try:
                        msg = json.loads(line)
                        content = msg.get("message", {}).get("content", "")
                        role = msg.get("message", {}).get("role", "")
                        if role in ("user", "assistant") and isinstance(content, str) and content:
                            all_msgs.append({"role": role, "content": content[:500], "channel": "claude"})
                        elif role in ("user", "assistant") and isinstance(content, list):
                            text = " ".join(c.get("text", "") for c in content
                                          if isinstance(c, dict) and c.get("type") == "text")
                            if text:
                                all_msgs.append({"role": role, "content": text[:500], "channel": "claude"})
                    except (json.JSONDecodeError, KeyError):
                        continue
            except Exception:
                continue

    # 管道 2: Threads 互動
    threads_path = Path(clawd_root) / "workspace" / "agents" / "war-room" / "knowledge" / "threads-snapshot.yaml"
    if threads_path.exists():
        try:
            text = threads_path.read_text(encoding="utf-8", errors="ignore")
            # [我] = Cruz 的回覆，[C/unknown] [A/neutral] [B/pro] = 別人的留言
            my_replies = re.findall(r'\[我\] (.+?)(?:\n|$)', text)
            other_comments = re.findall(r'\[[A-C]/\w+\] @\w+: (.+?)(?:\n|$)', text)

            # Cruz 的回覆是 "user"（我們在學 Cruz 的判斷）
            for reply in my_replies[-100:]:
                all_msgs.append({"role": "user", "content": reply[:500], "channel": "threads"})
            # 別人的留言是 "assistant"（作為 context，看 Cruz 在回應什麼）
            for comment in other_comments[-100:]:
                all_msgs.append({"role": "assistant", "content": comment[:500], "channel": "threads_other"})

            # 也找 [手動] 標記的留言（Cruz 特別標記要手動處理的）
            manual_flags = re.findall(r'\[手動\]', text)
            if manual_flags:
                all_msgs.append({"role": "user", "content": f"[meta] Threads 有 {len(manual_flags)} 則標記為手動處理", "channel": "threads_meta"})
        except Exception:
            pass

    # 管道 3: Gemini DR prompt 歷史（Cruz 怎麼問問題 = Cruz 的方向）
    research_index = Path(clawd_root) / "workspace" / "agents" / "gemini" / "knowledge" / "research-index.json"
    if research_index.exists():
        try:
            with open(research_index) as f:
                idx = json.load(f)
            for topic in idx.get("topics", [])[-30:]:
                # Cruz 設計的 prompt 本身就是方向信號
                t = topic.get("topic", "")
                purpose = topic.get("purpose", "")
                if t:
                    all_msgs.append({"role": "user", "content": f"[研究] {t[:300]}", "channel": "gemini_dr"})
                if purpose:
                    all_msgs.append({"role": "user", "content": f"[目的] {purpose[:200]}", "channel": "gemini_dr"})
        except Exception:
            pass

    # 管道 5: Workspace 共享狀態（BULLETIN + session-log）
    bulletin = Path(clawd_root) / "workspace" / "BULLETIN.md"
    if bulletin.exists():
        try:
            text = bulletin.read_text(encoding="utf-8", errors="ignore")
            if text.strip():
                # BULLETIN 是 Cruz 跨腦共享的決策
                lines = [l.strip() for l in text.split("\n") if l.strip() and not l.startswith("#")]
                for l in lines[-20:]:
                    all_msgs.append({"role": "user", "content": l[:300], "channel": "bulletin"})
        except Exception:
            pass

    session_log_dir = Path(clawd_root) / "workspace" / "scripts"
    for log_name in ["session-log"]:
        log_path = session_log_dir / log_name
        if log_path.exists() and log_path.is_file():
            try:
                text = log_path.read_text(encoding="utf-8", errors="ignore")
                lines = [l.strip() for l in text.split("\n") if l.strip()][-20:]
                for l in lines:
                    all_msgs.append({"role": "user", "content": l[:300], "channel": "session_log"})
            except Exception:
                pass

    # 管道 6: Slack 歷史（Cruz 2024 年的思考原料）
    slack_dir = Path("/Users/sulaxd/Documents/SlackAI/slack_export")
    if slack_dir.exists():
        priority_channels = ["一般", "搬磚計劃", "thinker-café", "隨機", "mind-storm", "突發奇想"]
        for ch_name in priority_channels:
            ch_dir = slack_dir / ch_name
            if not ch_dir.exists():
                continue
            for f in sorted(ch_dir.glob("*.json"), reverse=True):  # 全讀，不截斷
                try:
                    with open(f) as fh:
                        msgs = json.load(fh)
                    for m in msgs:
                        text = m.get("text", "")
                        if text and not text.startswith("<@") and len(text) > 30:
                            all_msgs.append({"role": "user", "content": text[:500], "channel": "slack"})
                except Exception:
                    continue

    # 管道 7: TG 對話（從 agent memory 日誌）
    agents_dir = Path(clawd_root) / "workspace" / "agents"
    if agents_dir.exists():
        for agent_dir in agents_dir.iterdir():
            memory_dir = agent_dir / "memory"
            if not memory_dir.exists():
                continue
            # 讀所有日誌（不只今天）
            for mem_file in sorted(memory_dir.glob("*.md"), reverse=True):
                try:
                    content = mem_file.read_text(encoding="utf-8", errors="ignore")
                    if content.strip():
                        all_msgs.append({"role": "user", "content": content[:500],
                                       "channel": f"tg_{agent_dir.name}"})
                except Exception:
                    continue

    return all_msgs


def compute_coverage_rate(captured: int, channels_scanned: dict) -> dict:
    """
    計算 input 覆蓋率。

    channels_scanned: {"claude": N, "threads": N, "tg": N}
    captured: 已入庫的信號數

    回傳：{"total_input": int, "captured": int, "coverage": float}
    """
    total = sum(channels_scanned.values())
    coverage = captured / max(total, 1)
    return {
        "total_input": total,
        "captured": captured,
        "coverage": round(coverage, 3),
        "channels": channels_scanned,
    }

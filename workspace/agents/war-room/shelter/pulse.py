#!/usr/bin/env python3
"""
脈搏（Pulse）— 每個 session 的輕量自檢

設計：
  心跳（heartbeat）= 中央引擎，每小時跑一次，負責蒸餾/進化/掃描
  脈搏（pulse）= 每個 session 自帶，每 5-10 分鐘跑一次，檢查有沒有自己能做的事

脈搏做的事：
  1. 讀共享工作佇列（work-queue.jsonl）
  2. 有待辦就領取執行
  3. 沒待辦就安靜（不輸出 = 不打擾 Cruz）
  4. 執行完把結果寫回佇列

工作佇列格式：
  {"id": "uuid", "type": "類型", "payload": {...}, "status": "pending", "claimed_by": null, "created_at": "...", "priority": 1}

type 類型：
  - "evolve_proposal_review" → 有待審的進化提案，提醒 Cruz 或自動審批低風險的
  - "knowledge_refresh" → 某模組過期需要更新
  - "coverage_gap" → 某 agent 太久沒活動
  - "threads_reply" → 有未回覆的 Threads 留言
  - "bulletin_update" → 有新的跨腦公告
  - "custom" → 心跳或其他 session 手動加的任務
"""

import json
import os
import fcntl
from datetime import datetime
from pathlib import Path

SHELTER = Path(__file__).resolve().parent
DATA_DIR = SHELTER / "data"
WORK_QUEUE = DATA_DIR / "work-queue.jsonl"
PULSE_LOG = DATA_DIR / "pulse-log.jsonl"


def _read_queue() -> list[dict]:
    """讀取工作佇列（所有項目）"""
    if not WORK_QUEUE.exists():
        return []
    items = []
    for line in WORK_QUEUE.read_text(encoding="utf-8").strip().split("\n"):
        if not line.strip():
            continue
        try:
            items.append(json.loads(line))
        except Exception:
            pass
    return items


def _write_queue(items: list[dict]):
    """覆寫工作佇列（帶檔案鎖防競爭）"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    content = "\n".join(json.dumps(i, ensure_ascii=False) for i in items) + "\n" if items else ""
    with open(WORK_QUEUE, "w", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(content)
        fcntl.flock(f, fcntl.LOCK_UN)


def enqueue(work_type: str, payload: dict, priority: int = 5) -> str:
    """加一個工作到佇列"""
    import uuid
    item = {
        "id": str(uuid.uuid4())[:8],
        "type": work_type,
        "payload": payload,
        "status": "pending",
        "claimed_by": None,
        "priority": priority,
        "created_at": datetime.now().isoformat(),
    }
    items = _read_queue()
    # 去重：同 type + 同 payload 的不重複加
    for existing in items:
        if existing["type"] == work_type and existing.get("status") == "pending":
            if json.dumps(existing.get("payload", {}), sort_keys=True) == json.dumps(payload, sort_keys=True):
                return existing["id"]  # 已存在
    items.append(item)
    _write_queue(items)
    return item["id"]


def claim(session_id: str) -> dict | None:
    """
    領取一個待辦工作（原子操作）。
    回傳工作項目，或 None（沒事做）。
    """
    items = _read_queue()
    # 按優先級排序，取第一個 pending 的
    pending = [i for i in items if i["status"] == "pending"]
    pending.sort(key=lambda x: x.get("priority", 5))

    if not pending:
        return None

    claimed = pending[0]
    # 標記為 claimed
    for i, item in enumerate(items):
        if item["id"] == claimed["id"]:
            items[i]["status"] = "claimed"
            items[i]["claimed_by"] = session_id
            items[i]["claimed_at"] = datetime.now().isoformat()
            break

    _write_queue(items)
    return claimed


def complete(work_id: str, result: dict = None):
    """標記工作完成"""
    items = _read_queue()
    for i, item in enumerate(items):
        if item["id"] == work_id:
            items[i]["status"] = "completed"
            items[i]["completed_at"] = datetime.now().isoformat()
            items[i]["result"] = result or {}
            break
    _write_queue(items)

    # 記錄到 pulse log
    _log_pulse(work_id, "completed", result)


def fail(work_id: str, error: str):
    """標記工作失敗，回到 pending 讓別的 session 接"""
    items = _read_queue()
    for i, item in enumerate(items):
        if item["id"] == work_id:
            items[i]["status"] = "pending"  # 回到 pending
            items[i]["claimed_by"] = None
            items[i]["last_error"] = error
            items[i]["retry_count"] = items[i].get("retry_count", 0) + 1
            # 超過 3 次就放棄
            if items[i]["retry_count"] >= 3:
                items[i]["status"] = "failed"
            break
    _write_queue(items)


def gc():
    """清理：移除 completed > 24h 和 failed 的項目"""
    items = _read_queue()
    cutoff = datetime.now().timestamp() - 86400
    kept = []
    removed = 0
    for item in items:
        if item["status"] == "completed":
            try:
                completed_at = datetime.fromisoformat(item.get("completed_at", "2000-01-01")).timestamp()
                if completed_at < cutoff:
                    removed += 1
                    continue
            except Exception:
                pass
        if item["status"] == "failed":
            removed += 1
            continue
        kept.append(item)
    if removed > 0:
        _write_queue(kept)
    return {"removed": removed, "remaining": len(kept)}


def _log_pulse(work_id: str, action: str, data: dict = None):
    """記錄 pulse 執行日誌"""
    entry = {
        "work_id": work_id,
        "action": action,
        "data": data,
        "ts": datetime.now().isoformat(),
        "pid": os.getpid(),
    }
    with open(PULSE_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def status() -> dict:
    """取得佇列狀態摘要"""
    items = _read_queue()
    by_status = {}
    by_type = {}
    for item in items:
        s = item.get("status", "unknown")
        t = item.get("type", "unknown")
        by_status[s] = by_status.get(s, 0) + 1
        by_type[t] = by_type.get(t, 0) + 1

    return {
        "total": len(items),
        "by_status": by_status,
        "by_type": by_type,
        "pending": [
            {"id": i["id"], "type": i["type"], "priority": i.get("priority", 5),
             "payload_preview": str(i.get("payload", {}))[:80]}
            for i in items if i["status"] == "pending"
        ],
    }


# ══════════════════════════════════════════════════════════════════
# Pulse check — 每個 session 的 /loop 呼叫這個
# ══════════════════════════════════════════════════════════════════

def pulse_check(session_id: str = None) -> str:
    """
    輕量自檢。每個 session 每 5-10 分鐘呼叫一次。
    有事做 → 回傳工作描述（session 的 /loop 會執行它）
    沒事做 → 回傳空字串（靜默）
    """
    if not session_id:
        session_id = f"pid-{os.getpid()}"

    # 先清理過期工作
    gc()

    # 嘗試領取工作
    work = claim(session_id)
    if not work:
        return ""

    work_type = work["type"]
    payload = work.get("payload", {})
    work_id = work["id"]

    # 根據類型生成要執行的 prompt
    if work_type == "evolve_proposal_review":
        count = payload.get("count", 0)
        return f"[pulse:{work_id}] 有 {count} 個進化提案待審。執行 python3 -c \"from shelter.core.phase1_evolution import review; [print(p) for p in review()]\""

    elif work_type == "knowledge_refresh":
        module = payload.get("module", "unknown")
        return f"[pulse:{work_id}] 知識模組 {module} 過期，需要用 Gemini Deep Research 更新"

    elif work_type == "coverage_gap":
        agent = payload.get("agent", "unknown")
        return f"[pulse:{work_id}] Agent {agent} 已沉默 {payload.get('days', '?')} 天，檢查是否需要啟動"

    elif work_type == "threads_reply":
        count = payload.get("unreplied", 0)
        return f"[pulse:{work_id}] Threads 有 {count} 則未回覆留言需要處理"

    elif work_type == "custom":
        return f"[pulse:{work_id}] {payload.get('description', '自定義任務')}"

    else:
        # 不認識的類型，放回去
        fail(work_id, f"unknown type: {work_type}")
        return ""


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("用法: pulse.py [check|status|enqueue|gc]")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "check":
        sid = sys.argv[2] if len(sys.argv) > 2 else None
        result = pulse_check(sid)
        if result:
            print(result)
        # 沒事就不輸出（安靜）
    elif cmd == "status":
        s = status()
        print(json.dumps(s, ensure_ascii=False, indent=2))
    elif cmd == "enqueue":
        if len(sys.argv) < 4:
            print("用法: pulse.py enqueue <type> <payload_json>")
            sys.exit(1)
        work_type = sys.argv[2]
        payload = json.loads(sys.argv[3])
        wid = enqueue(work_type, payload)
        print(f"已加入佇列: {wid}")
    elif cmd == "gc":
        r = gc()
        print(f"清理: 移除 {r['removed']}，剩餘 {r['remaining']}")

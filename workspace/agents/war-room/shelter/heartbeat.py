#!/usr/bin/env python3
"""
思考者咖啡 — 五將合議心跳（actuator，不是 dashboard）

用法：
  /loop 1h python3 workspace/agents/war-room/shelter/heartbeat.py

五層：
  L0: Vital Signs      — 每次 beat。Gateway/Ollama 活著？安靜=健康。
  L1: Knowledge Metabolism — 最老的知識模組，檢查是否過期，記錄要刷新什麼。
  L2: Memory Digestion  — 最新未處理 Cruz 信號 → 萃取教訓 → 寫入 pending-patches。
  L3: Evolution Pulse   — fitness 趨勢（最近 3 次），連降 3 次 → 標記。
  L4: Coverage Expansion — 找一個沒有近期活動的 agent，記錄為缺口。

L0 每次跑。L1-L4 輪轉：beat N 跑 L(N%4 + 1)。
每日簡報（06-07）、每週進化（週日 22-23）作為特殊覆寫。
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ── 路徑 ──────────────────────────────────────────────────────────
WAR_ROOM = Path(__file__).resolve().parent.parent
SHELTER = WAR_ROOM / "shelter"
sys.path.insert(0, str(WAR_ROOM))

MODULES_DIR = SHELTER / "knowledge" / "modules"
DATA_DIR = SHELTER / "data"
EVO_DB = str(DATA_DIR / "evolution.db")
GUARDIAN_DB = str(DATA_DIR / "guardian.db")
RIVER_DB = str(DATA_DIR / "river.db")
LANCEDB_PATH = str(DATA_DIR / "lancedb")
BEAT_STATE = DATA_DIR / "heartbeat-state.json"
PENDING_PATCHES = DATA_DIR / "pending-patches.jsonl"

now = datetime.now()
hour = now.hour
weekday = now.weekday()  # 0=Monday, 6=Sunday


# ── Beat counter ──────────────────────────────────────────────────

def _load_beat_state() -> dict:
    if BEAT_STATE.exists():
        try:
            return json.loads(BEAT_STATE.read_text())
        except Exception:
            pass
    return {"beat": 0, "last_fitness": []}


def _save_beat_state(state: dict):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BEAT_STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ── Actions list (collected during the beat) ──────────────────────

_actions: list[str] = []


def _act(msg: str):
    """Record an action taken. Only prints on anomaly/action."""
    _actions.append(msg)
    print(msg)


# ══════════════════════════════════════════════════════════════════
# L0: Vital Signs (every beat) — silent if OK
# ══════════════════════════════════════════════════════════════════

def layer0_vital_signs() -> dict:
    """Check Gateway and Ollama. Return status dict. Only speak on failure."""
    import subprocess
    status = {}

    # Gateway
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:18789/health"],
            capture_output=True, text=True, timeout=5
        )
        gw_code = result.stdout.strip()
        status["gateway"] = gw_code == "200"
        if gw_code != "200":
            _act(f"[L0] Gateway DOWN (HTTP {gw_code})")
    except Exception as e:
        status["gateway"] = False
        _act(f"[L0] Gateway unreachable: {e}")

    # Ollama
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:11434/api/tags"],
            capture_output=True, text=True, timeout=5
        )
        ol_code = result.stdout.strip()
        status["ollama"] = ol_code == "200"
        if ol_code != "200":
            _act(f"[L0] Ollama DOWN (HTTP {ol_code})")
    except Exception as e:
        status["ollama"] = False
        _act(f"[L0] Ollama unreachable: {e}")

    # Guardian threat score
    try:
        from shelter.core.guardian import init_guardian, evaluate
        init_guardian(GUARDIAN_DB)
        result = evaluate()
        mode = result.get("mode", "?")
        score = result.get("score", 0)
        status["guardian_mode"] = mode
        status["guardian_score"] = score
        if score > 0.7:
            _act(f"[L0] Threat elevated: {mode} score={score:.2f}")
    except Exception as e:
        _act(f"[L0] Guardian error: {e}")
        status["guardian_mode"] = "error"
        status["guardian_score"] = -1

    # Evolution phase (quick read, no action)
    try:
        from shelter.core.evolution import get_phase
        status["evo_phase"] = get_phase(EVO_DB)
    except Exception:
        status["evo_phase"] = -1

    return status


# ══════════════════════════════════════════════════════════════════
# L1: Knowledge Metabolism — find OLDEST stale module, log refresh target
# ══════════════════════════════════════════════════════════════════

def layer1_knowledge_metabolism() -> dict:
    """Pick the oldest knowledge module, check staleness, log what needs refresh."""
    oldest_module = None
    oldest_days = -1
    stale_count = 0
    total = 0

    for f in sorted(os.listdir(MODULES_DIR)):
        if not f.endswith(".json"):
            continue
        total += 1
        try:
            with open(MODULES_DIR / f) as fh:
                m = json.load(fh)
        except Exception:
            continue

        last = m.get("last_verified", "2020-01-01")
        shelf = m.get("shelf_life", "medium")
        try:
            days = (now - datetime.fromisoformat(last)).days
        except Exception:
            days = 999

        limit = {"short": 7, "medium": 30, "long": 90}.get(shelf, 30)

        if days > oldest_days:
            oldest_days = days
            oldest_module = {
                "id": m.get("module_id", f),
                "file": f,
                "days_since_verify": days,
                "shelf_life": shelf,
                "limit": limit,
                "key_data": m.get("key_data_points", m.get("description", "unknown")),
            }

        if days > limit:
            stale_count += 1

    result = {"total": total, "stale_count": stale_count, "oldest": oldest_module}

    if oldest_module:
        is_stale = oldest_days > oldest_module["limit"]
        if is_stale:
            _act(f"[L1] STALE: {oldest_module['id']} ({oldest_days}d > {oldest_module['limit']}d limit) — check: {str(oldest_module['key_data'])[:80]}")
            # Write to pending-patches so next session can act on it
            _append_pending_patch({
                "type": "knowledge_refresh",
                "module": oldest_module["id"],
                "file": oldest_module["file"],
                "days_stale": oldest_days - oldest_module["limit"],
                "key_data": str(oldest_module["key_data"])[:200],
                "logged_at": now.isoformat(),
            })
        if stale_count > 3:
            _act(f"[L1] {stale_count}/{total} modules stale — knowledge is rotting")

    return result


# ══════════════════════════════════════════════════════════════════
# L2: Memory Digestion — Cruz signal → lesson → pending-patches
# ══════════════════════════════════════════════════════════════════

def layer2_memory_digestion() -> dict:
    """Take most recent unprocessed Cruz signals, extract lessons, write to pending-patches."""
    try:
        from shelter.core.cruz_signals import (
            extract_cruz_signals, compute_cruz_fitness,
            extract_evolution_lessons, scan_all_channels, compute_coverage_rate
        )
    except ImportError as e:
        _act(f"[L2] Import error: {e}")
        return {"error": str(e)}

    # Scan all channels
    all_msgs = scan_all_channels()
    channel_counts = {}
    for m in all_msgs:
        ch = m.get("channel", "unknown").split("_")[0]
        channel_counts[ch] = channel_counts.get(ch, 0) + 1

    conversation = [{"role": m["role"], "content": m["content"]} for m in all_msgs]

    if not conversation:
        return {"signals": 0, "lessons": 0, "channels": {}}

    signals = extract_cruz_signals(conversation)
    if not signals:
        return {"signals": 0, "lessons": 0, "channels": channel_counts}

    fitness = compute_cruz_fitness(signals)
    lessons = extract_evolution_lessons(signals)

    # Write signals to evolution.db (deduplicated)
    evo_db_path = str(DATA_DIR / "evolution.db")
    conn = sqlite3.connect(evo_db_path)
    conn.execute("""CREATE TABLE IF NOT EXISTS cruz_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT, content TEXT, context TEXT,
        fitness_impact REAL, lesson TEXT,
        project TEXT DEFAULT 'unknown',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")
    # Add project column if missing (migration for existing DB)
    try:
        conn.execute("ALTER TABLE cruz_signals ADD COLUMN project TEXT DEFAULT 'unknown'")
    except Exception:
        pass  # Column already exists

    # Project detection keywords
    def _detect_project(text: str) -> str:
        t = text.lower()
        if any(k in t for k in ["bg666", "bita", "幣塔", "客服", "line bot", "rhaenyra"]):
            return "bg666"
        if any(k in t for k in ["danny", "苗栗", "miaoli", "選舉", "議員", "小羅", "好朋友"]):
            return "miaoli-hi"
        if any(k in t for k in ["shelter", "心跳", "heartbeat", "進化", "守夜人", "thinker"]):
            return "war-room"
        if any(k in t for k in ["24bet", "g9", "andrew"]):
            return "24bet"
        if any(k in t for k in ["gateway", "openclaw", "母艦", "deploy"]):
            return "openclaw"
        return "general"

    new_signals = 0
    for s in signals:
        exists = conn.execute(
            "SELECT 1 FROM cruz_signals WHERE content=? LIMIT 1",
            (s["content"][:300],)
        ).fetchone()
        if not exists:
            project = _detect_project(s["content"] + " " + s.get("context", ""))
            conn.execute(
                "INSERT INTO cruz_signals (signal_type, content, context, fitness_impact, lesson, project) VALUES (?,?,?,?,?,?)",
                (s["type"], s["content"][:300], s.get("context", "")[:200],
                 s.get("fitness_impact"), "", project)
            )
            new_signals += 1

    new_lessons = 0
    for l in lessons:
        exists = conn.execute("SELECT 1 FROM cruz_signals WHERE content=? LIMIT 1", (l[:300],)).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO cruz_signals (signal_type, content, context, fitness_impact, lesson) VALUES (?,?,?,?,?)",
                ("lesson", l[:300], "", None, l[:300])
            )
            new_lessons += 1
            # Write lesson to pending-patches for downstream consumption
            _append_pending_patch({
                "type": "cruz_lesson",
                "lesson": l[:300],
                "fitness": fitness["overall"],
                "logged_at": now.isoformat(),
            })

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM cruz_signals").fetchone()[0]
    conn.close()

    coverage = compute_coverage_rate(total, channel_counts)

    if new_signals > 0 or new_lessons > 0:
        _act(f"[L2] Cruz: +{new_signals} signals, +{new_lessons} lessons | fitness={fitness['overall']:.2f} | {fitness['corrections']}c/{fitness['approvals']}a")

    if fitness["corrections"] > fitness["approvals"] * 2:
        _act(f"[L2] WARNING: correction-heavy ({fitness['corrections']}c vs {fitness['approvals']}a) — alignment drifting?")

    # Baseline drift check
    baseline_path = SHELTER / "knowledge" / "cruz-baseline.json"
    if baseline_path.exists():
        try:
            with open(baseline_path) as bf:
                baseline = json.load(bf)
            invariants = baseline.get("invariants", [])
            if invariants and fitness["overall"] < 0.3:
                _act(f"[L2] Fitness below 0.3 with {len(invariants)} invariants — possible anchor drift")
        except Exception:
            pass

    # Inject new lessons into thinker SOUL.md (learned behaviors section)
    if new_lessons > 0:
        _inject_lessons_to_soul(lessons)

    # ── Phase 1→2 Evolution: distill → iron gate → propose → Q-update → self-criticism ──
    try:
        from shelter.core.phase1_evolution import phase1_tick
        _beat_state = _load_beat_state()
        p1 = phase1_tick(beat_n=_beat_state.get("beat", 0))
        if p1.get("skipped"):
            _act(f"[L2] Phase1 skipped: {p1['skipped']}")
        else:
            parts = []
            if p1["new_rules"] > 0:
                parts.append(f"+{p1['new_rules']} rules")
            if p1["new_proposals"] > 0:
                parts.append(f"+{p1['new_proposals']} proposals")
            if p1.get("iron_blocked", 0) > 0:
                parts.append(f"{p1['iron_blocked']} blocked")
            if p1.get("deprecated", 0) > 0:
                parts.append(f"{p1['deprecated']} deprecated")
            if p1.get("q_updated", 0) > 0:
                parts.append(f"Q×{p1['q_updated']}")
            if parts:
                _act(f"[L2] Evo: {', '.join(parts)} (pending: {p1['total_pending']})")
                if p1.get("rule_examples"):
                    for ex in p1["rule_examples"][:2]:
                        _act(f"[L2]   rule: {ex}")
    except ImportError as e:
        _act(f"[L2] Phase1 not available: {e}")
    except Exception as e:
        _act(f"[L2] Phase1 error: {e}")

    # Skip heavy LLM work if CPU is overloaded
    import os
    _load = os.getloadavg()[0]
    if _load > 10:
        _act(f"[L2] CPU load {_load:.1f} — skipping nen-bridge/chatgpt-bridge to cool down")
    else:
        # Run nen-bridge if available (Claude Code → shared memory)
        try:
            from shelter.nen_bridge import bridge_recent_sessions
            bridge_result = bridge_recent_sessions()
            if bridge_result.get("extracted", 0) > 0:
                _act(f"[L2] Nen bridge: {bridge_result['processed']} sessions → {bridge_result['extracted']} memories")
        except ImportError:
            pass
        except Exception as e:
            _act(f"[L2] Nen bridge error: {e}")

    # Run chatgpt-bridge if available (ChatGPT exports → shared memory)
    if _load <= 10:
        try:
            from shelter.chatgpt_bridge import bridge_chatgpt_exports
            chatgpt_result = bridge_chatgpt_exports()
            if chatgpt_result.get("processed", 0) > 0:
                _act(f"[L2] ChatGPT bridge: {chatgpt_result['processed']} exports processed")
        except ImportError:
            pass
        except Exception as e:
            _act(f"[L2] ChatGPT bridge error: {e}")

    return {
        "signals": len(signals),
        "new_signals": new_signals,
        "new_lessons": new_lessons,
        "fitness": fitness["overall"],
        "channels": channel_counts,
        "total_in_db": total,
        "coverage": coverage.get("coverage", 0),
    }


# ══════════════════════════════════════════════════════════════════
# L3: Evolution Pulse — fitness trend, flag if dropping 3x in a row
# ══════════════════════════════════════════════════════════════════

def layer3_evolution_pulse(beat_state: dict) -> dict:
    """Check fitness trend from last 3 readings. Flag if 3 consecutive drops."""
    history = beat_state.get("last_fitness", [])

    # Get current fitness from DB
    current_fitness = None
    try:
        conn = sqlite3.connect(EVO_DB)
        conn.execute("""CREATE TABLE IF NOT EXISTS cruz_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_type TEXT, content TEXT, context TEXT,
            fitness_impact REAL, lesson TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        # Average fitness of last 20 signals with non-null impact
        row = conn.execute(
            "SELECT AVG(fitness_impact) FROM (SELECT fitness_impact FROM cruz_signals WHERE fitness_impact IS NOT NULL ORDER BY id DESC LIMIT 20)"
        ).fetchone()
        if row and row[0] is not None:
            current_fitness = round(row[0], 3)
        conn.close()
    except Exception as e:
        _act(f"[L3] DB read error: {e}")
        return {"trend": "unknown"}

    if current_fitness is None:
        return {"trend": "no_data"}

    # Append to history, keep last 5
    history.append(current_fitness)
    history = history[-5:]
    beat_state["last_fitness"] = history

    result = {"current": current_fitness, "history": history, "trend": "stable"}

    if len(history) >= 3:
        last3 = history[-3:]
        # Check for 3 consecutive drops
        if last3[0] > last3[1] > last3[2]:
            result["trend"] = "dropping"
            _act(f"[L3] FITNESS DROPPING 3x: {last3[0]:.3f} > {last3[1]:.3f} > {last3[2]:.3f} — needs attention")
            _append_pending_patch({
                "type": "fitness_alert",
                "trend": last3,
                "logged_at": now.isoformat(),
            })
        elif last3[2] > last3[1] > last3[0]:
            result["trend"] = "rising"
            # Rising is good, no action needed

    return result


# ══════════════════════════════════════════════════════════════════
# L4: Coverage Expansion — find agents without recent activity
# ══════════════════════════════════════════════════════════════════

def layer4_coverage_expansion() -> dict:
    """Find agents without recent heartbeat/memory activity. Log gaps."""
    agents_dir = WAR_ROOM.parent  # workspace/agents/
    if not agents_dir.exists():
        return {"gaps": []}

    gaps = []
    checked = 0
    cutoff = now - timedelta(days=3)

    # Gateway-only agents — activity is in Gateway logs, not local mtime
    GATEWAY_ONLY = {"bita", "lolo-care", "xo", "peiqi-social", "avery", "ryanos", "vivi-tutor"}

    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir():
            continue
        if agent_dir.name.startswith((".", "_")):
            continue
        if agent_dir.name in GATEWAY_ONLY:
            continue  # Skip: activity tracked in Gateway, not local files

        checked += 1
        # Check for recent activity: memory files, HEARTBEAT.md mtime, AGENTS.md mtime
        latest_activity = None

        # Check memory dir
        memory_dir = agent_dir / "memory"
        if memory_dir.exists():
            for mf in memory_dir.iterdir():
                if mf.is_file():
                    try:
                        mtime = datetime.fromtimestamp(mf.stat().st_mtime)
                        if latest_activity is None or mtime > latest_activity:
                            latest_activity = mtime
                    except Exception:
                        continue

        # Check HEARTBEAT.md
        hb = agent_dir / "HEARTBEAT.md"
        if hb.exists():
            try:
                mtime = datetime.fromtimestamp(hb.stat().st_mtime)
                if latest_activity is None or mtime > latest_activity:
                    latest_activity = mtime
            except Exception:
                pass

        # Check AGENTS.md
        ag = agent_dir / "AGENTS.md"
        if ag.exists():
            try:
                mtime = datetime.fromtimestamp(ag.stat().st_mtime)
                if latest_activity is None or mtime > latest_activity:
                    latest_activity = mtime
            except Exception:
                pass

        if latest_activity is None or latest_activity < cutoff:
            days_silent = (now - latest_activity).days if latest_activity else 999
            gaps.append({"agent": agent_dir.name, "days_silent": days_silent})

    # Also check usage tracker for module coverage
    usage_result = {}
    try:
        from shelter.core.usage_tracker import init_usage_db, seed_assets, auto_detect_calls, compute_usage_rate
        usage_db = str(DATA_DIR / "usage.db")
        init_usage_db(usage_db)
        seed_assets(usage_db)
        auto_detect_calls(usage_db)
        usage = compute_usage_rate(usage_db)
        usage_result = {
            "overall_rate": usage["overall_rate"],
            "by_type": usage.get("by_type", {}),
        }
        if usage["overall_rate"] < 0.3:
            _act(f"[L4] Usage rate {usage['overall_rate']:.1%} — most assets underutilized")
    except Exception as e:
        _act(f"[L4] Usage tracker error: {e}")

    # Report the single most neglected agent
    if gaps:
        gaps.sort(key=lambda g: g["days_silent"], reverse=True)
        worst = gaps[0]
        _act(f"[L4] Gap: {worst['agent']} silent {worst['days_silent']}d | {len(gaps)}/{checked} agents inactive >3d")
        _append_pending_patch({
            "type": "coverage_gap",
            "agent": worst["agent"],
            "days_silent": worst["days_silent"],
            "total_gaps": len(gaps),
            "logged_at": now.isoformat(),
        })

    return {"gaps": gaps, "checked": checked, "usage": usage_result}


# ══════════════════════════════════════════════════════════════════
# L5 (念系統度量) — runs with L0, lightweight log scan
# ══════════════════════════════════════════════════════════════════

def _nen_metrics() -> dict:
    """念系統 smart-extractor metrics from gateway log. Only report anomalies."""
    try:
        gateway_log = Path.home() / ".openclaw" / "logs" / "gateway.log"
        if not gateway_log.exists():
            return {}

        log_lines = gateway_log.read_text(encoding="utf-8", errors="replace").splitlines()[-2000:]

        created = sum(1 for l in log_lines if "smart-extractor: created" in l)
        merged = sum(1 for l in log_lines if "smart-extractor: merged" in l)
        skipped = sum(1 for l in log_lines if "smart-extractor: skipped" in l)

        fail_timeout = sum(1 for l in log_lines if "FAIL:timeout" in l)
        fail_empty = sum(1 for l in log_lines if "FAIL:empty_response" in l)
        fail_parse = sum(1 for l in log_lines if "FAIL:parse_error" in l or "FAIL:no_json" in l)
        fail_conn = sum(1 for l in log_lines if "FAIL:connection" in l)
        fail_rate = sum(1 for l in log_lines if "FAIL:rate_limit" in l)
        fail_req = sum(1 for l in log_lines if "FAIL:request_error" in l)
        total_fails = fail_timeout + fail_empty + fail_parse + fail_conn + fail_rate + fail_req

        total_attempts = created + merged + skipped + total_fails
        success_rate = (created + merged) / total_attempts if total_attempts > 0 else 1.0

        result = {
            "created": created, "merged": merged, "skipped": skipped,
            "fails": total_fails, "success_rate": success_rate,
        }

        # Only report if something is wrong
        if total_fails > 10:
            fail_parts = []
            if fail_timeout: fail_parts.append(f"timeout={fail_timeout}")
            if fail_empty: fail_parts.append(f"empty={fail_empty}")
            if fail_parse: fail_parts.append(f"parse={fail_parse}")
            if fail_conn: fail_parts.append(f"conn={fail_conn}")
            if fail_rate: fail_parts.append(f"rate_limit={fail_rate}")
            if fail_req: fail_parts.append(f"req_err={fail_req}")
            _act(f"[L0] Nen fails high: {total_fails} ({', '.join(fail_parts)})")

        if total_attempts > 20 and success_rate < 0.5:
            _act(f"[L0] Nen extraction rate {success_rate:.0%} — below 50%")

        return result
    except Exception:
        return {}


# ══════════════════════════════════════════════════════════════════
# Lesson injection into SOUL.md
# ══════════════════════════════════════════════════════════════════

THINKER_SOUL = WAR_ROOM.parent / "thinker" / "SOUL.md"
LEARNED_START = "<!-- LEARNED_BEHAVIORS_START -->"
LEARNED_END = "<!-- LEARNED_BEHAVIORS_END -->"
MAX_LEARNED_BEHAVIORS = 20  # Keep the list manageable

def _inject_lessons_to_soul(lessons: list[str]):
    """Inject Cruz correction lessons into thinker SOUL.md's learned behaviors section."""
    if not THINKER_SOUL.exists():
        return

    try:
        content = THINKER_SOUL.read_text(encoding="utf-8")
        if LEARNED_START not in content or LEARNED_END not in content:
            return

        # Extract existing learned behaviors
        start_idx = content.index(LEARNED_START) + len(LEARNED_START)
        end_idx = content.index(LEARNED_END)
        existing_block = content[start_idx:end_idx].strip()

        existing_lines = [l.strip() for l in existing_block.split("\n") if l.strip().startswith("- ")]

        # Add new lessons (dedup by content, strict noise filter)
        existing_set = set(existing_lines)
        for lesson in lessons:
            clean = lesson.strip()[:200]
            if len(clean) < 10 or len(clean) > 150:
                continue
            # Must contain action words suggesting a behavioral correction
            action_markers = ["不要", "別", "應該", "要先", "改用", "不用", "禁止", "不能"]
            if not any(m in clean for m in action_markers):
                continue
            # Reject: raw conversation fragments
            if "原本是" in clean:
                continue
            # Reject: raw cruz_signals format (starts with "Cruz 糾正")
            if clean.startswith("Cruz 糾正") or clean.startswith("Cruz糾正"):
                continue
            # Reject: contains newlines or markdown formatting (table/list/heading)
            if "\n" in clean or "|" in clean or "##" in clean or "**" in clean:
                continue
            # Reject: looks like a chat message, not a lesson (too many punctuation)
            if clean.count("「") > 1 or clean.count("：") > 2:
                continue
            entry = f"- {clean}"
            if entry not in existing_set:
                existing_lines.append(entry)
                existing_set.add(entry)

        # Keep only the most recent MAX_LEARNED_BEHAVIORS
        existing_lines = existing_lines[-MAX_LEARNED_BEHAVIORS:]

        # Rebuild the section
        new_block = "\n".join(existing_lines)
        new_content = (
            content[:content.index(LEARNED_START) + len(LEARNED_START)]
            + "\n" + new_block + "\n"
            + content[content.index(LEARNED_END):]
        )

        THINKER_SOUL.write_text(new_content, encoding="utf-8")
        _act(f"[L2] Injected {len(lessons)} lesson(s) into SOUL.md ({len(existing_lines)} total)")
    except Exception as e:
        _act(f"[L2] SOUL injection error: {e}")


# ══════════════════════════════════════════════════════════════════
# Pending patches file (append-only JSONL)
# ══════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# Lifecycle GC — archive old content, keep active files lean
# ══════════════════════════════════════════════════════════════════

def _lifecycle_gc():
    """Information lifecycle management — archive old content, keep active files lean."""

    # 1. evolution-log.md: keep last 200 lines, archive the rest
    evo_log = SHELTER / "evolution-log.md"
    if evo_log.exists():
        lines = evo_log.read_text().splitlines()
        if len(lines) > 200:
            # Find the header (first ## line) to preserve
            header_end = 0
            for i, line in enumerate(lines):
                if line.startswith("## ") and i > 0:
                    header_end = i
                    break

            archive_dir = SHELTER / "archive"
            archive_dir.mkdir(exist_ok=True)
            archive_file = archive_dir / f"evolution-log-{now.strftime('%Y-%m')}.md"

            # Append archived lines to monthly file
            archived_lines = lines[header_end:-200]  # Keep header + last 200
            if archived_lines:
                with open(archive_file, "a") as f:
                    f.write("\n".join(archived_lines) + "\n")

                # Rewrite evolution-log with header + last 200
                remaining = lines[:header_end] + lines[-200:]
                evo_log.write_text("\n".join(remaining) + "\n")
                _act(f"[gc] evolution-log: archived {len(archived_lines)} lines → {archive_file.name}")

    # 2. BULLETIN.md: entries older than 7 days → warn if huge
    bulletin = WAR_ROOM.parent.parent / "BULLETIN.md"
    if bulletin.exists():
        lines = bulletin.read_text().splitlines()
        if len(lines) > 100:
            _act(f"[gc] BULLETIN.md is {len(lines)} lines — consider manual cleanup")

    # 3. pending-patches.jsonl: remove entries older than 14 days
    if PENDING_PATCHES.exists():
        cutoff = (now - timedelta(days=14)).isoformat()
        kept = []
        removed = 0
        for line in PENDING_PATCHES.read_text().splitlines():
            if not line.strip():
                continue
            try:
                patch = json.loads(line)
                if patch.get("logged_at", "") > cutoff:
                    kept.append(line)
                else:
                    removed += 1
            except Exception:
                kept.append(line)  # Keep unparseable lines
        if removed > 0:
            PENDING_PATCHES.write_text("\n".join(kept) + "\n" if kept else "")
            _act(f"[gc] pending-patches: removed {removed} old entries")

    # 4. nen-bridge-output.jsonl: if >1000 lines, archive older half
    nen_output = SHELTER / "data" / "nen-bridge-output.jsonl"
    if nen_output.exists():
        lines = nen_output.read_text().splitlines()
        if len(lines) > 1000:
            archive_dir = SHELTER / "archive"
            archive_dir.mkdir(exist_ok=True)
            archive_file = archive_dir / f"nen-bridge-{now.strftime('%Y-%m')}.jsonl"

            half = len(lines) // 2
            with open(archive_file, "a") as f:
                f.write("\n".join(lines[:half]) + "\n")
            nen_output.write_text("\n".join(lines[half:]) + "\n")
            _act(f"[gc] nen-bridge: archived {half} entries → {archive_file.name}")


def _append_pending_patch(patch: dict):
    """Append an actionable patch to pending-patches.jsonl (deduplicated)."""
    # Dedup: check if same type+key already exists
    dedup_key = patch.get("type", "") + ":" + patch.get("module", patch.get("agent", patch.get("lesson", "")[:80]))
    if PENDING_PATCHES.exists():
        try:
            for line in PENDING_PATCHES.read_text().splitlines():
                if not line.strip():
                    continue
                existing = json.loads(line)
                existing_key = existing.get("type", "") + ":" + existing.get("module", existing.get("agent", existing.get("lesson", "")[:80]))
                if existing_key == dedup_key:
                    return  # Already recorded
        except Exception:
            pass
    with open(PENDING_PATCHES, "a", encoding="utf-8") as f:
        f.write(json.dumps(patch, ensure_ascii=False) + "\n")


# ══════════════════════════════════════════════════════════════════
# Daily briefing override (06-07)
# ══════════════════════════════════════════════════════════════════

def _daily_briefing(l0_status: dict, l1_result: dict):
    """Generate and push daily briefing. Runs during 06-07 hour."""
    _act("[daily] Running morning briefing")

    # Intel digestion
    try:
        from shelter.core.river import fetch_feeds, store_intel, init_feeds
        from shelter.core.memory import init_db
        init_db(LANCEDB_PATH)
        feeds = init_feeds({})
        items = fetch_feeds(feeds)
        if items:
            store_intel(items, RIVER_DB)
            _act(f"[daily] Intel: {len(items)} items fetched")
    except Exception as e:
        _act(f"[daily] Intel error: {e}")

    # Check if already sent today
    briefing_path = DATA_DIR / "latest-briefing.txt"
    if briefing_path.exists():
        mtime = datetime.fromtimestamp(briefing_path.stat().st_mtime)
        if mtime.date() == now.date():
            _act("[daily] Briefing already sent today, skip")
            return

    try:
        mode = l0_status.get("guardian_mode", "?")
        score = l0_status.get("guardian_score", 0)
        phase = l0_status.get("evo_phase", "?")
        stale_count = l1_result.get("stale_count", 0) if l1_result else 0

        lines = [
            f"思考者咖啡晨間簡報 — {now.strftime('%Y-%m-%d')}",
            "",
            f"態勢：{mode} | 威脅分數：{score:.2f}",
        ]
        if stale_count > 0:
            lines.append(f"{stale_count} 個知識模組過期")
        else:
            lines.append("所有知識模組在保鮮期內")
        lines.append(f"進化：Phase {phase}")
        lines.append("")
        lines.append("有事私訊守夜人。沒事就好。")

        briefing_path.write_text("\n".join(lines), encoding="utf-8")
        _act(f"[daily] Briefing written to {briefing_path}")

        # Push to TG
        import subprocess
        push_result = subprocess.run(
            ["python3", str(SHELTER / "push_briefing.py")],
            capture_output=True, text=True, timeout=30,
            cwd=str(WAR_ROOM.parent.parent)
        )
        if push_result.stdout.strip():
            _act(f"[daily] Push: {push_result.stdout.strip()}")
    except Exception as e:
        _act(f"[daily] Briefing error: {e}")


# ══════════════════════════════════════════════════════════════════
# Weekly evolution override (Sunday 22-23)
# ══════════════════════════════════════════════════════════════════

def _weekly_evolution():
    """Run evolution cycle. Sunday 22-23 only."""
    _act("[weekly] Running evolution cycle")
    try:
        from shelter.core.evolution import evolution_cycle, weekly_evolution_report
        prompt_path = str(SHELTER / "prompts" / "p8-nightwatch.md")
        evolution_cycle(EVO_DB, prompt_path)
        report = weekly_evolution_report(EVO_DB)
        _act(f"[weekly] Evolution report:\n{report}")
    except Exception as e:
        _act(f"[weekly] Evolution error: {e}")


# ══════════════════════════════════════════════════════════════════
# Main: orchestrate the beat
# ══════════════════════════════════════════════════════════════════

def main():
    state = _load_beat_state()
    beat_n = state.get("beat", 0) + 1
    state["beat"] = beat_n

    # Determine which rotating layer runs this beat
    rotating_layer = (beat_n % 4) + 1  # 1, 2, 3, or 4

    # ── Perception (every beat) ──
    perception_result = {}
    try:
        from shelter.perception import scan_all
        schedule_path = SHELTER / "cruz-schedule.yaml"
        perception_result = scan_all(str(schedule_path), now)
        threads_unreplied = perception_result.get("threads", {}).get("unreplied", 0)
        new_transcripts = perception_result.get("transcripts_count", 0)
        if threads_unreplied > 5 or new_transcripts > 0:
            _act(f"[perception] threads:{threads_unreplied} unreplied | transcripts:{new_transcripts} new")
        hook = perception_result.get("hook_health", {})
        if hook.get("status") == "degraded":
            _act(f"[hook] DEGRADED: {hook.get('errors',0)} errors, {hook.get('slow',0)} slow, avg {hook.get('avg_ms',0)}ms in last {hook.get('total',0)} runs")
    except ImportError:
        pass
    except Exception as e:
        _act(f"[perception] error: {e}")

    # ── L0: always ──
    l0_status = layer0_vital_signs()
    nen = _nen_metrics()

    # ── Rotating layer ──
    l1_result = None

    if rotating_layer == 1:
        l1_result = layer1_knowledge_metabolism()
    elif rotating_layer == 2:
        layer2_memory_digestion()
    elif rotating_layer == 3:
        layer3_evolution_pulse(state)
    elif rotating_layer == 4:
        layer4_coverage_expansion()

    # ── Special overrides ──

    # Daily briefing (06-07)
    if 6 <= hour <= 7:
        # Force L1 for briefing data if not already run
        if l1_result is None:
            l1_result = layer1_knowledge_metabolism()
        _daily_briefing(l0_status, l1_result)

    # Weekly evolution (Sunday 22-23)
    if weekday == 6 and 22 <= hour <= 23:
        _weekly_evolution()

    # ── Save state ──
    state["last_run"] = now.isoformat()
    _save_beat_state(state)

    # ── 寫工作到共享佇列（讓其他 session 的 pulse 領取）──
    try:
        from shelter.pulse import enqueue

        # 有待審提案 → 推到佇列
        try:
            from shelter.core.phase1_evolution import review
            pending = review()
            if pending:
                enqueue("evolve_proposal_review", {"count": len(pending)}, priority=3)
        except Exception:
            pass

        # Threads 未回覆多 → 推到佇列
        threads_unreplied = perception_result.get("threads", {}).get("unreplied", 0)
        if threads_unreplied > 20:
            enqueue("threads_reply", {"unreplied": threads_unreplied}, priority=4)

    except ImportError:
        pass
    except Exception:
        pass

    # ── Lifecycle GC (every 72 beats = ~6h at 5-min ticks) ──
    if beat_n % 72 == 0:
        _lifecycle_gc()

    # ── Refresh dashboard data ──
    try:
        import subprocess
        subprocess.run(
            ["python3", str(SHELTER / "generate-dashboard-data.py")],
            capture_output=True, timeout=10,
        )
    except Exception:
        pass  # Non-critical

    # ── Summary line ──
    action_summary = "; ".join(_actions) if _actions else "quiet"
    # Truncate if too long
    if len(action_summary) > 200:
        action_summary = action_summary[:197] + "..."

    # Compact stats suffix
    nen_out = SHELTER / "data" / "nen-bridge-output.jsonl"
    cc_mem = sum(1 for _ in open(nen_out)) if nen_out.exists() else 0

    # Perception suffix
    p_threads = perception_result.get("threads", {}).get("unreplied", 0)
    p_transcripts = perception_result.get("transcripts_count", 0)
    print(f"heartbeat #{beat_n}: L0+L{rotating_layer} | {action_summary} | cc={cc_mem} | thr:{p_threads} srt:{p_transcripts}")


if __name__ == "__main__":
    main()

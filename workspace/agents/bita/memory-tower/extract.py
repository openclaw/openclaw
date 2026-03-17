#!/usr/bin/env python3
"""
幣塔記憶塔 L0 萃取器
逐群拉訊息 → 下載截圖 → 結構化存 L0

用法:
  python3 extract.py scan           # 掃描所有群的訊息範圍
  python3 extract.py pull <group> [batch_size]  # 拉指定群的下一批
  python3 extract.py status         # 看消化進度
  python3 extract.py download <group> <msg_id>  # 下載單張截圖
"""

import json, os, sys, urllib.request, urllib.parse
from pathlib import Path
from datetime import datetime

BASE = Path(__file__).resolve().parent
L0_DIR = BASE / "L0"
DOWNLOADS_DIR = BASE / "downloads"
STATE_FILE = BASE / "state.json"

GROUPS = {
    "管理群": {"id": -1003849990504, "name": "幣塔管理群"},
    "QQ":     {"id": -5030731997,    "name": "幣塔AI工作回報(QQ)", "employee": "靜🌹/QQ"},
    "周":     {"id": -5295280162,    "name": "幣塔AI工作回報(周)", "employee": "小周"},
    "子":     {"id": -5070604096,    "name": "幣塔AI工作回報(子)", "employee": "子墨/Z"},
    "俊":     {"id": -5159438640,    "name": "幣塔AI工作回報(俊)", "employee": "小峻"},
    "兔":     {"id": -5148508655,    "name": "幣塔AI工作回報(兔)", "employee": "兔兔"},
    "葦":     {"id": -5023713246,    "name": "幣塔AI工作回報(葦)", "employee": "葦葦"},
    "茂":     {"id": -5186655303,    "name": "幣塔AI工作回報(茂)", "employee": "茂"},
}

BRIDGE_URL = "http://127.0.0.1:18796"


def _get_token():
    cfg_path = Path(__file__).resolve().parents[3] / "skills" / "telegram-userbot" / "config.json"
    try:
        return json.loads(cfg_path.read_text()).get("bridge_token", "")
    except Exception:
        return ""


def _headers():
    token = _get_token()
    h = {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _api(endpoint, timeout=15):
    req = urllib.request.Request(f"{BRIDGE_URL}/{endpoint}", headers=_headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw)


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def cmd_scan():
    """掃描所有群的訊息範圍"""
    state = load_state()

    for key, info in GROUPS.items():
        chat_id = info["id"]
        print(f"\n{'='*50}")
        print(f"  {key} ({info['name']})")

        # Get newest messages
        try:
            data = _api(f"messages?chat={chat_id}&limit=5")
            msgs = data.get("messages", [])
            if not msgs:
                print("  ⚠️  NO MESSAGES")
                continue

            newest_id = msgs[0]["id"]
            newest_date = msgs[0].get("date", "")[:10]

            # Find oldest by binary search
            oldest_id = newest_id
            oldest_date = newest_date
            offset = newest_id
            while True:
                data2 = _api(f"messages?chat={chat_id}&limit=100&offset_id={offset}")
                batch = data2.get("messages", [])
                if not batch:
                    break
                oldest_id = batch[-1]["id"]
                oldest_date = batch[-1].get("date", "")[:10]
                if len(batch) < 100:
                    break
                offset = oldest_id

            # Count media in a sample
            data3 = _api(f"messages?chat={chat_id}&limit=100&offset_id={newest_id + 1}")
            sample = data3.get("messages", [])
            media_count = sum(1 for m in sample if m.get("has_media"))

            print(f"  Range: {oldest_date} (id:{oldest_id}) → {newest_date} (id:{newest_id})")
            print(f"  Sample media density: {media_count}/100 = {media_count}%")

            # Update state
            if key not in state:
                state[key] = {}
            state[key]["oldest_id"] = oldest_id
            state[key]["newest_id"] = newest_id
            state[key]["oldest_date"] = oldest_date
            state[key]["newest_date"] = newest_date
            state[key]["next_offset"] = newest_id + 1  # start from newest, go back
            state[key]["batches_done"] = state[key].get("batches_done", 0)
            state[key]["screenshots_read"] = state[key].get("screenshots_read", 0)

        except Exception as e:
            print(f"  ❌ Error: {e}")

    save_state(state)
    print(f"\n✅ State saved to {STATE_FILE}")


def cmd_pull(group_key, batch_size=50):
    """拉指定群的下一批訊息，結構化存 L0"""
    state = load_state()

    if group_key not in GROUPS:
        print(f"❌ Unknown group: {group_key}")
        print(f"Available: {', '.join(GROUPS.keys())}")
        return

    info = GROUPS[group_key]
    chat_id = info["id"]
    gs = state.get(group_key, {})

    if not gs:
        print(f"⚠️  Run 'scan' first")
        return

    offset = gs.get("next_offset", gs.get("newest_id", 0) + 1)
    oldest_boundary = gs.get("oldest_id", 0)

    if offset <= oldest_boundary:
        print(f"✅ {group_key} fully consumed!")
        return

    # Pull batch
    data = _api(f"messages?chat={chat_id}&limit={batch_size}&offset_id={offset}")
    msgs = data.get("messages", [])

    if not msgs:
        print(f"✅ {group_key} no more messages")
        return

    # Structure L0
    batch_num = gs.get("batches_done", 0) + 1
    group_dir = L0_DIR / group_key
    group_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    media_ids = []

    for m in reversed(msgs):  # chronological order
        entry = {
            "id": m["id"],
            "date": m.get("date", ""),
            "sender": m.get("sender_name", "?"),
            "text": m.get("text", ""),
            "has_media": m.get("has_media", False),
            "media_downloaded": False,
            "media_file": None,
        }
        entries.append(entry)
        if m.get("has_media"):
            media_ids.append(m["id"])

    batch_file = group_dir / f"batch-{batch_num:03d}.json"
    batch_data = {
        "group": group_key,
        "group_name": info["name"],
        "employee": info.get("employee", ""),
        "batch_num": batch_num,
        "pulled_at": datetime.now().isoformat(),
        "msg_range": f"{msgs[-1]['id']}..{msgs[0]['id']}",
        "date_range": f"{msgs[-1].get('date','')[:10]}..{msgs[0].get('date','')[:10]}",
        "total_msgs": len(msgs),
        "media_msgs": len(media_ids),
        "entries": entries,
    }

    batch_file.write_text(json.dumps(batch_data, indent=2, ensure_ascii=False))

    # Update state
    gs["next_offset"] = msgs[-1]["id"]  # oldest msg id in this batch
    gs["batches_done"] = batch_num
    state[group_key] = gs
    save_state(state)

    print(f"✅ {group_key} batch {batch_num}: {len(msgs)} msgs ({len(media_ids)} media)")
    print(f"   Date: {batch_data['date_range']}")
    print(f"   File: {batch_file}")
    print(f"   Media IDs to download: {media_ids[:5]}{'...' if len(media_ids) > 5 else ''}")


def cmd_download(group_key, msg_id):
    """下載單張截圖"""
    info = GROUPS.get(group_key)
    if not info:
        print(f"❌ Unknown group: {group_key}")
        return

    chat_id = info["id"]
    dl_dir = DOWNLOADS_DIR / group_key
    dl_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = _api(f"download?chat={chat_id}&msg={msg_id}", timeout=30)
        if result.get("ok"):
            src = result["file"]
            name = result.get("name", f"msg-{msg_id}.jpg")
            dst = dl_dir / f"{msg_id}_{name}"

            # Copy to our downloads dir
            import shutil
            shutil.copy2(src, dst)

            print(f"✅ Downloaded: {dst} ({result.get('size', 0)} bytes)")
            return str(dst)
        else:
            print(f"❌ Download failed: {result}")
    except Exception as e:
        print(f"❌ Error: {e}")
    return None


def cmd_download_batch(group_key, batch_num):
    """下載指定批次的所有截圖"""
    batch_file = L0_DIR / group_key / f"batch-{batch_num:03d}.json"
    if not batch_file.exists():
        print(f"❌ Batch file not found: {batch_file}")
        return

    batch = json.loads(batch_file.read_text())
    media_entries = [e for e in batch["entries"] if e["has_media"] and not e["media_downloaded"]]
    print(f"📥 Downloading {len(media_entries)} media from {group_key} batch {batch_num}...")

    info = GROUPS[group_key]
    chat_id = info["id"]
    dl_dir = DOWNLOADS_DIR / group_key
    dl_dir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    for entry in media_entries:
        msg_id = entry["id"]
        try:
            result = _api(f"download?chat={chat_id}&msg={msg_id}", timeout=30)
            if result.get("ok"):
                src = result["file"]
                name = result.get("name", f"msg-{msg_id}.jpg")
                dst = dl_dir / f"{msg_id}_{name}"

                import shutil
                shutil.copy2(src, dst)

                entry["media_downloaded"] = True
                entry["media_file"] = str(dst)
                downloaded += 1
            else:
                print(f"  ⚠️  msg {msg_id}: download failed")
        except Exception as e:
            print(f"  ❌ msg {msg_id}: {e}")

    # Save updated batch
    batch_file.write_text(json.dumps(batch, indent=2, ensure_ascii=False))
    print(f"✅ Downloaded {downloaded}/{len(media_entries)} media files")


def cmd_status():
    """顯示消化進度"""
    state = load_state()
    if not state:
        print("⚠️  No state. Run 'scan' first.")
        return

    print(f"\n{'群組':<8} {'批次':>4} {'截圖讀取':>8} {'範圍':<25} {'進度'}")
    print("─" * 70)

    for key in GROUPS:
        gs = state.get(key, {})
        if not gs:
            print(f"{key:<8} {'—':>4} {'—':>8} {'未掃描':<25}")
            continue

        batches = gs.get("batches_done", 0)
        screenshots = gs.get("screenshots_read", 0)
        date_range = f"{gs.get('oldest_date', '?')}..{gs.get('newest_date', '?')}"
        next_off = gs.get("next_offset", 0)
        oldest = gs.get("oldest_id", 0)

        if next_off <= oldest:
            progress = "✅ 完成"
        else:
            progress = f"→ offset {next_off}"

        print(f"{key:<8} {batches:>4} {screenshots:>8} {date_range:<25} {progress}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    if cmd == "scan":
        cmd_scan()
    elif cmd == "pull":
        group = args[1] if len(args) > 1 else None
        batch_size = int(args[2]) if len(args) > 2 else 50
        if not group:
            print("Usage: extract.py pull <group> [batch_size]")
        else:
            cmd_pull(group, batch_size)
    elif cmd == "download":
        if len(args) >= 3:
            cmd_download(args[1], int(args[2]))
        elif len(args) == 2 and args[1].startswith("batch:"):
            # download batch:QQ:1
            parts = args[1].split(":")
            cmd_download_batch(parts[1], int(parts[2]))
        else:
            print("Usage: extract.py download <group> <msg_id>")
            print("       extract.py download batch:<group>:<batch_num>")
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)

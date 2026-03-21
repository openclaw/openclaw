#!/usr/bin/env python3
"""Social Engine — 跨頻道社群互動引擎

用法:
  python3 engine.py scan              # 掃描所有頻道
  python3 engine.py status            # 顯示 CRM 狀態
  python3 engine.py feed <topic> <msg> # 推送更新給訂閱者
  python3 engine.py link <cid> <ch> <handle>  # 手動連結身份
  python3 engine.py subscribers       # 列出訂閱者
"""
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from core.db import init_db
from core.identity import Identity
from core.context import ContextBuilder
from core.feed import FeedEngine
from adapters.threads import ThreadsAdapter
from adapters.telegram import TelegramAdapter
from adapters.gmail import GmailAdapter
try:
    from adapters.line_personal import LinePersonalAdapter
except ImportError:
    LinePersonalAdapter = None


def cmd_status():
    conn = init_db()
    identity = Identity(conn)

    contacts = conn.execute('SELECT COUNT(*) as c FROM contacts').fetchone()['c']
    handles = conn.execute('SELECT COUNT(*) as c FROM contact_handles').fetchone()['c']
    interactions = conn.execute('SELECT COUNT(*) as c FROM interactions').fetchone()['c']
    subs = identity.get_subscribers(min_depth=5)
    recruits = identity.get_recruitment_candidates()

    print(f'Contacts: {contacts} | Handles: {handles} | Interactions: {interactions}')
    print(f'Subscribers (5+): {len(subs)} | Recruitment signals: {len(recruits)}')

    # Channel distribution
    channels = conn.execute('SELECT channel, COUNT(*) as c FROM contact_handles GROUP BY channel').fetchall()
    for ch in channels:
        print(f'  {ch["channel"]}: {ch["c"]} handles')

    conn.close()


def cmd_subscribers():
    conn = init_db()
    identity = Identity(conn)
    subs = identity.get_subscribers(min_depth=3)
    for s in subs:
        handles = identity.get_handles(s['canonical_id'])
        h_str = ', '.join(f'{h["channel"]}:{h["handle"]}' for h in handles)
        recruit = f' 🎯{s["recruitment_signal"]}' if s['recruitment_signal'] else ''
        print(f'  [{s["tier"]}/{s["stance"]}] {s["display_name"]:20s} depth:{s["engagement_depth"]:3d} [{h_str}]{recruit}')
    conn.close()


def cmd_link(canonical_id, channel, handle):
    conn = init_db()
    identity = Identity(conn)
    identity.link(canonical_id, channel, handle)
    print(f'Linked: {canonical_id} -> {channel}:{handle}')
    conn.close()


def cmd_feed(topic, message):
    conn = init_db()
    identity = Identity(conn)
    adapters = {
        'threads': ThreadsAdapter(),
        'telegram': TelegramAdapter(),
    }
    feed = FeedEngine(conn, identity, adapters)
    results = feed.push_update(topic, message)
    for cid, ch, ok in results:
        status = '✅' if ok else '❌'
        print(f'  {status} {cid} via {ch}')
    conn.close()


def cmd_scan():
    conn = init_db()
    identity = Identity(conn)
    ctx_builder = ContextBuilder(conn, identity)

    adapters = {'threads': ThreadsAdapter()}
    if LinePersonalAdapter:
        line = LinePersonalAdapter()
        if line.is_available():
            adapters['line_personal'] = line

    for name, adapter in adapters.items():
        print(f'Scanning {name}...')
        messages = adapter.scan()
        print(f'  {len(messages)} new messages')

        for msg in messages[:10]:
            cid = identity.get_or_create(name, msg['handle'])
            identity.record_interaction(cid)

            # Store interaction
            conn.execute(
                'INSERT INTO interactions (canonical_id, channel, direction, message_text, media_type) VALUES (?,?,?,?,?)',
                (cid, name, 'inbound', msg.get('text', ''), msg.get('media_type', 'TEXT'))
            )
            conn.commit()

            # Build context
            context = ctx_builder.build(cid, name, msg.get('text', ''))
            if context:
                depth = ctx_builder.reply_depth(context)
                needs_approval = context.get('needs_approval', False)
                tier = context['profile']['tier']
                print(f'    @{msg["handle"]} [{tier}] depth:{depth} approval:{needs_approval}')

    conn.close()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == 'status':
        cmd_status()
    elif cmd == 'subscribers':
        cmd_subscribers()
    elif cmd == 'scan':
        cmd_scan()
    elif cmd == 'link' and len(sys.argv) >= 5:
        cmd_link(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'feed' and len(sys.argv) >= 4:
        cmd_feed(sys.argv[2], ' '.join(sys.argv[3:]))
    else:
        print(__doc__)

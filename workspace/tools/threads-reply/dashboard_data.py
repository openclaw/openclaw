#!/usr/bin/env python3
"""Generate threads-dashboard-data.json for the Threads campaign dashboard."""
import sys, json, os
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
os.chdir(Path(__file__).parent)

import threads_db as db

def generate():
    conn = db.get_conn()

    # Coverage
    sent = conn.execute('SELECT COUNT(*) as c FROM replies WHERE status="sent"').fetchone()['c']
    total = conn.execute('SELECT COUNT(DISTINCT c.comment_id) as c FROM comments c JOIN profiles p ON c.user_id=p.user_id WHERE p.username != "tangcruzz"').fetchone()['c']
    failed = conn.execute('SELECT COUNT(*) as c FROM replies WHERE status="failed"').fetchone()['c']

    # Posts
    posts = []
    for p in conn.execute('SELECT post_id, text_content, posted_at FROM posts WHERE text_content IS NOT NULL ORDER BY posted_at DESC LIMIT 10').fetchall():
        comment_count = conn.execute('SELECT COUNT(*) as c FROM comments WHERE post_id=?', (p['post_id'],)).fetchone()['c']
        posts.append({
            'id': p['post_id'],
            'text': (p['text_content'] or '')[:80],
            'posted_at': p['posted_at'],
            'comments': comment_count,
        })

    # Subscribers (engagement_depth >= 5)
    subs = conn.execute('''
        SELECT username, value_tier, stance, engagement_depth, topic_interests, recruitment_signal
        FROM profiles
        WHERE engagement_depth >= 5 AND username != "tangcruzz"
        ORDER BY engagement_depth DESC
    ''').fetchall()
    subscribers = []
    for s in subs:
        subscribers.append({
            'username': s['username'],
            'tier': s['value_tier'] or 'C',
            'stance': s['stance'] or '?',
            'depth': s['engagement_depth'],
            'topics': json.loads(s['topic_interests']) if s['topic_interests'] else [],
            'recruit': s['recruitment_signal'],
        })

    # Topic distribution
    from collections import Counter
    topic_counts = Counter()
    for s in subscribers:
        for t in s['topics']:
            topic_counts[t] += 1

    # Stance distribution
    stance_dist = {}
    for row in conn.execute('SELECT stance, COUNT(*) as cnt FROM profiles WHERE username != "tangcruzz" AND stance IS NOT NULL GROUP BY stance').fetchall():
        stance_dist[row['stance']] = row['cnt']

    # Tier distribution
    tier_dist = {}
    for row in conn.execute('SELECT value_tier, COUNT(*) as cnt FROM profiles WHERE username != "tangcruzz" AND value_tier IS NOT NULL GROUP BY value_tier').fetchall():
        tier_dist[row['value_tier']] = row['cnt']

    # Recent activity (last 24h comments)
    recent = conn.execute('''
        SELECT COUNT(*) as c FROM comments
        WHERE posted_at > datetime("now", "-24 hours")
    ''').fetchone()['c']

    data = {
        'generated_at': datetime.now().isoformat(),
        'coverage': {'sent': sent, 'total': total, 'failed': failed, 'rate': round(sent/max(total,1)*100)},
        'posts': posts,
        'subscribers': {'count': len(subscribers), 'list': subscribers},
        'topics': dict(topic_counts.most_common()),
        'stance': stance_dist,
        'tiers': tier_dist,
        'recent_24h': recent,
    }

    out = Path(__file__).parent / 'dashboard-data.json'
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    conn.close()
    print(f'Generated: {out} ({len(subscribers)} subscribers, {sent}/{total} coverage)')
    return data

if __name__ == '__main__':
    generate()

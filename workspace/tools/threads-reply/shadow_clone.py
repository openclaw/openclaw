#!/usr/bin/env python3
"""
影分身之術 — Opus sub-agent 並行回覆管線

流程：
  1. 從 DB 撈未回覆留言
  2. 8 道品質門檻篩選
  3. 為每則生成完整 context block
  4. 輸出 context blocks（供主 session 的 Agent tool 並行調用）

Usage:
    python3 shadow_clone.py prepare --limit 5    # 準備 5 個 context blocks
    python3 shadow_clone.py send                  # 發送已審批的回覆
"""
import sys, json, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import threads_db as db
import threads_reply as tr


def build_context_block(conn, comment) -> dict | None:
    """為一則留言建完整的 context block，供 Opus sub-agent 使用。"""
    username = comment['username']
    text = (comment['text_content'] or '').strip()
    comment_id = comment['comment_id']
    post_id = comment['post_id']
    parent_id = comment['parent_comment_id']

    # Skip if replying to someone else
    if parent_id:
        parent = conn.execute('''SELECT p.username, c.text_content FROM comments c
            JOIN profiles p ON c.user_id=p.user_id WHERE c.comment_id=?''', (parent_id,)).fetchone()
        if parent and parent['username'] != 'tangcruzz':
            return None  # He's talking to someone else

    # Skip fragments
    if len(text) <= 10:
        return None

    # Post context
    post = conn.execute('SELECT text_content, posted_at FROM posts WHERE post_id=?', (post_id,)).fetchone()
    post_text = (post['text_content'] or '')[:200] if post else ''

    # Profile
    prof = conn.execute('SELECT * FROM profiles WHERE username=?', (username,)).fetchone()

    # Our history with this person
    history = conn.execute('''
        SELECT c.text_content as their_text, r.reply_text as our_reply
        FROM comments c JOIN profiles p ON c.user_id=p.user_id
        LEFT JOIN replies r ON c.comment_id=r.comment_id AND r.status='sent'
        WHERE p.username=? ORDER BY c.posted_at DESC LIMIT 3
    ''', (username,)).fetchall()

    # Parent context (if replying to us)
    parent_context = None
    if parent_id:
        parent = conn.execute('''SELECT c.text_content, p.username FROM comments c
            JOIN profiles p ON c.user_id=p.user_id WHERE c.comment_id=?''', (parent_id,)).fetchone()
        if parent:
            parent_context = {'username': parent['username'], 'text': (parent['text_content'] or '')[:100]}

    # Comment age
    age_info = ''
    try:
        from datetime import datetime
        if comment['posted_at']:
            posted = datetime.fromisoformat(comment['posted_at'].replace('+0000', '+00:00'))
            days = (datetime.now(posted.tzinfo) - posted).days if posted.tzinfo else 0
            if days > 14:
                age_info = f'這則留言是 {days} 天前的，我們遲了很久才回。'
            elif days > 7:
                age_info = f'留言是 {days} 天前的。'
    except Exception:
        pass

    # Language detection
    lang = 'zh_tw'
    ascii_ratio = sum(1 for c in text if c.isascii() and c.isalpha()) / max(len(text), 1)
    if ascii_ratio > 0.7:
        lang = 'en'
    simplified_chars = set('这个来对们说会还让没关于从进过为实经')
    if any(c in simplified_chars for c in text):
        lang = 'cn_simplified'
    canto_chars = set('嘅啲咗佢哋嘢冇係咁')
    if any(c in canto_chars for c in text):
        lang = 'cantonese'

    return {
        'comment_id': comment_id,
        'post_id': post_id,
        'username': username,
        'comment': text,
        'post_context': post_text,
        'posted_at': comment['posted_at'],
        'age_info': age_info,
        'lang': lang,
        'parent': parent_context,
        'profile': {
            'tier': prof['value_tier'] if prof else 'C',
            'stance': prof['stance'] if prof else '?',
            'depth': prof['engagement_depth'] if prof else 0,
            'followers': prof['follower_count'] if prof else 0,
            'bio': (prof['bio'] or '')[:50] if prof else '',
        } if prof else {'tier': 'C', 'stance': '?', 'depth': 0},
        'history': [{'them': (h['their_text'] or '')[:60], 'us': (h['our_reply'] or '')[:40]} for h in history],
    }


def build_agent_prompt(block: dict) -> str:
    """把 context block 轉成 sub-agent 的 prompt。"""
    prof = block['profile']
    tier_desc = {
        'S': '核心圈（Cruz 的朋友/員工）',
        'A': '高價值用戶，多次互動',
        'B': '中等互動，有潛力',
        'C': '新用戶或低互動',
    }.get(prof['tier'], '未知')

    history_str = ''
    if block['history']:
        history_str = '\n歷史對話：\n'
        for h in block['history']:
            history_str += f"  他: {h['them']}\n"
            if h['us'] and '[' not in h['us']:
                history_str += f"  我: {h['us']}\n"

    parent_str = ''
    if block['parent']:
        parent_str = f"\n他在回覆 @{block['parent']['username']} 的：「{block['parent']['text']}」"

    lang_hint = ''
    if block['lang'] == 'en':
        lang_hint = '\n他用英文留言，用英文回。'
    elif block['lang'] == 'cn_simplified':
        lang_hint = '\n他用簡體中文，用繁體回（你是台灣人）。'
    elif block['lang'] == 'cantonese':
        lang_hint = '\n他用粵語，用繁體中文回但可以輕鬆一點。'

    age_str = f'\n{block["age_info"]}' if block['age_info'] else ''

    return f"""你是 tangcruzz，在 Threads 上回覆留言。

帖文：「{block['post_context']}」

留言者：@{block['username']} [{prof['tier']}/{prof['stance']}] {tier_desc}
{f"followers: {prof['followers']}" if prof.get('followers') else ''}
{f"bio: {prof['bio']}" if prof.get('bio') else ''}{history_str}{parent_str}{lang_hint}{age_str}

他的留言：「{block['comment']}」

規則：
- 字數對等（他寫多少字你寫多少字）
- 不用「歡迎指出」「數據面前人人平等」等模板句
- 如果遲到了，簡短承認（「晚回了」而不是長篇道歉）
- 如果他是專家（tier A/B），語氣要尊重不居高臨下
- 如果他在生氣，先承認再回應
- 預判：他收到你的回覆後會怎麼理解？會怎麼回？如果你的回覆會讓他覺得是罐頭/打太極/居高臨下，換一種說法
- 繁體中文（除非他用英文）
- 不加 emoji（除非他用了）

只輸出回覆文字。不加任何解釋。一到三句話。"""


def cmd_prepare(limit=5):
    """準備 context blocks 並輸出 agent prompts。"""
    conn = db.get_conn()

    rows = conn.execute('''
        SELECT c.comment_id, c.post_id, c.text_content, p.username, c.posted_at, c.parent_comment_id
        FROM comments c
        LEFT JOIN replies r ON c.comment_id = r.comment_id
        JOIN profiles p ON c.user_id = p.user_id
        WHERE r.reply_id IS NULL AND p.username != ?
              AND length(c.text_content) > 10
        ORDER BY
            CASE (SELECT value_tier FROM profiles WHERE username=p.username)
                WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3
            END,
            c.posted_at DESC
        LIMIT ?
    ''', (tr.MY_USERNAME, limit * 3)).fetchall()  # Fetch more, filter later

    blocks = []
    for r in rows:
        if len(blocks) >= limit:
            break
        block = build_context_block(conn, r)
        if block:
            blocks.append(block)

    # Mark skipped ones
    skipped = 0
    for r in rows:
        if r['comment_id'] not in [b['comment_id'] for b in blocks]:
            parent_id = r['parent_comment_id']
            if parent_id:
                parent = conn.execute('SELECT p.username FROM comments c JOIN profiles p ON c.user_id=p.user_id WHERE c.comment_id=?', (parent_id,)).fetchone()
                if parent and parent['username'] != 'tangcruzz':
                    db.add_reply(conn, r['comment_id'], r['post_id'], f'[CTX_not_us]', status='failed')
                    skipped += 1
            elif len((r['text_content'] or '').strip()) <= 10:
                db.add_reply(conn, r['comment_id'], r['post_id'], '[FRAGMENT]', status='failed')
                skipped += 1
    conn.commit()

    print(f"Prepared {len(blocks)} context blocks (skipped {skipped})")
    print()

    for i, block in enumerate(blocks):
        prompt = build_agent_prompt(block)
        print(f"=== CLONE #{i+1}: @{block['username']} ({block['profile']['tier']}) ===")
        print(f"comment_id: {block['comment_id']}")
        print(f"post_id: {block['post_id']}")
        print(f"PROMPT:")
        print(prompt)
        print()

    # Save blocks to file for the main session to use
    out = Path(__file__).parent / 'shadow-clone-queue.json'
    out.write_text(json.dumps(blocks, ensure_ascii=False, indent=2))
    print(f"Saved to {out}")

    conn.close()
    return blocks


def cmd_send():
    """發送已審批的回覆（從 shadow-clone-results.json 讀取）。"""
    results_path = Path(__file__).parent / 'shadow-clone-results.json'
    if not results_path.exists():
        print("No results file. Run prepare first, then have agents write replies.")
        return

    results = json.loads(results_path.read_text())
    conn = db.get_conn()
    conn.execute('PRAGMA busy_timeout=60000')
    conn.execute('PRAGMA journal_mode=WAL')
    sent = 0

    for r in results:
        comment_id = r['comment_id']
        post_id = r['post_id']
        reply_text = r['reply']

        if not reply_text:
            continue

        # Check not already replied
        exists = conn.execute('SELECT 1 FROM replies WHERE comment_id=?', (comment_id,)).fetchone()
        if exists:
            continue

        db.add_reply(conn, comment_id, post_id, reply_text, status='pending')
        conn.commit()

        res = tr.api_post(f'{tr.USER_ID}/threads', {'media_type': 'TEXT', 'text': reply_text, 'reply_to_id': comment_id})
        if res and 'id' in res:
            time.sleep(3)
            pub = tr.api_post(f'{tr.USER_ID}/threads_publish', {'creation_id': res['id']})
            if pub and 'id' in pub:
                rid = conn.execute('SELECT reply_id FROM replies WHERE comment_id=? AND status="pending" ORDER BY reply_id DESC LIMIT 1',
                                   (comment_id,)).fetchone()
                if rid:
                    db.mark_reply_sent(conn, rid['reply_id'])
                    conn.commit()
                sent += 1
                print(f"✅ @{r.get('username', '?')}: {reply_text[:40]}")
            else:
                conn.execute('DELETE FROM replies WHERE status="pending"')
                conn.commit()
        else:
            conn.execute('DELETE FROM replies WHERE status="pending"')
            conn.commit()
        time.sleep(3)

    conn.close()
    print(f"\n{sent}/{len(results)} sent")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
    elif sys.argv[1] == 'prepare':
        limit = 5
        for i, arg in enumerate(sys.argv):
            if arg == '--limit' and i + 1 < len(sys.argv):
                limit = int(sys.argv[i + 1])
        cmd_prepare(limit)
    elif sys.argv[1] == 'send':
        cmd_send()
    else:
        print(__doc__)

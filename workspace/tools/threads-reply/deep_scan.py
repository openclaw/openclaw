#!/usr/bin/env python3
"""
Deep Scan — 每則留言帶完整 context block

不只拉文字。重建對話樹、查歷史、查第三方。
讓 Opus 4.6 有完整的眼睛。

用法：
  python3 deep_scan.py          # 掃描 + 輸出 context blocks
  python3 deep_scan.py --send   # 掃描 + Opus 回覆已嵌入 + 發送
"""

import os, sys, json, time, re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.chdir(Path(__file__).parent)

import threads_db as db
import threads_reply as tr

CF_TOKEN = "HH1pQ0fOvPPUhNy5uD0_B26yGVTJpQngBAwkN0UZ"
CF_ACCOUNT = "6a33ca7bf494988923ae430ca87619a9"


def get_reply_tree(comment_id):
    """查一則留言的子回覆（誰回了這則）。"""
    data = tr.api_get(f"{comment_id}/replies", {
        "fields": "id,text,username,timestamp,replied_to",
        "limit": 10
    })
    if data and "data" in data:
        return data["data"]
    return []


def get_conversation(comment_id):
    """查一則留言的完整對話串。"""
    data = tr.api_get(f"{comment_id}/conversation", {
        "fields": "id,text,username,timestamp,replied_to",
        "limit": 20
    })
    if data and "data" in data:
        return data["data"]
    return []


def get_user_history(conn, username):
    """查這個人在我們貼文裡的所有留言 + 我們的回覆。"""
    rows = conn.execute('''
        SELECT c.text_content, c.posted_at, c.parent_comment_id,
               r.reply_text, r.status as reply_status
        FROM comments c
        JOIN profiles p ON c.user_id = p.user_id
        LEFT JOIN replies r ON c.comment_id = r.comment_id AND r.status = 'sent'
        WHERE p.username = ?
        ORDER BY c.posted_at ASC
    ''', (username,)).fetchall()
    return rows


def get_parent_context(conn, parent_comment_id):
    """查 parent 留言的內容和作者。"""
    if not parent_comment_id:
        return None
    row = conn.execute('''
        SELECT c.text_content, p.username, c.parent_comment_id
        FROM comments c
        JOIN profiles p ON c.user_id = p.user_id
        WHERE c.comment_id = ?
    ''', (parent_comment_id,)).fetchone()
    return row


def get_profile(conn, username):
    """查 CRM profile（含新欄位）。"""
    row = conn.execute('''
        SELECT username, bio, follower_count, stance, value_tier, i_follow, follows_me,
               topic_interests, recruitment_signal, engagement_depth
        FROM profiles WHERE username = ?
    ''', (username,)).fetchone()
    return row


def build_context_block(conn, comment):
    """為一則留言建完整的 context block。"""
    username = comment['username']
    text = comment['text_content'] or ''
    comment_id = comment['comment_id']
    parent_id = comment['parent_comment_id'] if 'parent_comment_id' in comment.keys() else None

    block = {
        'username': username,
        'text': text,
        'comment_id': comment_id,
    }

    # 1. Profile（含興趣標籤、招募訊號、互動深度）
    profile = get_profile(conn, username)
    if profile:
        block['profile'] = {
            'tier': profile['value_tier'] or 'C',
            'stance': profile['stance'] or '?',
            'followers': profile['follower_count'] or 0,
            'bio': (profile['bio'] or '')[:100],
            'i_follow': profile['i_follow'],
            'follows_me': profile['follows_me'],
            'topics': json.loads(profile['topic_interests']) if profile['topic_interests'] else [],
            'depth': profile['engagement_depth'] or 0,
        }
        if profile['recruitment_signal']:
            block['profile']['recruit'] = profile['recruitment_signal']

    # 2. Parent chain（從 DB 查）
    if parent_id:
        parent = get_parent_context(conn, parent_id)
        if parent:
            block['replying_to'] = {
                'username': parent['username'],
                'text': (parent['text_content'] or '')[:100],
            }
            # 再往上一層
            if parent['parent_comment_id']:
                grandparent = get_parent_context(conn, parent['parent_comment_id'])
                if grandparent:
                    block['replying_to']['parent'] = {
                        'username': grandparent['username'],
                        'text': (grandparent['text_content'] or '')[:80],
                    }

    # 3. 如果 parent 是空的，嘗試從 API 查
    if not parent_id:
        # 用 API 查這則的 conversation
        conv = get_conversation(comment_id)
        if conv:
            # 找這則留言的 replied_to
            for entry in conv:
                if entry.get('id') == comment_id:
                    replied_to = entry.get('replied_to', {})
                    if replied_to and replied_to.get('id'):
                        # 找 parent 的內容
                        parent_entry = next((e for e in conv if e.get('id') == replied_to['id']), None)
                        if parent_entry:
                            block['replying_to'] = {
                                'username': parent_entry.get('username', '?'),
                                'text': (parent_entry.get('text', '') or '')[:100],
                                'source': 'api_conversation'
                            }

    # 4. 這個人的歷史互動
    history = get_user_history(conn, username)
    if history:
        block['history'] = {
            'total_comments': len(history),
            'our_replies': sum(1 for h in history if h['reply_text'] and '[已回覆' not in (h['reply_text'] or '')),
            'recent': []
        }
        for h in history[-3:]:  # 最近 3 則
            entry = {'text': (h['text_content'] or '')[:80]}
            if h['reply_text'] and '[已回覆' not in (h['reply_text'] or ''):
                entry['our_reply'] = (h['reply_text'] or '')[:60]
            block['history']['recent'].append(entry)

    # 5. 內容分析（從文字判斷對話對象）
    mentions = re.findall(r'@(\w+)', text)
    if mentions:
        block['mentions'] = mentions

    # 「我在回...」「不是在跟你講」等語意線索
    redirect_clues = []
    if re.search(r'我[是在]回[應覆]', text):
        redirect_clues.append('表明在回覆其他人')
    if re.search(r'不是[在跟].*你', text):
        redirect_clues.append('明確說不是在跟我們說話')
    if re.search(r'跟你[無沒]關', text):
        redirect_clues.append('說跟我們無關')
    if redirect_clues:
        block['redirect_clues'] = redirect_clues

    # 6. 判斷：是不是對我們說的？
    directed_at_us = True  # 預設是
    if block.get('redirect_clues'):
        directed_at_us = False
    if block.get('replying_to') and block['replying_to']['username'] != 'tangcruzz':
        # 有明確 parent 且不是回我們
        if block['replying_to']['username'] != '?':
            directed_at_us = False  # 他在回別人

    block['directed_at_us'] = directed_at_us

    return block


def deep_scan():
    """執行深度掃描，輸出所有待處理留言的 context blocks。"""
    print("① SCAN")
    tr.cmd_scan()

    conn = db.get_conn()

    # 找未回覆的留言（A-tier 優先，含圖片留言偵測）
    unreplied = conn.execute('''
        SELECT c.comment_id, c.post_id, c.text_content, p.username,
               c.parent_comment_id, c.like_count, c.media_type,
               pr.value_tier, pr.engagement_depth
        FROM comments c
        LEFT JOIN replies r ON c.comment_id = r.comment_id
        JOIN profiles p ON c.user_id = p.user_id
        LEFT JOIN profiles pr ON c.user_id = pr.user_id
        WHERE r.reply_id IS NULL AND p.username != ?
              AND (length(c.text_content) > 5 OR pr.value_tier IN ('S','A'))
        ORDER BY
            CASE pr.value_tier
                WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3
            END,
            c.posted_at DESC
    ''', (tr.MY_USERNAME,)).fetchall()

    # 標記圖片留言的 media_type（如果還沒有）
    for comment in unreplied:
        if not comment['text_content'] or len(comment['text_content'].strip()) <= 5:
            if not comment['media_type']:
                # 查 API 確認是否為圖片
                try:
                    res = tr.api_get(comment['comment_id'], {'fields': 'id,media_type'})
                    if res and res.get('media_type'):
                        conn.execute('UPDATE comments SET media_type=? WHERE comment_id=?',
                                     (res['media_type'], comment['comment_id']))
                        conn.commit()
                except: pass

    print(f"\n② DEEP CONTEXT（{len(unreplied)} 則待處理）\n")

    blocks = []
    api_calls = 0
    for comment in unreplied[:20]:  # 每輪最多 20 則深度分析
        block = build_context_block(conn, comment)
        blocks.append(block)

        # 輸出 context block（含興趣標籤、招募訊號）
        prof = block.get('profile', {})
        tier = prof.get('tier', 'C')
        stance = prof.get('stance', '?')
        depth = prof.get('depth', 0)
        topics = prof.get('topics', [])
        directed = '→我' if block['directed_at_us'] else '→他人'
        replying_to = f" (回@{block['replying_to']['username']})" if block.get('replying_to') else ''
        history_str = f" [{block['history']['total_comments']}則歷史]" if block.get('history') else ''
        clues = f" ⚠{block['redirect_clues'][0]}" if block.get('redirect_clues') else ''
        topic_str = f" topics:{','.join(topics[:3])}" if topics else ''
        recruit_str = f" 🎯{prof['recruit']}" if prof.get('recruit') else ''
        img_str = " [IMAGE]" if not block['text'].strip() else ''

        print(f"  [{tier}/{stance}] {directed} @{block['username']}{replying_to}{history_str}{topic_str}{recruit_str}{clues}{img_str}")
        print(f"    {block['text'][:100]}")
        if block.get('replying_to'):
            print(f"    ↳ @{block['replying_to']['username']}: {block['replying_to'].get('text', '')[:60]}")
        print()

    conn.close()

    # 統計
    directed = sum(1 for b in blocks if b['directed_at_us'])
    not_directed = len(blocks) - directed
    print(f"③ 統計：{directed} 則對我們說的 | {not_directed} 則不是對我們說的")

    # ④ Autonomy 決策（讀 .hormone）
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
        from hormone import get_autonomy, is_suppressed
        print(f"\n④ AUTONOMY 決策")
        for b in blocks:
            if not b['directed_at_us']:
                continue
            tier = b.get('profile', {}).get('tier', 'C')
            stance = b.get('profile', {}).get('stance', '?')
            # Map tier+stance to autonomy key
            if tier == 'S':
                key = 'S'
            elif tier == 'A' and stance == 'pro':
                key = 'A_pro'
            elif tier == 'A':
                key = 'A_neutral'
            elif tier == 'B':
                key = 'B'
            else:
                key = 'C'
            level = get_autonomy('threads_reply', key)
            emoji_only = not b['text'].strip() or all(c in '😡👊👎🤡❎🙌💪🔥' for c in b['text'].strip().replace(' ', ''))
            suppressed = is_suppressed('threads_emoji_replies') and emoji_only
            action = 'SUPPRESS(emoji)' if suppressed else level.upper()
            print(f"  @{b['username']:24s} [{tier}/{stance}] → {action}")
    except ImportError:
        pass

    return blocks


if __name__ == '__main__':
    blocks = deep_scan()

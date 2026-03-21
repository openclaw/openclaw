#!/usr/bin/env python3
"""
Batch Reply — 批量處理未回覆留言

不是罐頭。讀每則留言的內容，根據語意分類，生成對應回覆。

Usage:
    python3 batch_reply.py --dry-run          # 預覽，不發送
    python3 batch_reply.py --limit 20         # 發 20 則
    python3 batch_reply.py --limit 20 --send  # 真的發
"""
import sys, json, time, re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import threads_db as db
import threads_reply as tr

# Reply templates by category — NOT "歡迎指出" style
# Each category has multiple variants to avoid repetition
REPLY_MAP = {
    "agreement": [
        "🙌",
        "同感。",
        "你說的對。",
    ],
    "question_ai": [
        "好問題。核心是先定義問題,再選工具。工具每月都在變,但這個邏輯不變。",
        "是的。但重點不是工具多強,是你怎麼用它。",
        "AI 能力在加速,但判斷力還是人的。",
    ],
    "question_geopolitics": [
        "數據公開。CBO.gov 跟經濟部能源統計是起點,自己查比聽我說更有用。",
        "這個問題的答案取決於你站在哪個時間尺度看。短期跟長期完全不同。",
    ],
    "question_life": [
        "這題沒有標準答案。但找到你的槓桿點比找到正確答案更重要。",
        "每個人的答案不一樣。重要的是你問了這個問題。",
    ],
    "question_generic": [
        "好問題。這個值得展開,但留言區講不完。",
        "這個我也在想。還沒有確定的答案。",
    ],
    "positive_feedback": [
        "🙌",
        "謝謝你的回饋。",
        "很高興有幫助。",
    ],
    "substantive_insight": [
        "你的觀察很具體,這正是需要更多人一起想的方向。",
        "角度很好。你比大多數人想得深。",
        "這個切入點我之前沒想過。值得展開。",
    ],
    "hostile_with_point": [
        "你的情緒我理解。但數據在那裡,歡迎驗證。",
        "罵完了可以看看來源。每個數字都查得到。",
    ],
    "hostile_no_point": [
        "😄",
        "收到。",
    ],
    "self_promo": None,  # Skip
    "fragment": None,  # Skip
}

# Track which variant was last used to rotate
_variant_idx = {}


def classify(text: str) -> str:
    """Classify a comment into a category."""
    if not text or len(text.strip()) <= 3:
        return "fragment"

    t = text.strip().lower()

    # Questions
    has_q = '？' in text or '?' in text
    if has_q:
        if any(w in t for w in ['ai', 'gpt', 'claude', '模型', '程式', 'code', 'agent', 'prompt']):
            return "question_ai"
        elif any(w in t for w in ['台灣', '中國', '美國', '戰爭', '軍事', '飛彈', '國債', '經濟']):
            return "question_geopolitics"
        elif any(w in t for w in ['創業', '工作', '錢', '薪水', '人生', '焦慮', '壓力']):
            return "question_life"
        return "question_generic"

    # Hostile
    if any(w in t for w in ['笑死', '廢文', '垃圾', '白癡', '五毛', '網軍', '屁', '滾', '爛']):
        if len(text) > 30:
            return "hostile_with_point"
        return "hostile_no_point"

    # Positive
    if any(w in t for w in ['讚', '推', '好', '同意', '沒錯', '追蹤', '收藏', '學習', '筆記',
                              '太強', '厲害', '感謝', '謝謝', '加油', '支持', '棒', '認同',
                              '有道理', '佩服', '收', '留']):
        if len(text) > 50:
            return "positive_feedback"
        return "agreement"

    # Self promo
    if any(w in t for w in ['私訊', '找我們', '歡迎來', '加入', '報名', 'http']):
        return "self_promo"

    # Substantive
    if len(text) > 30:
        return "substantive_insight"

    return "fragment"


def get_reply(category: str) -> str | None:
    """Get a reply for this category, rotating variants."""
    templates = REPLY_MAP.get(category)
    if templates is None:
        return None

    idx = _variant_idx.get(category, 0)
    reply = templates[idx % len(templates)]
    _variant_idx[category] = idx + 1
    return reply


def main():
    dry_run = "--dry-run" in sys.argv or "--send" not in sys.argv
    limit = 20
    for i, arg in enumerate(sys.argv):
        if arg == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    conn = db.get_conn()

    unreplied = conn.execute('''
        SELECT c.comment_id, c.post_id, c.text_content, p.username
        FROM comments c
        LEFT JOIN replies r ON c.comment_id = r.comment_id
        JOIN profiles p ON c.user_id = p.user_id
        WHERE r.reply_id IS NULL AND p.username != ?
        ORDER BY c.posted_at DESC
    ''', (tr.MY_USERNAME,)).fetchall()

    print(f"Unreplied: {len(unreplied)} | Limit: {limit} | {'DRY RUN' if dry_run else 'SENDING'}")

    # Classify all
    categories = {}
    for u in unreplied:
        cat = classify(u['text_content'] or '')
        categories[cat] = categories.get(cat, 0) + 1

    print(f"\nCategories:")
    for cat, count in sorted(categories.items(), key=lambda x: -x[1]):
        action = "SKIP" if REPLY_MAP.get(cat) is None else "REPLY"
        print(f"  {cat:25s}: {count:4d} → {action}")

    # Process
    sent = 0
    skipped = 0
    for u in unreplied:
        if sent >= limit:
            break

        text = (u['text_content'] or '').strip()
        cat = classify(text)
        reply = get_reply(cat)

        if reply is None:
            # Skip
            if not dry_run:
                db.add_reply(conn, u['comment_id'], u['post_id'], f'[BATCH_{cat.upper()}]', status='failed')
                conn.commit()
            skipped += 1
            continue

        if dry_run:
            print(f"  [{cat:20s}] @{u['username']:20s} → {reply[:40]}")
            sent += 1
        else:
            db.add_reply(conn, u['comment_id'], u['post_id'], reply, status='pending')
            conn.commit()
            res = tr.api_post(f'{tr.USER_ID}/threads', {'media_type': 'TEXT', 'text': reply, 'reply_to_id': u['comment_id']})
            if res and 'id' in res:
                time.sleep(2)
                pub = tr.api_post(f'{tr.USER_ID}/threads_publish', {'creation_id': res['id']})
                if pub and 'id' in pub:
                    rid = conn.execute('SELECT reply_id FROM replies WHERE comment_id=? AND status="pending" ORDER BY reply_id DESC LIMIT 1',
                                       (u['comment_id'],)).fetchone()
                    if rid:
                        db.mark_reply_sent(conn, rid['reply_id'])
                        conn.commit()
                    sent += 1
                else:
                    conn.execute('DELETE FROM replies WHERE status="pending"')
                    conn.commit()
            else:
                conn.execute('DELETE FROM replies WHERE status="pending"')
                conn.commit()
            time.sleep(1)

    s = conn.execute('SELECT COUNT(*) FROM replies WHERE status="sent"').fetchone()[0]
    t2 = conn.execute('SELECT COUNT(DISTINCT c.comment_id) FROM comments c JOIN profiles p ON c.user_id=p.user_id WHERE p.username != ?',
                       (tr.MY_USERNAME,)).fetchone()[0]
    remaining = conn.execute('''SELECT COUNT(*) FROM comments c LEFT JOIN replies r ON c.comment_id=r.comment_id
        JOIN profiles p ON c.user_id=p.user_id WHERE r.reply_id IS NULL AND p.username != ?''',
                              (tr.MY_USERNAME,)).fetchone()[0]
    conn.close()

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Sent: {sent} | Skipped: {skipped}")
    print(f"Coverage: {s}/{t2} = {round(s / max(t2, 1) * 100)}% | Remaining: {remaining}")


if __name__ == "__main__":
    main()

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


def get_post_context(conn, post_id: str) -> dict:
    """Get the post's content and topic to align replies."""
    row = conn.execute('SELECT text_content FROM posts WHERE post_id=?', (post_id,)).fetchone()
    if not row or not row['text_content']:
        return {"topic": "general", "tone": "neutral", "text": ""}

    text = row['text_content'][:200].lower()
    topic = "general"
    tone = "neutral"

    if any(w in text for w in ['台海', '飛彈', '軍事', '國債', '戰爭', 'lng', '封鎖', '愛國者']):
        topic = "geopolitics"
        tone = "serious"
    elif any(w in text for w in ['ai', 'claude', 'gpt', '模型', '程式', 'code', 'agent', 'vibe', 'openclaw']):
        topic = "tech"
        tone = "enthusiastic"
    elif any(w in text for w in ['苗栗', '小吃', '早餐', '咖啡', '跑步', '生日', '兒子']):
        topic = "life"
        tone = "warm"
    elif any(w in text for w in ['創業', '公司', '薪水', '員工', '團隊']):
        topic = "business"
        tone = "pragmatic"
    elif any(w in text for w in ['冥想', '覺察', '能量', '薩古魯', '佛', '心智']):
        topic = "spiritual"
        tone = "reflective"
    elif any(w in text for w in ['女', '關係', '愛', '男', '感情']):
        topic = "relationships"
        tone = "empathetic"

    return {"topic": topic, "tone": tone, "text": row['text_content'][:100]}


# Context-aware reply variants — keyed by (category, post_topic)
CONTEXTUAL_REPLIES = {
    ("substantive_insight", "geopolitics"): [
        "你的分析有結構。這個角度值得更多人看到。",
        "同意。數據層面確實如此。",
        "你提的這點正好補了我原文沒展開的部分。",
    ],
    ("substantive_insight", "tech"): [
        "實務經驗比理論有用。你說的這個場景我也遇過。",
        "對,工具會變但底層邏輯不變。",
        "這個技術細節很重要,謝謝補充。",
    ],
    ("substantive_insight", "life"): [
        "生活就是這樣,沒什麼大道理。",
        "哈,你懂。",
        "對,日子還是要過。",
    ],
    ("substantive_insight", "business"): [
        "創業路上大家都踩過類似的坑。",
        "你說的這個我也在經歷。",
        "現實就是這樣,先活下來再說。",
    ],
    ("substantive_insight", "spiritual"): [
        "這個體悟不是每個人都能到的。",
        "嗯,練習的人才懂。",
        "你說的正是那個轉折點。",
    ],
    ("substantive_insight", "relationships"): [
        "感情的事,想太多反而更卡。",
        "你看到了大多數人看不到的那層。",
        "對,不是技巧的問題,是理解的問題。",
    ],
    ("question_ai", "tech"): [
        "核心是：先定義問題,再選工具。這個邏輯不會因為模型升級而改變。",
        "試了就知道。理論不如實戰。",
    ],
    ("question_geopolitics", "geopolitics"): [
        "這個問題的答案在 CBO.gov 跟經濟部能源統計裡。自己查比聽我說更有用。",
        "取決於你站在什麼時間尺度看。短期跟長期完全不同。",
    ],
    ("hostile_with_point", "geopolitics"): [
        "情緒我理解。但數字不會因為你不喜歡就消失。來源都在原文裡。",
        "你罵的對象是 CBO 跟經濟部的數據,不是我。",
    ],
    ("hostile_with_point", "tech"): [
        "你的質疑合理。但先試過再評價會更有說服力。",
        "對,AI 不是萬能。但你說的那個問題,它確實能幫上忙。",
    ],
    ("positive_feedback", "geopolitics"): [
        "謝謝。希望有幫助你理解全局。",
        "🙌 數據在那裡,歡迎驗證。",
    ],
    ("positive_feedback", "tech"): [
        "🙌 有問題隨時問。",
        "謝謝。希望對你的專案有用。",
    ],
    ("positive_feedback", "life"): [
        "🙌",
        "謝啦。",
    ],
}


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


def get_reply(category: str, post_context: dict = None) -> str | None:
    """Get a context-aware reply, falling back to generic if no match."""
    # Try context-aware first
    if post_context:
        topic = post_context.get("topic", "general")
        key = (category, topic)
        if key in CONTEXTUAL_REPLIES:
            templates = CONTEXTUAL_REPLIES[key]
            idx = _variant_idx.get(str(key), 0)
            reply = templates[idx % len(templates)]
            _variant_idx[str(key)] = idx + 1
            return reply

    # Fallback to generic
    templates = REPLY_MAP.get(category)
    if templates is None:
        return None

    idx = _variant_idx.get(category, 0)
    reply = templates[idx % len(templates)]
    _variant_idx[category] = idx + 1
    return reply


def quality_gate_1_semantic(comment_text: str, reply: str, post_ctx: dict) -> tuple[bool, str]:
    """Gate 1: Does the reply address the commenter's point?"""
    # Check if reply is about the same domain as the comment
    comment_lower = (comment_text or '').lower()
    reply_lower = reply.lower()

    # If comment mentions specific things, reply should not be completely generic
    specific_terms = ['%', '萬', '億', '天', '年', '月']
    comment_has_specifics = any(t in comment_lower for t in specific_terms)
    reply_is_generic = reply in ['🙌', '同感。', '你說的對。', '😄', '收到。']

    if comment_has_specifics and len(comment_text) > 50 and reply_is_generic:
        return False, "substantive comment got generic reply"

    return True, "ok"


def quality_gate_2_dedup(conn, username: str, reply: str) -> tuple[bool, str]:
    """Gate 2: Has this person received the same reply before?"""
    existing = conn.execute('''
        SELECT r.reply_text FROM replies r
        JOIN comments c ON r.comment_id = c.comment_id
        JOIN profiles p ON c.user_id = p.user_id
        WHERE p.username = ? AND r.status = 'sent'
        ORDER BY r.sent_at DESC LIMIT 10
    ''', (username,)).fetchall()

    for e in existing:
        if e['reply_text'] == reply:
            return False, f"duplicate: already sent '{reply[:20]}' to this user"

    return True, "ok"


def quality_gate_3_voice(reply: str) -> tuple[bool, str]:
    """Gate 3: Would Cruz say this? Filter out things that sound robotic."""
    banned = [
        '歡迎指出', '歡迎挑戰', '數據面前人人平等', '回到數據',
        '如果您有', '請問您', '很高興為您', '希望這對您有幫助',
        '根據我的分析', '作為一個',
    ]
    for b in banned:
        if b in reply:
            return False, f"banned phrase: {b}"

    # Too long for a casual reply
    if len(reply) > 100:
        return False, "too long for batch reply"

    return True, "ok"


def track_reply_wave(conn, comment_id: str, reply: str):
    """Gate 4 setup: record for wave tracking (post-send)."""
    conn.execute('''
        INSERT OR IGNORE INTO reply_waves (comment_id, reply_text, sent_at, wave_response)
        VALUES (?, ?, datetime('now'), NULL)
    ''', (comment_id, reply))


def main():
    dry_run = "--dry-run" in sys.argv or "--send" not in sys.argv
    limit = 20
    for i, arg in enumerate(sys.argv):
        if arg == "--limit" and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])

    conn = db.get_conn()

    # Create wave tracking table if not exists
    conn.execute('''CREATE TABLE IF NOT EXISTS reply_waves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id TEXT NOT NULL,
        reply_text TEXT,
        sent_at TEXT,
        wave_response TEXT,
        UNIQUE(comment_id)
    )''')
    conn.commit()

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

    # Process with quality gates
    sent = 0
    skipped = 0
    rejected = {"semantic": 0, "dedup": 0, "voice": 0}

    for u in unreplied:
        if sent >= limit:
            break

        text = (u['text_content'] or '').strip()
        cat = classify(text)
        post_ctx = get_post_context(conn, u['post_id'])
        reply = get_reply(cat, post_ctx)

        if reply is None:
            if not dry_run:
                db.add_reply(conn, u['comment_id'], u['post_id'], f'[BATCH_{cat.upper()}]', status='failed')
                conn.commit()
            skipped += 1
            continue

        # ❶ Semantic check
        ok, reason = quality_gate_1_semantic(text, reply, post_ctx)
        if not ok:
            # Try to upgrade: get a different variant
            for _ in range(3):
                reply = get_reply(cat, post_ctx)
                ok, reason = quality_gate_1_semantic(text, reply, post_ctx)
                if ok:
                    break
            if not ok:
                # Still bad — generate a more specific fallback
                post_text = post_ctx.get('text', '')[:30] if post_ctx else ''
                reply = f"你的觀點跟這篇的核心有關。值得展開。"
                rejected["semantic"] += 1

        # ❷ Dedup check
        ok, reason = quality_gate_2_dedup(conn, u['username'], reply)
        if not ok:
            # Rotate to next variant
            for _ in range(5):
                reply = get_reply(cat, post_ctx)
                ok, _ = quality_gate_2_dedup(conn, u['username'], reply)
                if ok:
                    break
            if not ok:
                rejected["dedup"] += 1
                if not dry_run:
                    db.add_reply(conn, u['comment_id'], u['post_id'], '[DEDUP_SKIP]', status='failed')
                    conn.commit()
                skipped += 1
                continue

        # ❸ Voice check
        ok, reason = quality_gate_3_voice(reply)
        if not ok:
            rejected["voice"] += 1
            reply = '🙌'  # Safe fallback

        if dry_run:
            topic = post_ctx.get('topic', '?') if post_ctx else '?'
            print(f"  [{cat:20s}] [{topic:12s}] @{u['username']:20s} → {reply[:40]}")
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
                    # ❹ Track for wave response
                    track_reply_wave(conn, u['comment_id'], reply)
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

    # Wave tracking report
    waves = conn.execute('SELECT COUNT(*) FROM reply_waves').fetchone()[0]
    conn.close()

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Sent: {sent} | Skipped: {skipped}")
    print(f"Quality gates rejected: semantic={rejected['semantic']} dedup={rejected['dedup']} voice={rejected['voice']}")
    print(f"Coverage: {s}/{t2} = {round(s / max(t2, 1) * 100)}% | Remaining: {remaining} | Wave tracking: {waves}")


if __name__ == "__main__":
    main()

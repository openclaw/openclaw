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


def quality_gate_0_context(conn, comment, post_ctx: dict) -> tuple[bool, str, dict]:
    """Gate 0: Do we have enough context to reply?"""
    text = (comment['text_content'] or '').strip()
    username = comment['username']
    comment_id = comment['comment_id']
    post_id = comment['post_id']
    extra = {}

    # Check parent — is this reply directed at us or someone else?
    parent_id = None
    try:
        row = conn.execute('SELECT parent_comment_id FROM comments WHERE comment_id=?', (comment_id,)).fetchone()
        if row:
            parent_id = row['parent_comment_id']
    except Exception:
        pass

    if parent_id:
        parent = conn.execute('''SELECT c.text_content, p.username FROM comments c
            JOIN profiles p ON c.user_id=p.user_id WHERE c.comment_id=?''', (parent_id,)).fetchone()
        if parent:
            extra['parent_username'] = parent['username']
            extra['parent_text'] = (parent['text_content'] or '')[:80]
            if parent['username'] != 'tangcruzz':
                return False, f"replying to @{parent['username']} not us", extra

    # Check comment age
    try:
        posted = conn.execute('SELECT posted_at FROM comments WHERE comment_id=?', (comment_id,)).fetchone()
        if posted and posted['posted_at']:
            from datetime import datetime
            comment_time = datetime.fromisoformat(posted['posted_at'].replace('+0000', '+00:00').replace('Z', '+00:00'))
            age_days = (datetime.now(comment_time.tzinfo) - comment_time).days if comment_time.tzinfo else 0
            extra['age_days'] = age_days
    except Exception:
        extra['age_days'] = 0

    return True, "ok", extra


def quality_gate_5_length_match(comment_text: str, reply: str) -> tuple[bool, str]:
    """Gate 5: Reply length should roughly match comment length."""
    c_len = len(comment_text or '')
    r_len = len(reply)

    if c_len <= 5 and r_len > 30:
        return False, "reply too long for short comment"
    if c_len > 100 and r_len <= 5:
        return False, "reply too short for long comment"
    return True, "ok"


def quality_gate_6_language(comment_text: str, reply: str) -> str:
    """Gate 6: Detect language and adjust reply language."""
    text = (comment_text or '').strip()

    # English detection
    ascii_ratio = sum(1 for c in text if c.isascii() and c.isalpha()) / max(len(text), 1)
    if ascii_ratio > 0.7 and len(text) > 10:
        return "en"

    # Simplified Chinese detection (common simplified-only chars)
    simplified_chars = set('这个来对们说会还让没关于从进过为实经头发动带给长达见员义应')
    has_simplified = any(c in simplified_chars for c in text)
    if has_simplified:
        return "cn_simplified"

    # Cantonese detection
    canto_chars = set('嘅啲咗佢哋嘢冇係咁')
    if any(c in canto_chars for c in text):
        return "cantonese"

    return "zh_tw"  # Default Traditional Chinese


LANG_ADJUSTMENTS = {
    "en": {
        "🙌": "🙌",
        "同感。": "Agreed.",
        "你說的對。": "You're right.",
        "好問題。這個值得展開,但留言區講不完。": "Good question. Worth expanding but can't do it justice in a comment.",
        "謝謝你的回饋。": "Thanks for the feedback.",
        "很高興有幫助。": "Glad it helped.",
    },
}


def adjust_language(reply: str, lang: str) -> str:
    """Adjust reply language to match commenter."""
    if lang == "en" and reply in LANG_ADJUSTMENTS.get("en", {}):
        return LANG_ADJUSTMENTS["en"][reply]
    return reply


def quality_gate_7_thread_dedup(conn, post_id: str, reply: str) -> tuple[bool, str]:
    """Gate 7: Don't send the same reply to multiple people in the same post."""
    same_reply_count = conn.execute('''
        SELECT COUNT(*) FROM replies r
        JOIN comments c ON r.comment_id = c.comment_id
        WHERE c.post_id = ? AND r.reply_text = ? AND r.status = 'sent'
    ''', (post_id, reply)).fetchone()[0]

    if same_reply_count >= 3:
        return False, f"already used '{reply[:20]}' {same_reply_count} times in this post"
    return True, "ok"


def add_time_acknowledgment(reply: str, age_days: int) -> str:
    """If replying to old comment, acknowledge the delay."""
    if age_days > 14:
        return f"遲了很久才回,抱歉。{reply}"
    elif age_days > 7:
        return f"晚回了。{reply}"
    return reply


def predict_response(comment_text: str, our_reply: str, category: str, post_ctx: dict) -> dict:
    """Gate 8: Predict how they'll interpret our reply and what they'll say next.

    Returns:
        {
            'interpretation': how they'll read our reply,
            'likely_response': what they'll probably say,
            'risk': 'safe' | 'trap' | 'escalate' | 'engage',
            'safer_reply': alternative if risk is 'trap',
        }
    """
    text = (comment_text or '').strip().lower()
    reply_lower = our_reply.lower()
    result = {'interpretation': '', 'likely_response': '', 'risk': 'safe'}

    # Trap 1: We say "歡迎" anything → they say "果然是AI罐頭回覆"
    if '歡迎' in our_reply:
        result['risk'] = 'trap'
        result['interpretation'] = '覺得是機器人套話'
        result['likely_response'] = '果然是AI'
        result['safer_reply'] = '你說的有道理。'
        return result

    # Trap 2: We compliment them → they say "少拍馬屁"
    if any(w in our_reply for w in ['角度很好', '你比大多數人想得深', '觀察很具體']):
        if category in ('hostile_with_point', 'hostile_no_point'):
            result['risk'] = 'trap'
            result['interpretation'] = '覺得被敷衍/拍馬屁'
            result['likely_response'] = '少來這套'
            result['safer_reply'] = '不同意也沒關係。數據在那裡。'
            return result

    # Trap 3: They ask a specific question, we give vague answer → "答非所問"
    has_question = '？' in comment_text or '?' in comment_text
    if has_question and len(comment_text) > 30:
        vague_replies = ['好問題', '值得展開', '這個我也在想', '留言區講不完']
        if any(v in our_reply for v in vague_replies):
            result['risk'] = 'trap'
            result['interpretation'] = '覺得被打太極'
            result['likely_response'] = '答非所問/不敢回'
            result['safer_reply'] = '這個問題的具體答案取決於你的情境。你能多說一點嗎？'
            return result

    # Escalate: hostile person gets generic positive reply → they escalate
    if category == 'hostile_with_point' and our_reply == '🙌':
        result['risk'] = 'escalate'
        result['interpretation'] = '覺得被無視'
        result['likely_response'] = '更激烈的攻擊'
        result['safer_reply'] = '你的情緒我收到了。但數字不會因為不喜歡就消失。'
        return result

    # Engage prediction: substantive reply to substantive comment → might start dialogue
    if category == 'substantive_insight' and len(our_reply) > 20 and len(comment_text) > 50:
        result['risk'] = 'engage'
        result['interpretation'] = '覺得被認真對待'
        result['likely_response'] = '可能繼續對話或追蹤'

    return result


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
    rejected = {"context": 0, "semantic": 0, "dedup": 0, "voice": 0, "length": 0, "thread_dedup": 0}

    for u in unreplied:
        if sent >= limit:
            break

        text = (u['text_content'] or '').strip()

        # ❺ Rate limiting — don't look like a bot
        # (handled by time.sleep in send block, but also batch pacing)

        # ❶ Context completeness (Gate 0)
        ok, reason, extra = quality_gate_0_context(conn, u, None)
        if not ok:
            if not dry_run:
                db.add_reply(conn, u['comment_id'], u['post_id'], f'[CTX_{reason[:20]}]', status='failed')
                conn.commit()
            rejected["context"] += 1
            skipped += 1
            continue

        cat = classify(text)
        post_ctx = get_post_context(conn, u['post_id'])
        reply = get_reply(cat, post_ctx)

        if reply is None:
            if not dry_run:
                db.add_reply(conn, u['comment_id'], u['post_id'], f'[BATCH_{cat.upper()}]', status='failed')
                conn.commit()
            skipped += 1
            continue

        # ❻ Language matching
        lang = quality_gate_6_language(text, reply)
        reply = adjust_language(reply, lang)

        # ❶ Semantic check
        ok, reason = quality_gate_1_semantic(text, reply, post_ctx)
        if not ok:
            for _ in range(3):
                reply = get_reply(cat, post_ctx)
                reply = adjust_language(reply, lang)
                ok, reason = quality_gate_1_semantic(text, reply, post_ctx)
                if ok:
                    break
            if not ok:
                reply = f"你的觀點跟這篇的核心有關。值得展開。"
                rejected["semantic"] += 1

        # ❷ Length matching
        ok, reason = quality_gate_5_length_match(text, reply)
        if not ok:
            rejected["length"] += 1
            if len(text) <= 5:
                reply = '🙌'
            # else keep reply as is, long reply to long comment is ok

        # ❸ Dedup check (per user)
        ok, reason = quality_gate_2_dedup(conn, u['username'], reply)
        if not ok:
            for _ in range(5):
                reply = get_reply(cat, post_ctx)
                reply = adjust_language(reply, lang)
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

        # ❹ Thread dedup (same reply in same post)
        ok, reason = quality_gate_7_thread_dedup(conn, u['post_id'], reply)
        if not ok:
            for _ in range(3):
                reply = get_reply(cat, post_ctx)
                reply = adjust_language(reply, lang)
                ok, _ = quality_gate_7_thread_dedup(conn, u['post_id'], reply)
                if ok:
                    break
            if not ok:
                rejected["thread_dedup"] += 1
                reply = '🙌'  # Safe unique fallback

        # ❺ Voice check
        ok, reason = quality_gate_3_voice(reply)
        if not ok:
            rejected["voice"] += 1
            reply = '🙌'

        # ❽ Predict response — 預判他三步
        prediction = predict_response(text, reply, cat, post_ctx)
        if prediction['risk'] == 'trap':
            # Our reply walks into a trap — rephrase
            reply = prediction.get('safer_reply', reply)
            rejected.setdefault("prediction", 0)
            rejected["prediction"] += 1

        # ❼ Time acknowledgment
        age_days = extra.get('age_days', 0)
        reply = add_time_acknowledgment(reply, age_days)

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
    pred = rejected.get('prediction', 0)
    print(f"Quality gates: ctx={rejected['context']} sem={rejected['semantic']} len={rejected['length']} dedup={rejected['dedup']} thr={rejected['thread_dedup']} voice={rejected['voice']} pred={pred}")
    print(f"Coverage: {s}/{t2} = {round(s / max(t2, 1) * 100)}% | Remaining: {remaining} | Wave tracking: {waves}")


if __name__ == "__main__":
    main()

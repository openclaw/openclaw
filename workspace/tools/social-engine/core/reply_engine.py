"""Reply generation engine — channel-agnostic."""
import subprocess
import sys
import os

BANNED_PHRASES = [
    '歡迎指出', '指出來', '你覺得哪裡不同',
    '數據面前人人平等', '歡迎挑戰', '回到數據',
]

VERIFIED_DATA = {
    'lng_days': 'LNG 安全存量 8-11 天（經濟部）',
    'patriot_3days': '愛國者 3 天消耗 800+ 枚（澤連斯基聲明/Kyiv Independent）',
    'swift_usd': 'SWIFT 美元佔比 2025 年破 50%（SWIFT）',
    'us_debt_interest': '國債利息 $9,700 億超過國防預算 $8,930 億（CBO）',
    'us_debt_total': '國債 $38 兆（Treasury）',
    'iran_strike': '2026/02/28 美以聯合空襲伊朗（Al Jazeera/CBS）',
    'patriot_annual': '愛國者年產 620 枚歷史新高（Lockheed Martin）',
    'energy_import': '台灣電力 97% 進口燃料依賴（經濟部）',
    'dni_short_of_conflict': 'DNI 2026: Beijing seeks unification short of conflict',
}


class ReplyEngine:
    def __init__(self, claude_bin=None):
        self.claude_bin = claude_bin or os.path.expanduser('~/.local/bin/claude')

    def generate(self, context, model='haiku'):
        """Generate a reply using Claude CLI."""
        prompt = self._build_prompt(context)
        return self._call_claude(prompt, model)

    def _build_prompt(self, ctx):
        profile = ctx.get('profile', {})
        tier = profile.get('tier', 'C')
        stance = profile.get('stance', '?')
        depth = profile.get('depth', 0)
        topics = profile.get('topics', [])
        channel = ctx.get('channel', 'unknown')

        history_lines = []
        for h in ctx.get('history', [])[:5]:
            prefix = '他' if h['direction'] == 'inbound' else '我'
            history_lines.append(f"  [{h['channel']}] {prefix}: {h['text']}")

        return f"""你是 tangcruzz，在社群平台上做地緣政治分析和社群經營。回覆以下留言。

平台: {channel}
留言者: {ctx.get('display_name', '?')} [{tier}/{stance}] (跨平台互動{depth}次)
興趣: {', '.join(topics) if topics else '未知'}
留言: {ctx.get('message_text', '')}

跨平台歷史:
{chr(10).join(history_lines) if history_lines else '  (首次互動)'}

規則:
- 字數對等
- 只用 verified 數據
- 禁止: {', '.join(BANNED_PHRASES[:3])} 等模板句
- 對方生氣 → 先承認再回應
- tier=A → 投入更多精力，讀對方分享的連結
- 如果對方分享了連結/文件但你看不到內容，誠實說
- 繁體中文，不加 emoji（除非對方用了）
- {channel} 平台的自然語氣

只輸出回覆文字。"""

    def _call_claude(self, prompt, model='haiku'):
        env = os.environ.copy()
        env.pop('CLAUDECODE', None)
        try:
            result = subprocess.run(
                [self.claude_bin, '-p', prompt, '--model', model, '--output-format', 'text'],
                capture_output=True, text=True, timeout=120, env=env,
            )
            if result.returncode != 0:
                return None
            reply = result.stdout.strip()
            # Post-check: ban phrase filter
            for phrase in BANNED_PHRASES:
                if phrase in reply:
                    return None  # Reject and retry or skip
            return reply
        except Exception:
            return None

    def validate(self, reply_text):
        """Check reply quality before sending."""
        if not reply_text or len(reply_text) < 2:
            return False, 'too_short'
        for phrase in BANNED_PHRASES:
            if phrase in reply_text:
                return False, f'banned_phrase:{phrase}'
        return True, 'ok'

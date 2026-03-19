"""Telegram adapter — reads from conversations.db + sends via wuji tg CLI."""
import sqlite3
import subprocess
import sys
from pathlib import Path

from .base import ChannelAdapter

SENTINEL_DATA = Path(__file__).parent.parent.parent.parent.parent / "sentinel" / "data"
CONVERSATIONS_DB = SENTINEL_DATA / "conversations.db"
WUJI = Path(__file__).parent.parent.parent.parent / "scripts" / "wuji"
CLAWD_ROOT = Path(__file__).parent.parent.parent.parent.parent


class TelegramAdapter(ChannelAdapter):
    channel_name = 'telegram'

    def __init__(self, bridge='dufu', watch_groups=None):
        self.bridge = bridge
        # Groups to monitor for cross-platform activity
        self.watch_groups = watch_groups or []

    def scan(self, since_minutes=30):
        """Read recent messages from conversations.db (populated by Sentinel conversation_sync)."""
        if not CONVERSATIONS_DB.exists():
            return []

        conn = sqlite3.connect(str(CONVERSATIONS_DB), timeout=10)
        conn.row_factory = sqlite3.Row

        # Build group filter
        if self.watch_groups:
            placeholders = ','.join('?' * len(self.watch_groups))
            group_clause = f'AND chat_id IN ({placeholders})'
            params = self.watch_groups + [since_minutes]
        else:
            group_clause = ''
            params = [since_minutes]

        rows = conn.execute(f'''
            SELECT chat_id, chat_name, message_id, sender_id, sender_name,
                   is_bot, text, has_media, timestamp, bridge
            FROM messages
            WHERE is_bot = 0
              AND text IS NOT NULL AND length(text) > 3
              {group_clause}
              AND timestamp > datetime('now', '-' || ? || ' minutes')
            ORDER BY timestamp DESC
            LIMIT 50
        ''', params).fetchall()

        conn.close()

        return [{
            'handle': str(r['sender_id']),
            'display_name': r['sender_name'],
            'text': r['text'] or '',
            'media_type': 'IMAGE' if r['has_media'] else 'TEXT',
            'timestamp': r['timestamp'],
            'raw_id': str(r['message_id']),
            'group_id': str(r['chat_id']),
            'group_name': r['chat_name'],
            'bridge': r['bridge'],
        } for r in rows]

    def send(self, handle, text):
        """Send message via wuji tg CLI."""
        try:
            result = subprocess.run(
                [sys.executable, str(WUJI), 'tg', '--bridge', self.bridge,
                 'send', str(handle), text],
                capture_output=True, text=True, timeout=30,
                cwd=str(CLAWD_ROOT)
            )
            return result.returncode == 0
        except Exception:
            return False

    def get_profile(self, handle):
        """Get profile from conversation history."""
        if not CONVERSATIONS_DB.exists():
            return {'handle': handle, 'channel': 'telegram'}

        conn = sqlite3.connect(str(CONVERSATIONS_DB), timeout=10)
        conn.row_factory = sqlite3.Row

        row = conn.execute('''
            SELECT sender_name, COUNT(*) as msg_count,
                   GROUP_CONCAT(DISTINCT chat_name) as groups
            FROM messages
            WHERE sender_id = ? AND is_bot = 0
            GROUP BY sender_id
        ''', (handle,)).fetchone()

        conn.close()

        if not row:
            return {'handle': handle, 'channel': 'telegram'}

        return {
            'handle': handle,
            'channel': 'telegram',
            'display_name': row['sender_name'],
            'message_count': row['msg_count'],
            'groups': row['groups'],
        }

    def get_group_members(self, group_id):
        """Get unique members of a group from message history."""
        if not CONVERSATIONS_DB.exists():
            return []

        conn = sqlite3.connect(str(CONVERSATIONS_DB), timeout=10)
        conn.row_factory = sqlite3.Row

        rows = conn.execute('''
            SELECT DISTINCT sender_id, sender_name, COUNT(*) as msg_count
            FROM messages
            WHERE chat_id = ? AND is_bot = 0
            GROUP BY sender_id
            ORDER BY msg_count DESC
        ''', (group_id,)).fetchall()

        conn.close()

        return [{'id': str(r['sender_id']), 'name': r['sender_name'], 'messages': r['msg_count']} for r in rows]

    def supports_feed(self):
        return True

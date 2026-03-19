"""Threads adapter — wraps existing threads_reply.py."""
import sys
from pathlib import Path

THREADS_DIR = Path(__file__).parent.parent.parent / "threads-reply"
sys.path.insert(0, str(THREADS_DIR))

from .base import ChannelAdapter


class ThreadsAdapter(ChannelAdapter):
    channel_name = 'threads'

    def __init__(self):
        import threads_reply as tr
        import threads_db as tdb
        self.tr = tr
        self.tdb = tdb
        self._cwd = THREADS_DIR

    def scan(self):
        """Run Threads API scan, return new comments."""
        import os
        old_cwd = os.getcwd()
        os.chdir(self._cwd)
        try:
            self.tr.cmd_scan()
            conn = self.tdb.get_conn()
            # Get unreplied comments
            rows = conn.execute('''
                SELECT c.comment_id, c.text_content, p.username, c.posted_at,
                       c.parent_comment_id, c.post_id
                FROM comments c
                LEFT JOIN replies r ON c.comment_id = r.comment_id
                JOIN profiles p ON c.user_id = p.user_id
                WHERE r.reply_id IS NULL AND p.username != ?
                ORDER BY c.posted_at DESC LIMIT 20
            ''', (self.tr.MY_USERNAME,)).fetchall()
            conn.close()
            return [{
                'handle': r['username'],
                'text': r['text_content'] or '',
                'media_type': 'TEXT',
                'timestamp': r['posted_at'],
                'raw_id': r['comment_id'],
                'post_id': r['post_id'],
                'parent_id': r['parent_comment_id'],
            } for r in rows]
        finally:
            os.chdir(old_cwd)

    def send(self, handle, text, reply_to_id=None):
        """Send a reply via Threads API."""
        import time, os
        old_cwd = os.getcwd()
        os.chdir(self._cwd)
        try:
            if not reply_to_id:
                # Find the latest unreplied comment from this handle
                conn = self.tdb.get_conn()
                row = conn.execute('''
                    SELECT c.comment_id FROM comments c
                    JOIN profiles p ON c.user_id = p.user_id
                    LEFT JOIN replies r ON c.comment_id = r.comment_id
                    WHERE p.username = ? AND r.reply_id IS NULL
                    ORDER BY c.posted_at DESC LIMIT 1
                ''', (handle,)).fetchone()
                conn.close()
                if not row:
                    return False
                reply_to_id = row['comment_id']

            res = self.tr.api_post(f'{self.tr.USER_ID}/threads', {
                'media_type': 'TEXT', 'text': text, 'reply_to_id': reply_to_id
            })
            if not res or 'id' not in res:
                return False

            time.sleep(2)
            pub = self.tr.api_post(f'{self.tr.USER_ID}/threads_publish', {
                'creation_id': res['id']
            })
            return bool(pub and 'id' in pub)
        finally:
            os.chdir(old_cwd)

    def get_profile(self, handle):
        """Get profile from threads.db."""
        conn = self.tdb.get_conn()
        row = conn.execute(
            'SELECT * FROM profiles WHERE username=?', (handle,)
        ).fetchone()
        conn.close()
        if not row:
            return {}
        return {
            'handle': row['username'],
            'tier': row['value_tier'],
            'stance': row['stance'],
            'followers': row['follower_count'],
            'bio': row['bio'],
        }

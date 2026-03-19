"""Personalized feed engine — push relevant updates to subscribers."""
import json
from datetime import datetime


class FeedEngine:
    def __init__(self, conn, identity, adapters):
        self.conn = conn
        self.identity = identity
        self.adapters = adapters  # dict of channel -> adapter instance

    def push_update(self, topic, content, source_url=None):
        """Push a topic update to all subscribers interested in that topic.

        Returns list of (canonical_id, channel, success) tuples.
        """
        subscribers = self.identity.get_by_topic(topic, min_depth=3)
        results = []

        for sub in subscribers:
            cid = sub['canonical_id']
            handles = self.identity.get_handles(cid)

            # Pick best channel (prefer the one they're most active on)
            best_channel = self._pick_channel(cid, handles)
            if not best_channel:
                continue

            channel, handle = best_channel

            # Personalize the message
            personalized = self._personalize(sub, topic, content, source_url)

            # Send via adapter
            adapter = self.adapters.get(channel)
            if not adapter:
                continue

            success = adapter.send(handle, personalized)

            # Log
            self.conn.execute(
                'INSERT INTO feed_log (canonical_id, channel, content, topic) VALUES (?,?,?,?)',
                (cid, channel, personalized[:200], topic)
            )
            self.conn.commit()

            results.append((cid, channel, success))

        return results

    def _pick_channel(self, canonical_id, handles):
        """Pick the best channel to reach this contact."""
        # Priority: the channel where they last interacted
        last = self.conn.execute('''
            SELECT channel FROM interactions
            WHERE canonical_id = ? AND direction = 'inbound'
            ORDER BY created_at DESC LIMIT 1
        ''', (canonical_id,)).fetchone()

        if last:
            for h in handles:
                if h['channel'] == last['channel']:
                    return (h['channel'], h['handle'])

        # Fallback: first available adapter
        for h in handles:
            if h['channel'] in self.adapters:
                return (h['channel'], h['handle'])

        return None

    def _personalize(self, contact, topic, content, source_url=None):
        """Create personalized message based on contact's context."""
        name = contact['display_name'] or ''
        topics = json.loads(contact['topics']) if contact['topics'] else []
        depth = contact['engagement_depth'] or 0

        # For deep engagers, reference their history
        if depth >= 10:
            msg = f"{content}"
            if source_url:
                msg += f"\n\n{source_url}"
        else:
            msg = content
            if source_url:
                msg += f"\n\n{source_url}"

        return msg

    def get_feed_history(self, canonical_id, limit=10):
        """What have we already pushed to this contact?"""
        return self.conn.execute(
            'SELECT * FROM feed_log WHERE canonical_id=? ORDER BY sent_at DESC LIMIT ?',
            (canonical_id, limit)
        ).fetchall()

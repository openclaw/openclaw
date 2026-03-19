"""Cross-platform identity resolution and CRM."""
import json
from datetime import datetime


class Identity:
    def __init__(self, conn):
        self.conn = conn

    def resolve(self, channel, handle):
        """Given a channel+handle, return canonical_id or None."""
        row = self.conn.execute(
            'SELECT canonical_id FROM contact_handles WHERE channel=? AND handle=?',
            (channel, handle)
        ).fetchone()
        return row['canonical_id'] if row else None

    def get_contact(self, canonical_id):
        """Get full contact record."""
        return self.conn.execute(
            'SELECT * FROM contacts WHERE canonical_id=?', (canonical_id,)
        ).fetchone()

    def get_or_create(self, channel, handle, display_name=None):
        """Resolve or auto-create a contact from a channel handle."""
        cid = self.resolve(channel, handle)
        if cid:
            return cid

        # Auto-create: canonical_id = channel:handle
        cid = f"{channel}:{handle}"
        self.conn.execute(
            'INSERT OR IGNORE INTO contacts (canonical_id, display_name) VALUES (?,?)',
            (cid, display_name or handle)
        )
        self.conn.execute(
            'INSERT OR IGNORE INTO contact_handles (canonical_id, channel, handle) VALUES (?,?,?)',
            (cid, channel, handle)
        )
        self.conn.commit()
        return cid

    def link(self, canonical_id, channel, handle, metadata=None):
        """Link a new channel handle to an existing contact."""
        self.conn.execute(
            'INSERT OR REPLACE INTO contact_handles (canonical_id, channel, handle, metadata) VALUES (?,?,?,?)',
            (canonical_id, channel, handle, metadata)
        )
        self.conn.commit()

    def update_stance(self, canonical_id, new_stance=None, new_tier=None, reason=None):
        """Update stance/tier with history tracking."""
        current = self.get_contact(canonical_id)
        if not current:
            return

        old_stance = current['stance']
        old_tier = current['tier']

        updates = []
        params = []
        if new_stance and new_stance != old_stance:
            updates.append('stance=?')
            params.append(new_stance)
        if new_tier and new_tier != old_tier:
            updates.append('tier=?')
            params.append(new_tier)

        if not updates:
            return

        params.append(canonical_id)
        self.conn.execute(f'UPDATE contacts SET {",".join(updates)} WHERE canonical_id=?', params)

        self.conn.execute(
            'INSERT INTO stance_history (canonical_id, old_stance, new_stance, old_tier, new_tier, reason) VALUES (?,?,?,?,?,?)',
            (canonical_id, old_stance, new_stance or old_stance, old_tier, new_tier or old_tier, reason)
        )
        self.conn.commit()

    def update_topics(self, canonical_id, topics):
        """Set topic interests."""
        self.conn.execute(
            'UPDATE contacts SET topics=? WHERE canonical_id=?',
            (json.dumps(topics, ensure_ascii=False), canonical_id)
        )
        self.conn.commit()

    def record_interaction(self, canonical_id):
        """Bump engagement depth and last_interaction."""
        self.conn.execute(
            'UPDATE contacts SET engagement_depth = engagement_depth + 1, last_interaction = ? WHERE canonical_id=?',
            (datetime.now().isoformat(), canonical_id)
        )
        self.conn.commit()

    def get_handles(self, canonical_id):
        """Get all channel handles for a contact."""
        return self.conn.execute(
            'SELECT channel, handle, metadata FROM contact_handles WHERE canonical_id=?',
            (canonical_id,)
        ).fetchall()

    def get_subscribers(self, min_depth=5):
        """Get all contacts with engagement >= min_depth."""
        return self.conn.execute(
            'SELECT * FROM contacts WHERE engagement_depth >= ? ORDER BY engagement_depth DESC',
            (min_depth,)
        ).fetchall()

    def get_by_topic(self, topic, min_depth=3):
        """Get contacts interested in a specific topic."""
        return self.conn.execute(
            'SELECT * FROM contacts WHERE topics LIKE ? AND engagement_depth >= ? ORDER BY engagement_depth DESC',
            (f'%{topic}%', min_depth)
        ).fetchall()

    def get_recruitment_candidates(self):
        """Get contacts with recruitment signals."""
        return self.conn.execute(
            'SELECT * FROM contacts WHERE recruitment_signal IS NOT NULL ORDER BY engagement_depth DESC'
        ).fetchall()

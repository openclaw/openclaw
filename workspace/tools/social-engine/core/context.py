"""Context building for reply generation."""
import json


class ContextBuilder:
    def __init__(self, conn, identity):
        self.conn = conn
        self.identity = identity

    def build(self, canonical_id, channel, message_text, **kwargs):
        """Build a complete context block for reply generation."""
        contact = self.identity.get_contact(canonical_id)
        if not contact:
            return None

        # Cross-channel history
        history = self.conn.execute('''
            SELECT channel, direction, message_text, created_at
            FROM interactions
            WHERE canonical_id = ?
            ORDER BY created_at DESC LIMIT 10
        ''', (canonical_id,)).fetchall()

        # All handles
        handles = self.identity.get_handles(canonical_id)

        block = {
            'canonical_id': canonical_id,
            'display_name': contact['display_name'],
            'channel': channel,
            'message_text': message_text,
            'profile': {
                'tier': contact['tier'] or 'C',
                'stance': contact['stance'] or 'unknown',
                'topics': json.loads(contact['topics']) if contact['topics'] else [],
                'depth': contact['engagement_depth'] or 0,
                'recruit': contact['recruitment_signal'],
            },
            'handles': {h['channel']: h['handle'] for h in handles},
            'history': [{
                'channel': h['channel'],
                'direction': h['direction'],
                'text': (h['message_text'] or '')[:80],
                'at': h['created_at'],
            } for h in history],
            'is_vip': (contact['tier'] or 'C') in ('S', 'A'),
            'needs_approval': (contact['tier'] or 'C') in ('S', 'A') and (contact['stance'] or '') == 'pro',
        }

        # Add channel-specific context from kwargs
        block.update(kwargs)

        return block

    def should_reply(self, context):
        """Determine if we should reply to this message."""
        if not context:
            return False
        if not context.get('message_text', '').strip():
            return False
        if context.get('directed_at_us') is False:
            return False
        return True

    def reply_depth(self, context):
        """Determine how much effort to put into the reply."""
        tier = context.get('profile', {}).get('tier', 'C')
        depth = context.get('profile', {}).get('depth', 0)

        if tier in ('S', 'A'):
            return 'deep'  # Full engagement, read links, match effort
        elif tier == 'B' or depth >= 5:
            return 'medium'  # Substantive but shorter
        else:
            return 'light'  # Brief, address the point

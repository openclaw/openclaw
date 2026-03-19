"""Gmail adapter — uses MCP Gmail tools.

NOTE: This adapter is designed to be called from within a Claude Code session
that has MCP Gmail tools available. It stores scan results for offline processing
but send/reply operations require the MCP tools to be live.
"""
from pathlib import Path
from .base import ChannelAdapter

# Gmail adapter works differently: it can't call MCP tools directly from Python.
# Instead, it reads/writes a gmail-queue.json that the Claude Code session processes.
QUEUE_PATH = Path(__file__).parent.parent / "gmail-queue.json"


class GmailAdapter(ChannelAdapter):
    channel_name = 'gmail'

    def __init__(self, email='cruz@thinker.cafe'):
        self.email = email

    def scan(self):
        """Gmail scan must be done from Claude Code session using MCP tools.
        This returns cached results from gmail-queue.json if available."""
        import json
        if QUEUE_PATH.exists():
            try:
                data = json.loads(QUEUE_PATH.read_text())
                return data.get('inbox', [])
            except (json.JSONDecodeError, KeyError):
                pass
        return []

    def send(self, handle, text):
        """Gmail send must be done from Claude Code session (MCP tool).
        Queues the draft for sending."""
        import json
        data = {'drafts': []}
        if QUEUE_PATH.exists():
            try:
                data = json.loads(QUEUE_PATH.read_text())
            except (json.JSONDecodeError, KeyError):
                pass

        if 'drafts' not in data:
            data['drafts'] = []

        data['drafts'].append({
            'to': handle,
            'body': text,
            'status': 'pending',
        })

        QUEUE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return True  # Queued, not sent

    def get_profile(self, handle):
        return {'handle': handle, 'channel': 'gmail', 'email': handle}

    def supports_feed(self):
        return True  # Can send emails as feed

"""Telegram adapter — wraps wuji tg CLI."""
import subprocess
import sys
from pathlib import Path

from .base import ChannelAdapter

WUJI = Path(__file__).parent.parent.parent.parent / "scripts" / "wuji"


class TelegramAdapter(ChannelAdapter):
    channel_name = 'telegram'

    def __init__(self, bridge='dufu'):
        self.bridge = bridge

    def scan(self):
        """Not implemented yet — TG messages come via bridge webhook."""
        return []

    def send(self, handle, text):
        """Send message via wuji tg CLI."""
        try:
            result = subprocess.run(
                [sys.executable, str(WUJI), 'tg', '--bridge', self.bridge,
                 'send', str(handle), text],
                capture_output=True, text=True, timeout=30,
                cwd=str(WUJI.parent.parent)
            )
            return result.returncode == 0
        except Exception:
            return False

    def get_profile(self, handle):
        """Basic profile from conversation DB."""
        return {'handle': handle, 'channel': 'telegram'}

    def supports_feed(self):
        return True

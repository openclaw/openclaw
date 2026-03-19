"""Base adapter interface for all channels."""
from abc import ABC, abstractmethod


class ChannelAdapter(ABC):
    """Every channel implements this interface."""

    @property
    @abstractmethod
    def channel_name(self) -> str:
        """e.g. 'threads', 'telegram', 'line'"""

    @abstractmethod
    def scan(self) -> list[dict]:
        """Pull new messages/comments. Returns list of raw messages:
        [{'handle': str, 'text': str, 'media_type': str, 'timestamp': str, 'raw_id': str, ...}]
        """

    @abstractmethod
    def send(self, handle: str, text: str) -> bool:
        """Send a reply/message to a specific handle. Returns success."""

    @abstractmethod
    def get_profile(self, handle: str) -> dict:
        """Get user profile info from this channel."""

    def supports_feed(self) -> bool:
        """Can this adapter push unsolicited messages?"""
        return True

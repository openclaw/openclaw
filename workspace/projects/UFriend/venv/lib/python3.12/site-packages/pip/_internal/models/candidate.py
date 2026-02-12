from pip._vendor.packaging.version import parse as parse_version

from pip._internal.models.link import Link
from pip._internal.utils.models import KeyBasedCompareMixin


class InstallationCandidate(KeyBasedCompareMixin):
    """Represents a potential "candidate" for installation."""

    __slots__ = ["name", "version", "link"]

    def __init__(self, name: str, version: str, link: Link) -> None:
        self.name = name
        self.version = parse_version(version)
        self.link = link

        super().__init__(
            key=(self.name, self.version, self.link),
            defining_class=InstallationCandidate,
        )

    def __repr__(self) -> str:
        return "<InstallationCandidate({!r}, {!r}, {!r})>".format(
            self.name,
            self.version,
            self.link,
        )

    def __str__(self) -> str:
        return f"{self.name!r} candidate (version {self.version} at {self.link})"

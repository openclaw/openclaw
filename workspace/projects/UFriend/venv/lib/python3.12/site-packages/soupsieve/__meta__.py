"""Meta related things."""
from __future__ import annotations
from collections import namedtuple
import re

RE_VER = re.compile(
    r'''(?x)
    (?P<major>\d+)(?:\.(?P<minor>\d+))?(?:\.(?P<micro>\d+))?
    (?:(?P<type>a|b|rc)(?P<pre>\d+))?
    (?:\.post(?P<post>\d+))?
    (?:\.dev(?P<dev>\d+))?
    '''
)

REL_MAP = {
    ".dev": "",
    ".dev-alpha": "a",
    ".dev-beta": "b",
    ".dev-candidate": "rc",
    "alpha": "a",
    "beta": "b",
    "candidate": "rc",
    "final": ""
}

DEV_STATUS = {
    ".dev": "2 - Pre-Alpha",
    ".dev-alpha": "2 - Pre-Alpha",
    ".dev-beta": "2 - Pre-Alpha",
    ".dev-candidate": "2 - Pre-Alpha",
    "alpha": "3 - Alpha",
    "beta": "4 - Beta",
    "candidate": "4 - Beta",
    "final": "5 - Production/Stable"
}

PRE_REL_MAP = {"a": 'alpha', "b": 'beta', "rc": 'candidate'}


class Version(namedtuple("Version", ["major", "minor", "micro", "release", "pre", "post", "dev"])):
    """
    Get the version (PEP 440).

    A biased approach to the PEP 440 semantic version.

    Provides a tuple structure which is sorted for comparisons `v1 > v2` etc.
      (major, minor, micro, release type, pre-release build, post-release build, development release build)
    Release types are named in is such a way they are comparable with ease.
    Accessors to check if a development, pre-release, or post-release build. Also provides accessor to get
    development status for setup files.

    How it works (currently):

    - You must specify a release type as either `final`, `alpha`, `beta`, or `candidate`.
    - To define a development release, you can use either `.dev`, `.dev-alpha`, `.dev-beta`, or `.dev-candidate`.
      The dot is used to ensure all development specifiers are sorted before `alpha`.
      You can specify a `dev` number for development builds, but do not have to as implicit development releases
      are allowed.
    - You must specify a `pre` value greater than zero if using a prerelease as this project (not PEP 440) does not
      allow implicit prereleases.
    - You can optionally set `post` to a value greater than zero to make the build a post release. While post releases
      are technically allowed in prereleases, it is strongly discouraged, so we are rejecting them. It should be
      noted that we do not allow `post0` even though PEP 440 does not restrict this. This project specifically
      does not allow implicit post releases.
    - It should be noted that we do not support epochs `1!` or local versions `+some-custom.version-1`.

    Acceptable version releases:

    ```
    Version(1, 0, 0, "final")                    1.0
    Version(1, 2, 0, "final")                    1.2
    Version(1, 2, 3, "final")                    1.2.3
    Version(1, 2, 0, ".dev-alpha", pre=4)        1.2a4
    Version(1, 2, 0, ".dev-beta", pre=4)         1.2b4
    Version(1, 2, 0, ".dev-candidate", pre=4)    1.2rc4
    Version(1, 2, 0, "final", post=1)            1.2.post1
    Version(1, 2, 3, ".dev")                     1.2.3.dev0
    Version(1, 2, 3, ".dev", dev=1)              1.2.3.dev1
    ```

    """

    def __new__(
        cls,
        major: int, minor: int, micro: int, release: str = "final",
        pre: int = 0, post: int = 0, dev: int = 0
    ) -> Version:
        """Validate version info."""

        # Ensure all parts are positive integers.
        for value in (major, minor, micro, pre, post):
            if not (isinstance(value, int) and value >= 0):
                raise ValueError("All version parts except 'release' should be integers.")

        if release not in REL_MAP:
            raise ValueError(f"'{release}' is not a valid release type.")

        # Ensure valid pre-release (we do not allow implicit pre-releases).
        if ".dev-candidate" < release < "final":
            if pre == 0:
                raise ValueError("Implicit pre-releases not allowed.")
            elif dev:
                raise ValueError("Version is not a development release.")
            elif post:
                raise ValueError("Post-releases are not allowed with pre-releases.")

        # Ensure valid development or development/pre release
        elif release < "alpha":
            if release > ".dev" and pre == 0:
                raise ValueError("Implicit pre-release not allowed.")
            elif post:
                raise ValueError("Post-releases are not allowed with pre-releases.")

        # Ensure a valid normal release
        else:
            if pre:
                raise ValueError("Version is not a pre-release.")
            elif dev:
                raise ValueError("Version is not a development release.")

        return super().__new__(cls, major, minor, micro, release, pre, post, dev)

    def _is_pre(self) -> bool:
        """Is prerelease."""

        return bool(self.pre > 0)

    def _is_dev(self) -> bool:
        """Is development."""

        return bool(self.release < "alpha")

    def _is_post(self) -> bool:
        """Is post."""

        return bool(self.post > 0)

    def _get_dev_status(self) -> str:  # pragma: no cover
        """Get development status string."""

        return DEV_STATUS[self.release]

    def _get_canonical(self) -> str:
        """Get the canonical output string."""

        # Assemble major, minor, micro version and append `pre`, `post`, or `dev` if needed..
        if self.micro == 0:
            ver = f"{self.major}.{self.minor}"
        else:
            ver = f"{self.major}.{self.minor}.{self.micro}"
        if self._is_pre():
            ver += f'{REL_MAP[self.release]}{self.pre}'
        if self._is_post():
            ver += f".post{self.post}"
        if self._is_dev():
            ver += f".dev{self.dev}"

        return ver


def parse_version(ver: str) -> Version:
    """Parse version into a comparable Version tuple."""

    m = RE_VER.match(ver)

    if m is None:
        raise ValueError(f"'{ver}' is not a valid version")

    # Handle major, minor, micro
    major = int(m.group('major'))
    minor = int(m.group('minor')) if m.group('minor') else 0
    micro = int(m.group('micro')) if m.group('micro') else 0

    # Handle pre releases
    if m.group('type'):
        release = PRE_REL_MAP[m.group('type')]
        pre = int(m.group('pre'))
    else:
        release = "final"
        pre = 0

    # Handle development releases
    dev = m.group('dev') if m.group('dev') else 0
    if m.group('dev'):
        dev = int(m.group('dev'))
        release = '.dev-' + release if pre else '.dev'
    else:
        dev = 0

    # Handle post
    post = int(m.group('post')) if m.group('post') else 0

    return Version(major, minor, micro, release, pre, post, dev)


__version_info__ = Version(2, 8, 3, "final")
__version__ = __version_info__._get_canonical()

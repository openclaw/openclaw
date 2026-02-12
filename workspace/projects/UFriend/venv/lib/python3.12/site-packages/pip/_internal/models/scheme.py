"""
For types associated with installation schemes.

For a general overview of available schemes and their context, see
https://docs.python.org/3/install/index.html#alternate-installation.
"""


SCHEME_KEYS = ["platlib", "purelib", "headers", "scripts", "data"]


class Scheme:
    """A Scheme holds paths which are used as the base directories for
    artifacts associated with a Python package.
    """

    __slots__ = SCHEME_KEYS

    def __init__(
        self,
        platlib: str,
        purelib: str,
        headers: str,
        scripts: str,
        data: str,
    ) -> None:
        self.platlib = platlib
        self.purelib = purelib
        self.headers = headers
        self.scripts = scripts
        self.data = data

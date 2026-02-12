from __future__ import annotations

from importlib.metadata import version

__all__ = [
    "inject_into_urllib3",
    "extract_from_urllib3",
]

import typing

orig_HTTPSConnection: typing.Any = None


def inject_into_urllib3() -> None:
    # First check if h2 version is valid
    h2_version = version("h2")
    if not h2_version.startswith("4."):
        raise ImportError(
            "urllib3 v2 supports h2 version 4.x.x, currently "
            f"the 'h2' module is compiled with {h2_version!r}. "
            "See: https://github.com/urllib3/urllib3/issues/3290"
        )

    # Import here to avoid circular dependencies.
    from .. import connection as urllib3_connection
    from .. import util as urllib3_util
    from ..connectionpool import HTTPSConnectionPool
    from ..util import ssl_ as urllib3_util_ssl
    from .connection import HTTP2Connection

    global orig_HTTPSConnection
    orig_HTTPSConnection = urllib3_connection.HTTPSConnection

    HTTPSConnectionPool.ConnectionCls = HTTP2Connection
    urllib3_connection.HTTPSConnection = HTTP2Connection  # type: ignore[misc]

    # TODO: Offer 'http/1.1' as well, but for testing purposes this is handy.
    urllib3_util.ALPN_PROTOCOLS = ["h2"]
    urllib3_util_ssl.ALPN_PROTOCOLS = ["h2"]


def extract_from_urllib3() -> None:
    from .. import connection as urllib3_connection
    from .. import util as urllib3_util
    from ..connectionpool import HTTPSConnectionPool
    from ..util import ssl_ as urllib3_util_ssl

    HTTPSConnectionPool.ConnectionCls = orig_HTTPSConnection
    urllib3_connection.HTTPSConnection = orig_HTTPSConnection  # type: ignore[misc]

    urllib3_util.ALPN_PROTOCOLS = ["http/1.1"]
    urllib3_util_ssl.ALPN_PROTOCOLS = ["http/1.1"]

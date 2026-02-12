# For backwards compatibility, provide imports that used to be here.
from __future__ import annotations

from .connection import is_connection_dropped
from .request import SKIP_HEADER, SKIPPABLE_HEADERS, make_headers
from .response import is_fp_closed
from .retry import Retry
from .ssl_ import (
    ALPN_PROTOCOLS,
    IS_PYOPENSSL,
    SSLContext,
    assert_fingerprint,
    create_urllib3_context,
    resolve_cert_reqs,
    resolve_ssl_version,
    ssl_wrap_socket,
)
from .timeout import Timeout
from .url import Url, parse_url
from .wait import wait_for_read, wait_for_write

__all__ = (
    "IS_PYOPENSSL",
    "SSLContext",
    "ALPN_PROTOCOLS",
    "Retry",
    "Timeout",
    "Url",
    "assert_fingerprint",
    "create_urllib3_context",
    "is_connection_dropped",
    "is_fp_closed",
    "parse_url",
    "make_headers",
    "resolve_cert_reqs",
    "resolve_ssl_version",
    "ssl_wrap_socket",
    "wait_for_read",
    "wait_for_write",
    "SKIP_HEADER",
    "SKIPPABLE_HEADERS",
)

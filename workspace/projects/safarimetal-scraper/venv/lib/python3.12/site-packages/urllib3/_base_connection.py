from __future__ import annotations

import typing

from .util.connection import _TYPE_SOCKET_OPTIONS
from .util.timeout import _DEFAULT_TIMEOUT, _TYPE_TIMEOUT
from .util.url import Url

_TYPE_BODY = typing.Union[bytes, typing.IO[typing.Any], typing.Iterable[bytes], str]


class ProxyConfig(typing.NamedTuple):
    ssl_context: ssl.SSLContext | None
    use_forwarding_for_https: bool
    assert_hostname: None | str | typing.Literal[False]
    assert_fingerprint: str | None


class _ResponseOptions(typing.NamedTuple):
    # TODO: Remove this in favor of a better
    # HTTP request/response lifecycle tracking.
    request_method: str
    request_url: str
    preload_content: bool
    decode_content: bool
    enforce_content_length: bool


if typing.TYPE_CHECKING:
    import ssl
    from typing import Protocol

    from .response import BaseHTTPResponse

    class BaseHTTPConnection(Protocol):
        default_port: typing.ClassVar[int]
        default_socket_options: typing.ClassVar[_TYPE_SOCKET_OPTIONS]

        host: str
        port: int
        timeout: None | (
            float
        )  # Instance doesn't store _DEFAULT_TIMEOUT, must be resolved.
        blocksize: int
        source_address: tuple[str, int] | None
        socket_options: _TYPE_SOCKET_OPTIONS | None

        proxy: Url | None
        proxy_config: ProxyConfig | None

        is_verified: bool
        proxy_is_verified: bool | None

        def __init__(
            self,
            host: str,
            port: int | None = None,
            *,
            timeout: _TYPE_TIMEOUT = _DEFAULT_TIMEOUT,
            source_address: tuple[str, int] | None = None,
            blocksize: int = 8192,
            socket_options: _TYPE_SOCKET_OPTIONS | None = ...,
            proxy: Url | None = None,
            proxy_config: ProxyConfig | None = None,
        ) -> None: ...

        def set_tunnel(
            self,
            host: str,
            port: int | None = None,
            headers: typing.Mapping[str, str] | None = None,
            scheme: str = "http",
        ) -> None: ...

        def connect(self) -> None: ...

        def request(
            self,
            method: str,
            url: str,
            body: _TYPE_BODY | None = None,
            headers: typing.Mapping[str, str] | None = None,
            # We know *at least* botocore is depending on the order of the
            # first 3 parameters so to be safe we only mark the later ones
            # as keyword-only to ensure we have space to extend.
            *,
            chunked: bool = False,
            preload_content: bool = True,
            decode_content: bool = True,
            enforce_content_length: bool = True,
        ) -> None: ...

        def getresponse(self) -> BaseHTTPResponse: ...

        def close(self) -> None: ...

        @property
        def is_closed(self) -> bool:
            """Whether the connection either is brand new or has been previously closed.
            If this property is True then both ``is_connected`` and ``has_connected_to_proxy``
            properties must be False.
            """

        @property
        def is_connected(self) -> bool:
            """Whether the connection is actively connected to any origin (proxy or target)"""

        @property
        def has_connected_to_proxy(self) -> bool:
            """Whether the connection has successfully connected to its proxy.
            This returns False if no proxy is in use. Used to determine whether
            errors are coming from the proxy layer or from tunnelling to the target origin.
            """

    class BaseHTTPSConnection(BaseHTTPConnection, Protocol):
        default_port: typing.ClassVar[int]
        default_socket_options: typing.ClassVar[_TYPE_SOCKET_OPTIONS]

        # Certificate verification methods
        cert_reqs: int | str | None
        assert_hostname: None | str | typing.Literal[False]
        assert_fingerprint: str | None
        ssl_context: ssl.SSLContext | None

        # Trusted CAs
        ca_certs: str | None
        ca_cert_dir: str | None
        ca_cert_data: None | str | bytes

        # TLS version
        ssl_minimum_version: int | None
        ssl_maximum_version: int | None
        ssl_version: int | str | None  # Deprecated

        # Client certificates
        cert_file: str | None
        key_file: str | None
        key_password: str | None

        def __init__(
            self,
            host: str,
            port: int | None = None,
            *,
            timeout: _TYPE_TIMEOUT = _DEFAULT_TIMEOUT,
            source_address: tuple[str, int] | None = None,
            blocksize: int = 16384,
            socket_options: _TYPE_SOCKET_OPTIONS | None = ...,
            proxy: Url | None = None,
            proxy_config: ProxyConfig | None = None,
            cert_reqs: int | str | None = None,
            assert_hostname: None | str | typing.Literal[False] = None,
            assert_fingerprint: str | None = None,
            server_hostname: str | None = None,
            ssl_context: ssl.SSLContext | None = None,
            ca_certs: str | None = None,
            ca_cert_dir: str | None = None,
            ca_cert_data: None | str | bytes = None,
            ssl_minimum_version: int | None = None,
            ssl_maximum_version: int | None = None,
            ssl_version: int | str | None = None,  # Deprecated
            cert_file: str | None = None,
            key_file: str | None = None,
            key_password: str | None = None,
        ) -> None: ...

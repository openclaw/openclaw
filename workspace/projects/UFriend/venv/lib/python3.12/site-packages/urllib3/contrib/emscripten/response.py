from __future__ import annotations

import json as _json
import logging
import typing
from contextlib import contextmanager
from dataclasses import dataclass
from http.client import HTTPException as HTTPException
from io import BytesIO, IOBase

from ...exceptions import InvalidHeader, TimeoutError
from ...response import BaseHTTPResponse
from ...util.retry import Retry
from .request import EmscriptenRequest

if typing.TYPE_CHECKING:
    from ..._base_connection import BaseHTTPConnection, BaseHTTPSConnection

log = logging.getLogger(__name__)


@dataclass
class EmscriptenResponse:
    status_code: int
    headers: dict[str, str]
    body: IOBase | bytes
    request: EmscriptenRequest


class EmscriptenHttpResponseWrapper(BaseHTTPResponse):
    def __init__(
        self,
        internal_response: EmscriptenResponse,
        url: str | None = None,
        connection: BaseHTTPConnection | BaseHTTPSConnection | None = None,
    ):
        self._pool = None  # set by pool class
        self._body = None
        self._response = internal_response
        self._url = url
        self._connection = connection
        self._closed = False
        super().__init__(
            headers=internal_response.headers,
            status=internal_response.status_code,
            request_url=url,
            version=0,
            version_string="HTTP/?",
            reason="",
            decode_content=True,
        )
        self.length_remaining = self._init_length(self._response.request.method)
        self.length_is_certain = False

    @property
    def url(self) -> str | None:
        return self._url

    @url.setter
    def url(self, url: str | None) -> None:
        self._url = url

    @property
    def connection(self) -> BaseHTTPConnection | BaseHTTPSConnection | None:
        return self._connection

    @property
    def retries(self) -> Retry | None:
        return self._retries

    @retries.setter
    def retries(self, retries: Retry | None) -> None:
        # Override the request_url if retries has a redirect location.
        self._retries = retries

    def stream(
        self, amt: int | None = 2**16, decode_content: bool | None = None
    ) -> typing.Generator[bytes]:
        """
        A generator wrapper for the read() method. A call will block until
        ``amt`` bytes have been read from the connection or until the
        connection is closed.

        :param amt:
            How much of the content to read. The generator will return up to
            much data per iteration, but may return less. This is particularly
            likely when using compressed data. However, the empty string will
            never be returned.

        :param decode_content:
            If True, will attempt to decode the body based on the
            'content-encoding' header.
        """
        while True:
            data = self.read(amt=amt, decode_content=decode_content)

            if data:
                yield data
            else:
                break

    def _init_length(self, request_method: str | None) -> int | None:
        length: int | None
        content_length: str | None = self.headers.get("content-length")

        if content_length is not None:
            try:
                # RFC 7230 section 3.3.2 specifies multiple content lengths can
                # be sent in a single Content-Length header
                # (e.g. Content-Length: 42, 42). This line ensures the values
                # are all valid ints and that as long as the `set` length is 1,
                # all values are the same. Otherwise, the header is invalid.
                lengths = {int(val) for val in content_length.split(",")}
                if len(lengths) > 1:
                    raise InvalidHeader(
                        "Content-Length contained multiple "
                        "unmatching values (%s)" % content_length
                    )
                length = lengths.pop()
            except ValueError:
                length = None
            else:
                if length < 0:
                    length = None

        else:  # if content_length is None
            length = None

        # Check for responses that shouldn't include a body
        if (
            self.status in (204, 304)
            or 100 <= self.status < 200
            or request_method == "HEAD"
        ):
            length = 0

        return length

    def read(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,  # ignored because browser decodes always
        cache_content: bool = False,
    ) -> bytes:
        if (
            self._closed
            or self._response is None
            or (isinstance(self._response.body, IOBase) and self._response.body.closed)
        ):
            return b""

        with self._error_catcher():
            # body has been preloaded as a string by XmlHttpRequest
            if not isinstance(self._response.body, IOBase):
                self.length_remaining = len(self._response.body)
                self.length_is_certain = True
                # wrap body in IOStream
                self._response.body = BytesIO(self._response.body)
            if amt is not None and amt >= 0:
                # don't cache partial content
                cache_content = False
                data = self._response.body.read(amt)
            else:  # read all we can (and cache it)
                data = self._response.body.read()
                if cache_content:
                    self._body = data
            if self.length_remaining is not None:
                self.length_remaining = max(self.length_remaining - len(data), 0)
            if len(data) == 0 or (
                self.length_is_certain and self.length_remaining == 0
            ):
                # definitely finished reading, close response stream
                self._response.body.close()
            return typing.cast(bytes, data)

    def read_chunked(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
    ) -> typing.Generator[bytes]:
        # chunked is handled by browser
        while True:
            bytes = self.read(amt, decode_content)
            if not bytes:
                break
            yield bytes

    def release_conn(self) -> None:
        if not self._pool or not self._connection:
            return None

        self._pool._put_conn(self._connection)
        self._connection = None

    def drain_conn(self) -> None:
        self.close()

    @property
    def data(self) -> bytes:
        if self._body:
            return self._body
        else:
            return self.read(cache_content=True)

    def json(self) -> typing.Any:
        """
        Deserializes the body of the HTTP response as a Python object.

        The body of the HTTP response must be encoded using UTF-8, as per
        `RFC 8529 Section 8.1 <https://www.rfc-editor.org/rfc/rfc8259#section-8.1>`_.

        To use a custom JSON decoder pass the result of :attr:`HTTPResponse.data` to
        your custom decoder instead.

        If the body of the HTTP response is not decodable to UTF-8, a
        `UnicodeDecodeError` will be raised. If the body of the HTTP response is not a
        valid JSON document, a `json.JSONDecodeError` will be raised.

        Read more :ref:`here <json_content>`.

        :returns: The body of the HTTP response as a Python object.
        """
        data = self.data.decode("utf-8")
        return _json.loads(data)

    def close(self) -> None:
        if not self._closed:
            if isinstance(self._response.body, IOBase):
                self._response.body.close()
            if self._connection:
                self._connection.close()
                self._connection = None
            self._closed = True

    @contextmanager
    def _error_catcher(self) -> typing.Generator[None]:
        """
        Catch Emscripten specific exceptions thrown by fetch.py,
        instead re-raising urllib3 variants, so that low-level exceptions
        are not leaked in the high-level api.

        On exit, release the connection back to the pool.
        """
        from .fetch import _RequestError, _TimeoutError  # avoid circular import

        clean_exit = False

        try:
            yield
            # If no exception is thrown, we should avoid cleaning up
            # unnecessarily.
            clean_exit = True
        except _TimeoutError as e:
            raise TimeoutError(str(e))
        except _RequestError as e:
            raise HTTPException(str(e))
        finally:
            # If we didn't terminate cleanly, we need to throw away our
            # connection.
            if not clean_exit:
                # The response may not be closed but we're not going to use it
                # anymore so close it now
                if (
                    isinstance(self._response.body, IOBase)
                    and not self._response.body.closed
                ):
                    self._response.body.close()
                # release the connection back to the pool
                self.release_conn()
            else:
                # If we have read everything from the response stream,
                # return the connection back to the pool.
                if (
                    isinstance(self._response.body, IOBase)
                    and self._response.body.closed
                ):
                    self.release_conn()

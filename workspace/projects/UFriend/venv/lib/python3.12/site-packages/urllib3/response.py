from __future__ import annotations

import collections
import io
import json as _json
import logging
import socket
import sys
import typing
import warnings
import zlib
from contextlib import contextmanager
from http.client import HTTPMessage as _HttplibHTTPMessage
from http.client import HTTPResponse as _HttplibHTTPResponse
from socket import timeout as SocketTimeout

if typing.TYPE_CHECKING:
    from ._base_connection import BaseHTTPConnection

try:
    try:
        import brotlicffi as brotli  # type: ignore[import-not-found]
    except ImportError:
        import brotli  # type: ignore[import-not-found]
except ImportError:
    brotli = None

from . import util
from ._base_connection import _TYPE_BODY
from ._collections import HTTPHeaderDict
from .connection import BaseSSLError, HTTPConnection, HTTPException
from .exceptions import (
    BodyNotHttplibCompatible,
    DecodeError,
    DependencyWarning,
    HTTPError,
    IncompleteRead,
    InvalidChunkLength,
    InvalidHeader,
    ProtocolError,
    ReadTimeoutError,
    ResponseNotChunked,
    SSLError,
)
from .util.response import is_fp_closed, is_response_to_head
from .util.retry import Retry

if typing.TYPE_CHECKING:
    from .connectionpool import HTTPConnectionPool

log = logging.getLogger(__name__)


class ContentDecoder:
    def decompress(self, data: bytes, max_length: int = -1) -> bytes:
        raise NotImplementedError()

    @property
    def has_unconsumed_tail(self) -> bool:
        raise NotImplementedError()

    def flush(self) -> bytes:
        raise NotImplementedError()


class DeflateDecoder(ContentDecoder):
    def __init__(self) -> None:
        self._first_try = True
        self._first_try_data = b""
        self._unfed_data = b""
        self._obj = zlib.decompressobj()

    def decompress(self, data: bytes, max_length: int = -1) -> bytes:
        data = self._unfed_data + data
        self._unfed_data = b""
        if not data and not self._obj.unconsumed_tail:
            return data
        original_max_length = max_length
        if original_max_length < 0:
            max_length = 0
        elif original_max_length == 0:
            # We should not pass 0 to the zlib decompressor because 0 is
            # the default value that will make zlib decompress without a
            # length limit.
            # Data should be stored for subsequent calls.
            self._unfed_data = data
            return b""

        # Subsequent calls always reuse `self._obj`. zlib requires
        # passing the unconsumed tail if decompression is to continue.
        if not self._first_try:
            return self._obj.decompress(
                self._obj.unconsumed_tail + data, max_length=max_length
            )

        # First call tries with RFC 1950 ZLIB format.
        self._first_try_data += data
        try:
            decompressed = self._obj.decompress(data, max_length=max_length)
            if decompressed:
                self._first_try = False
                self._first_try_data = b""
            return decompressed
        # On failure, it falls back to RFC 1951 DEFLATE format.
        except zlib.error:
            self._first_try = False
            self._obj = zlib.decompressobj(-zlib.MAX_WBITS)
            try:
                return self.decompress(
                    self._first_try_data, max_length=original_max_length
                )
            finally:
                self._first_try_data = b""

    @property
    def has_unconsumed_tail(self) -> bool:
        return bool(self._unfed_data) or (
            bool(self._obj.unconsumed_tail) and not self._first_try
        )

    def flush(self) -> bytes:
        return self._obj.flush()


class GzipDecoderState:
    FIRST_MEMBER = 0
    OTHER_MEMBERS = 1
    SWALLOW_DATA = 2


class GzipDecoder(ContentDecoder):
    def __init__(self) -> None:
        self._obj = zlib.decompressobj(16 + zlib.MAX_WBITS)
        self._state = GzipDecoderState.FIRST_MEMBER
        self._unconsumed_tail = b""

    def decompress(self, data: bytes, max_length: int = -1) -> bytes:
        ret = bytearray()
        if self._state == GzipDecoderState.SWALLOW_DATA:
            return bytes(ret)

        if max_length == 0:
            # We should not pass 0 to the zlib decompressor because 0 is
            # the default value that will make zlib decompress without a
            # length limit.
            # Data should be stored for subsequent calls.
            self._unconsumed_tail += data
            return b""

        # zlib requires passing the unconsumed tail to the subsequent
        # call if decompression is to continue.
        data = self._unconsumed_tail + data
        if not data and self._obj.eof:
            return bytes(ret)

        while True:
            try:
                ret += self._obj.decompress(
                    data, max_length=max(max_length - len(ret), 0)
                )
            except zlib.error:
                previous_state = self._state
                # Ignore data after the first error
                self._state = GzipDecoderState.SWALLOW_DATA
                self._unconsumed_tail = b""
                if previous_state == GzipDecoderState.OTHER_MEMBERS:
                    # Allow trailing garbage acceptable in other gzip clients
                    return bytes(ret)
                raise

            self._unconsumed_tail = data = (
                self._obj.unconsumed_tail or self._obj.unused_data
            )
            if max_length > 0 and len(ret) >= max_length:
                break

            if not data:
                return bytes(ret)
            # When the end of a gzip member is reached, a new decompressor
            # must be created for unused (possibly future) data.
            if self._obj.eof:
                self._state = GzipDecoderState.OTHER_MEMBERS
                self._obj = zlib.decompressobj(16 + zlib.MAX_WBITS)

        return bytes(ret)

    @property
    def has_unconsumed_tail(self) -> bool:
        return bool(self._unconsumed_tail)

    def flush(self) -> bytes:
        return self._obj.flush()


if brotli is not None:

    class BrotliDecoder(ContentDecoder):
        # Supports both 'brotlipy' and 'Brotli' packages
        # since they share an import name. The top branches
        # are for 'brotlipy' and bottom branches for 'Brotli'
        def __init__(self) -> None:
            self._obj = brotli.Decompressor()
            if hasattr(self._obj, "decompress"):
                setattr(self, "_decompress", self._obj.decompress)
            else:
                setattr(self, "_decompress", self._obj.process)

        # Requires Brotli >= 1.2.0 for `output_buffer_limit`.
        def _decompress(self, data: bytes, output_buffer_limit: int = -1) -> bytes:
            raise NotImplementedError()

        def decompress(self, data: bytes, max_length: int = -1) -> bytes:
            try:
                if max_length > 0:
                    return self._decompress(data, output_buffer_limit=max_length)
                else:
                    return self._decompress(data)
            except TypeError:
                # Fallback for Brotli/brotlicffi/brotlipy versions without
                # the `output_buffer_limit` parameter.
                warnings.warn(
                    "Brotli >= 1.2.0 is required to prevent decompression bombs.",
                    DependencyWarning,
                )
                return self._decompress(data)

        @property
        def has_unconsumed_tail(self) -> bool:
            try:
                return not self._obj.can_accept_more_data()
            except AttributeError:
                return False

        def flush(self) -> bytes:
            if hasattr(self._obj, "flush"):
                return self._obj.flush()  # type: ignore[no-any-return]
            return b""


try:
    if sys.version_info >= (3, 14):
        from compression import zstd
    else:
        from backports import zstd
except ImportError:
    HAS_ZSTD = False
else:
    HAS_ZSTD = True

    class ZstdDecoder(ContentDecoder):
        def __init__(self) -> None:
            self._obj = zstd.ZstdDecompressor()

        def decompress(self, data: bytes, max_length: int = -1) -> bytes:
            if not data and not self.has_unconsumed_tail:
                return b""
            if self._obj.eof:
                data = self._obj.unused_data + data
                self._obj = zstd.ZstdDecompressor()
            part = self._obj.decompress(data, max_length=max_length)
            length = len(part)
            data_parts = [part]
            # Every loop iteration is supposed to read data from a separate frame.
            # The loop breaks when:
            #   - enough data is read;
            #   - no more unused data is available;
            #   - end of the last read frame has not been reached (i.e.,
            #     more data has to be fed).
            while (
                self._obj.eof
                and self._obj.unused_data
                and (max_length < 0 or length < max_length)
            ):
                unused_data = self._obj.unused_data
                if not self._obj.needs_input:
                    self._obj = zstd.ZstdDecompressor()
                part = self._obj.decompress(
                    unused_data,
                    max_length=(max_length - length) if max_length > 0 else -1,
                )
                if part_length := len(part):
                    data_parts.append(part)
                    length += part_length
                elif self._obj.needs_input:
                    break
            return b"".join(data_parts)

        @property
        def has_unconsumed_tail(self) -> bool:
            return not (self._obj.needs_input or self._obj.eof) or bool(
                self._obj.unused_data
            )

        def flush(self) -> bytes:
            if not self._obj.eof:
                raise DecodeError("Zstandard data is incomplete")
            return b""


class MultiDecoder(ContentDecoder):
    """
    From RFC7231:
        If one or more encodings have been applied to a representation, the
        sender that applied the encodings MUST generate a Content-Encoding
        header field that lists the content codings in the order in which
        they were applied.
    """

    # Maximum allowed number of chained HTTP encodings in the
    # Content-Encoding header.
    max_decode_links = 5

    def __init__(self, modes: str) -> None:
        encodings = [m.strip() for m in modes.split(",")]
        if len(encodings) > self.max_decode_links:
            raise DecodeError(
                "Too many content encodings in the chain: "
                f"{len(encodings)} > {self.max_decode_links}"
            )
        self._decoders = [_get_decoder(e) for e in encodings]

    def flush(self) -> bytes:
        return self._decoders[0].flush()

    def decompress(self, data: bytes, max_length: int = -1) -> bytes:
        if max_length <= 0:
            for d in reversed(self._decoders):
                data = d.decompress(data)
            return data

        ret = bytearray()
        # Every while loop iteration goes through all decoders once.
        # It exits when enough data is read or no more data can be read.
        # It is possible that the while loop iteration does not produce
        # any data because we retrieve up to `max_length` from every
        # decoder, and the amount of bytes may be insufficient for the
        # next decoder to produce enough/any output.
        while True:
            any_data = False
            for d in reversed(self._decoders):
                data = d.decompress(data, max_length=max_length - len(ret))
                if data:
                    any_data = True
                # We should not break when no data is returned because
                # next decoders may produce data even with empty input.
            ret += data
            if not any_data or len(ret) >= max_length:
                return bytes(ret)
            data = b""

    @property
    def has_unconsumed_tail(self) -> bool:
        return any(d.has_unconsumed_tail for d in self._decoders)


def _get_decoder(mode: str) -> ContentDecoder:
    if "," in mode:
        return MultiDecoder(mode)

    # According to RFC 9110 section 8.4.1.3, recipients should
    # consider x-gzip equivalent to gzip
    if mode in ("gzip", "x-gzip"):
        return GzipDecoder()

    if brotli is not None and mode == "br":
        return BrotliDecoder()

    if HAS_ZSTD and mode == "zstd":
        return ZstdDecoder()

    return DeflateDecoder()


class BytesQueueBuffer:
    """Memory-efficient bytes buffer

    To return decoded data in read() and still follow the BufferedIOBase API, we need a
    buffer to always return the correct amount of bytes.

    This buffer should be filled using calls to put()

    Our maximum memory usage is determined by the sum of the size of:

     * self.buffer, which contains the full data
     * the largest chunk that we will copy in get()
    """

    def __init__(self) -> None:
        self.buffer: typing.Deque[bytes | memoryview[bytes]] = collections.deque()
        self._size: int = 0

    def __len__(self) -> int:
        return self._size

    def put(self, data: bytes) -> None:
        self.buffer.append(data)
        self._size += len(data)

    def get(self, n: int) -> bytes:
        if n == 0:
            return b""
        elif not self.buffer:
            raise RuntimeError("buffer is empty")
        elif n < 0:
            raise ValueError("n should be > 0")

        if len(self.buffer[0]) == n and isinstance(self.buffer[0], bytes):
            self._size -= n
            return self.buffer.popleft()

        fetched = 0
        ret = io.BytesIO()
        while fetched < n:
            remaining = n - fetched
            chunk = self.buffer.popleft()
            chunk_length = len(chunk)
            if remaining < chunk_length:
                chunk = memoryview(chunk)
                left_chunk, right_chunk = chunk[:remaining], chunk[remaining:]
                ret.write(left_chunk)
                self.buffer.appendleft(right_chunk)
                self._size -= remaining
                break
            else:
                ret.write(chunk)
                self._size -= chunk_length
            fetched += chunk_length

            if not self.buffer:
                break

        return ret.getvalue()

    def get_all(self) -> bytes:
        buffer = self.buffer
        if not buffer:
            assert self._size == 0
            return b""
        if len(buffer) == 1:
            result = buffer.pop()
            if isinstance(result, memoryview):
                result = result.tobytes()
        else:
            ret = io.BytesIO()
            ret.writelines(buffer.popleft() for _ in range(len(buffer)))
            result = ret.getvalue()
        self._size = 0
        return result


class BaseHTTPResponse(io.IOBase):
    CONTENT_DECODERS = ["gzip", "x-gzip", "deflate"]
    if brotli is not None:
        CONTENT_DECODERS += ["br"]
    if HAS_ZSTD:
        CONTENT_DECODERS += ["zstd"]
    REDIRECT_STATUSES = [301, 302, 303, 307, 308]

    DECODER_ERROR_CLASSES: tuple[type[Exception], ...] = (IOError, zlib.error)
    if brotli is not None:
        DECODER_ERROR_CLASSES += (brotli.error,)

    if HAS_ZSTD:
        DECODER_ERROR_CLASSES += (zstd.ZstdError,)

    def __init__(
        self,
        *,
        headers: typing.Mapping[str, str] | typing.Mapping[bytes, bytes] | None = None,
        status: int,
        version: int,
        version_string: str,
        reason: str | None,
        decode_content: bool,
        request_url: str | None,
        retries: Retry | None = None,
    ) -> None:
        if isinstance(headers, HTTPHeaderDict):
            self.headers = headers
        else:
            self.headers = HTTPHeaderDict(headers)  # type: ignore[arg-type]
        self.status = status
        self.version = version
        self.version_string = version_string
        self.reason = reason
        self.decode_content = decode_content
        self._has_decoded_content = False
        self._request_url: str | None = request_url
        self.retries = retries

        self.chunked = False
        tr_enc = self.headers.get("transfer-encoding", "").lower()
        # Don't incur the penalty of creating a list and then discarding it
        encodings = (enc.strip() for enc in tr_enc.split(","))
        if "chunked" in encodings:
            self.chunked = True

        self._decoder: ContentDecoder | None = None
        self.length_remaining: int | None

    def get_redirect_location(self) -> str | None | typing.Literal[False]:
        """
        Should we redirect and where to?

        :returns: Truthy redirect location string if we got a redirect status
            code and valid location. ``None`` if redirect status and no
            location. ``False`` if not a redirect status code.
        """
        if self.status in self.REDIRECT_STATUSES:
            return self.headers.get("location")
        return False

    @property
    def data(self) -> bytes:
        raise NotImplementedError()

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

    @property
    def url(self) -> str | None:
        raise NotImplementedError()

    @url.setter
    def url(self, url: str | None) -> None:
        raise NotImplementedError()

    @property
    def connection(self) -> BaseHTTPConnection | None:
        raise NotImplementedError()

    @property
    def retries(self) -> Retry | None:
        return self._retries

    @retries.setter
    def retries(self, retries: Retry | None) -> None:
        # Override the request_url if retries has a redirect location.
        if retries is not None and retries.history:
            self.url = retries.history[-1].redirect_location
        self._retries = retries

    def stream(
        self, amt: int | None = 2**16, decode_content: bool | None = None
    ) -> typing.Iterator[bytes]:
        raise NotImplementedError()

    def read(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
        cache_content: bool = False,
    ) -> bytes:
        raise NotImplementedError()

    def read1(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
    ) -> bytes:
        raise NotImplementedError()

    def read_chunked(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
    ) -> typing.Iterator[bytes]:
        raise NotImplementedError()

    def release_conn(self) -> None:
        raise NotImplementedError()

    def drain_conn(self) -> None:
        raise NotImplementedError()

    def shutdown(self) -> None:
        raise NotImplementedError()

    def close(self) -> None:
        raise NotImplementedError()

    def _init_decoder(self) -> None:
        """
        Set-up the _decoder attribute if necessary.
        """
        # Note: content-encoding value should be case-insensitive, per RFC 7230
        # Section 3.2
        content_encoding = self.headers.get("content-encoding", "").lower()
        if self._decoder is None:
            if content_encoding in self.CONTENT_DECODERS:
                self._decoder = _get_decoder(content_encoding)
            elif "," in content_encoding:
                encodings = [
                    e.strip()
                    for e in content_encoding.split(",")
                    if e.strip() in self.CONTENT_DECODERS
                ]
                if encodings:
                    self._decoder = _get_decoder(content_encoding)

    def _decode(
        self,
        data: bytes,
        decode_content: bool | None,
        flush_decoder: bool,
        max_length: int | None = None,
    ) -> bytes:
        """
        Decode the data passed in and potentially flush the decoder.
        """
        if not decode_content:
            if self._has_decoded_content:
                raise RuntimeError(
                    "Calling read(decode_content=False) is not supported after "
                    "read(decode_content=True) was called."
                )
            return data

        if max_length is None or flush_decoder:
            max_length = -1

        try:
            if self._decoder:
                data = self._decoder.decompress(data, max_length=max_length)
                self._has_decoded_content = True
        except self.DECODER_ERROR_CLASSES as e:
            content_encoding = self.headers.get("content-encoding", "").lower()
            raise DecodeError(
                "Received response with content-encoding: %s, but "
                "failed to decode it." % content_encoding,
                e,
            ) from e
        if flush_decoder:
            data += self._flush_decoder()

        return data

    def _flush_decoder(self) -> bytes:
        """
        Flushes the decoder. Should only be called if the decoder is actually
        being used.
        """
        if self._decoder:
            return self._decoder.decompress(b"") + self._decoder.flush()
        return b""

    # Compatibility methods for `io` module
    def readinto(self, b: bytearray) -> int:
        temp = self.read(len(b))
        if len(temp) == 0:
            return 0
        else:
            b[: len(temp)] = temp
            return len(temp)

    # Methods used by dependent libraries
    def getheaders(self) -> HTTPHeaderDict:
        return self.headers

    def getheader(self, name: str, default: str | None = None) -> str | None:
        return self.headers.get(name, default)

    # Compatibility method for http.cookiejar
    def info(self) -> HTTPHeaderDict:
        return self.headers

    def geturl(self) -> str | None:
        return self.url


class HTTPResponse(BaseHTTPResponse):
    """
    HTTP Response container.

    Backwards-compatible with :class:`http.client.HTTPResponse` but the response ``body`` is
    loaded and decoded on-demand when the ``data`` property is accessed.  This
    class is also compatible with the Python standard library's :mod:`io`
    module, and can hence be treated as a readable object in the context of that
    framework.

    Extra parameters for behaviour not present in :class:`http.client.HTTPResponse`:

    :param preload_content:
        If True, the response's body will be preloaded during construction.

    :param decode_content:
        If True, will attempt to decode the body based on the
        'content-encoding' header.

    :param original_response:
        When this HTTPResponse wrapper is generated from an :class:`http.client.HTTPResponse`
        object, it's convenient to include the original for debug purposes. It's
        otherwise unused.

    :param retries:
        The retries contains the last :class:`~urllib3.util.retry.Retry` that
        was used during the request.

    :param enforce_content_length:
        Enforce content length checking. Body returned by server must match
        value of Content-Length header, if present. Otherwise, raise error.
    """

    def __init__(
        self,
        body: _TYPE_BODY = "",
        headers: typing.Mapping[str, str] | typing.Mapping[bytes, bytes] | None = None,
        status: int = 0,
        version: int = 0,
        version_string: str = "HTTP/?",
        reason: str | None = None,
        preload_content: bool = True,
        decode_content: bool = True,
        original_response: _HttplibHTTPResponse | None = None,
        pool: HTTPConnectionPool | None = None,
        connection: HTTPConnection | None = None,
        msg: _HttplibHTTPMessage | None = None,
        retries: Retry | None = None,
        enforce_content_length: bool = True,
        request_method: str | None = None,
        request_url: str | None = None,
        auto_close: bool = True,
        sock_shutdown: typing.Callable[[int], None] | None = None,
    ) -> None:
        super().__init__(
            headers=headers,
            status=status,
            version=version,
            version_string=version_string,
            reason=reason,
            decode_content=decode_content,
            request_url=request_url,
            retries=retries,
        )

        self.enforce_content_length = enforce_content_length
        self.auto_close = auto_close

        self._body = None
        self._fp: _HttplibHTTPResponse | None = None
        self._original_response = original_response
        self._fp_bytes_read = 0
        self.msg = msg

        if body and isinstance(body, (str, bytes)):
            self._body = body

        self._pool = pool
        self._connection = connection

        if hasattr(body, "read"):
            self._fp = body  # type: ignore[assignment]
        self._sock_shutdown = sock_shutdown

        # Are we using the chunked-style of transfer encoding?
        self.chunk_left: int | None = None

        # Determine length of response
        self.length_remaining = self._init_length(request_method)

        # Used to return the correct amount of bytes for partial read()s
        self._decoded_buffer = BytesQueueBuffer()

        # If requested, preload the body.
        if preload_content and not self._body:
            self._body = self.read(decode_content=decode_content)

    def release_conn(self) -> None:
        if not self._pool or not self._connection:
            return None

        self._pool._put_conn(self._connection)
        self._connection = None

    def drain_conn(self) -> None:
        """
        Read and discard any remaining HTTP response data in the response connection.

        Unread data in the HTTPResponse connection blocks the connection from being released back to the pool.
        """
        try:
            self.read(
                # Do not spend resources decoding the content unless
                # decoding has already been initiated.
                decode_content=self._has_decoded_content,
            )
        except (HTTPError, OSError, BaseSSLError, HTTPException):
            pass

    @property
    def data(self) -> bytes:
        # For backwards-compat with earlier urllib3 0.4 and earlier.
        if self._body:
            return self._body  # type: ignore[return-value]

        if self._fp:
            return self.read(cache_content=True)

        return None  # type: ignore[return-value]

    @property
    def connection(self) -> HTTPConnection | None:
        return self._connection

    def isclosed(self) -> bool:
        return is_fp_closed(self._fp)

    def tell(self) -> int:
        """
        Obtain the number of bytes pulled over the wire so far. May differ from
        the amount of content returned by :meth:``urllib3.response.HTTPResponse.read``
        if bytes are encoded on the wire (e.g, compressed).
        """
        return self._fp_bytes_read

    def _init_length(self, request_method: str | None) -> int | None:
        """
        Set initial length value for Response content if available.
        """
        length: int | None
        content_length: str | None = self.headers.get("content-length")

        if content_length is not None:
            if self.chunked:
                # This Response will fail with an IncompleteRead if it can't be
                # received as chunked. This method falls back to attempt reading
                # the response before raising an exception.
                log.warning(
                    "Received response with both Content-Length and "
                    "Transfer-Encoding set. This is expressly forbidden "
                    "by RFC 7230 sec 3.3.2. Ignoring Content-Length and "
                    "attempting to process response as Transfer-Encoding: "
                    "chunked."
                )
                return None

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

        # Convert status to int for comparison
        # In some cases, httplib returns a status of "_UNKNOWN"
        try:
            status = int(self.status)
        except ValueError:
            status = 0

        # Check for responses that shouldn't include a body
        if status in (204, 304) or 100 <= status < 200 or request_method == "HEAD":
            length = 0

        return length

    @contextmanager
    def _error_catcher(self) -> typing.Generator[None]:
        """
        Catch low-level python exceptions, instead re-raising urllib3
        variants, so that low-level exceptions are not leaked in the
        high-level api.

        On exit, release the connection back to the pool.
        """
        clean_exit = False

        try:
            try:
                yield

            except SocketTimeout as e:
                # FIXME: Ideally we'd like to include the url in the ReadTimeoutError but
                # there is yet no clean way to get at it from this context.
                raise ReadTimeoutError(self._pool, None, "Read timed out.") from e  # type: ignore[arg-type]

            except BaseSSLError as e:
                # FIXME: Is there a better way to differentiate between SSLErrors?
                if "read operation timed out" not in str(e):
                    # SSL errors related to framing/MAC get wrapped and reraised here
                    raise SSLError(e) from e

                raise ReadTimeoutError(self._pool, None, "Read timed out.") from e  # type: ignore[arg-type]

            except IncompleteRead as e:
                if (
                    e.expected is not None
                    and e.partial is not None
                    and e.expected == -e.partial
                ):
                    arg = "Response may not contain content."
                else:
                    arg = f"Connection broken: {e!r}"
                raise ProtocolError(arg, e) from e

            except (HTTPException, OSError) as e:
                raise ProtocolError(f"Connection broken: {e!r}", e) from e

            # If no exception is thrown, we should avoid cleaning up
            # unnecessarily.
            clean_exit = True
        finally:
            # If we didn't terminate cleanly, we need to throw away our
            # connection.
            if not clean_exit:
                # The response may not be closed but we're not going to use it
                # anymore so close it now to ensure that the connection is
                # released back to the pool.
                if self._original_response:
                    self._original_response.close()

                # Closing the response may not actually be sufficient to close
                # everything, so if we have a hold of the connection close that
                # too.
                if self._connection:
                    self._connection.close()

            # If we hold the original response but it's closed now, we should
            # return the connection back to the pool.
            if self._original_response and self._original_response.isclosed():
                self.release_conn()

    def _fp_read(
        self,
        amt: int | None = None,
        *,
        read1: bool = False,
    ) -> bytes:
        """
        Read a response with the thought that reading the number of bytes
        larger than can fit in a 32-bit int at a time via SSL in some
        known cases leads to an overflow error that has to be prevented
        if `amt` or `self.length_remaining` indicate that a problem may
        happen.

        The known cases:
          * CPython < 3.9.7 because of a bug
            https://github.com/urllib3/urllib3/issues/2513#issuecomment-1152559900.
          * urllib3 injected with pyOpenSSL-backed SSL-support.
          * CPython < 3.10 only when `amt` does not fit 32-bit int.
        """
        assert self._fp
        c_int_max = 2**31 - 1
        if (
            (amt and amt > c_int_max)
            or (
                amt is None
                and self.length_remaining
                and self.length_remaining > c_int_max
            )
        ) and (util.IS_PYOPENSSL or sys.version_info < (3, 10)):
            if read1:
                return self._fp.read1(c_int_max)
            buffer = io.BytesIO()
            # Besides `max_chunk_amt` being a maximum chunk size, it
            # affects memory overhead of reading a response by this
            # method in CPython.
            # `c_int_max` equal to 2 GiB - 1 byte is the actual maximum
            # chunk size that does not lead to an overflow error, but
            # 256 MiB is a compromise.
            max_chunk_amt = 2**28
            while amt is None or amt != 0:
                if amt is not None:
                    chunk_amt = min(amt, max_chunk_amt)
                    amt -= chunk_amt
                else:
                    chunk_amt = max_chunk_amt
                data = self._fp.read(chunk_amt)
                if not data:
                    break
                buffer.write(data)
                del data  # to reduce peak memory usage by `max_chunk_amt`.
            return buffer.getvalue()
        elif read1:
            return self._fp.read1(amt) if amt is not None else self._fp.read1()
        else:
            # StringIO doesn't like amt=None
            return self._fp.read(amt) if amt is not None else self._fp.read()

    def _raw_read(
        self,
        amt: int | None = None,
        *,
        read1: bool = False,
    ) -> bytes:
        """
        Reads `amt` of bytes from the socket.
        """
        if self._fp is None:
            return None  # type: ignore[return-value]

        fp_closed = getattr(self._fp, "closed", False)

        with self._error_catcher():
            data = self._fp_read(amt, read1=read1) if not fp_closed else b""
            if amt is not None and amt != 0 and not data:
                # Platform-specific: Buggy versions of Python.
                # Close the connection when no data is returned
                #
                # This is redundant to what httplib/http.client _should_
                # already do.  However, versions of python released before
                # December 15, 2012 (http://bugs.python.org/issue16298) do
                # not properly close the connection in all cases. There is
                # no harm in redundantly calling close.
                self._fp.close()
                if (
                    self.enforce_content_length
                    and self.length_remaining is not None
                    and self.length_remaining != 0
                ):
                    # This is an edge case that httplib failed to cover due
                    # to concerns of backward compatibility. We're
                    # addressing it here to make sure IncompleteRead is
                    # raised during streaming, so all calls with incorrect
                    # Content-Length are caught.
                    raise IncompleteRead(self._fp_bytes_read, self.length_remaining)
            elif read1 and (
                (amt != 0 and not data) or self.length_remaining == len(data)
            ):
                # All data has been read, but `self._fp.read1` in
                # CPython 3.12 and older doesn't always close
                # `http.client.HTTPResponse`, so we close it here.
                # See https://github.com/python/cpython/issues/113199
                self._fp.close()

        if data:
            self._fp_bytes_read += len(data)
            if self.length_remaining is not None:
                self.length_remaining -= len(data)
        return data

    def read(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
        cache_content: bool = False,
    ) -> bytes:
        """
        Similar to :meth:`http.client.HTTPResponse.read`, but with two additional
        parameters: ``decode_content`` and ``cache_content``.

        :param amt:
            How much of the content to read. If specified, caching is skipped
            because it doesn't make sense to cache partial content as the full
            response.

        :param decode_content:
            If True, will attempt to decode the body based on the
            'content-encoding' header.

        :param cache_content:
            If True, will save the returned data such that the same result is
            returned despite of the state of the underlying file object. This
            is useful if you want the ``.data`` property to continue working
            after having ``.read()`` the file object. (Overridden if ``amt`` is
            set.)
        """
        self._init_decoder()
        if decode_content is None:
            decode_content = self.decode_content

        if amt and amt < 0:
            # Negative numbers and `None` should be treated the same.
            amt = None
        elif amt is not None:
            cache_content = False

            if self._decoder and self._decoder.has_unconsumed_tail:
                decoded_data = self._decode(
                    b"",
                    decode_content,
                    flush_decoder=False,
                    max_length=amt - len(self._decoded_buffer),
                )
                self._decoded_buffer.put(decoded_data)
            if len(self._decoded_buffer) >= amt:
                return self._decoded_buffer.get(amt)

        data = self._raw_read(amt)

        flush_decoder = amt is None or (amt != 0 and not data)

        if (
            not data
            and len(self._decoded_buffer) == 0
            and not (self._decoder and self._decoder.has_unconsumed_tail)
        ):
            return data

        if amt is None:
            data = self._decode(data, decode_content, flush_decoder)
            if cache_content:
                self._body = data
        else:
            # do not waste memory on buffer when not decoding
            if not decode_content:
                if self._has_decoded_content:
                    raise RuntimeError(
                        "Calling read(decode_content=False) is not supported after "
                        "read(decode_content=True) was called."
                    )
                return data

            decoded_data = self._decode(
                data,
                decode_content,
                flush_decoder,
                max_length=amt - len(self._decoded_buffer),
            )
            self._decoded_buffer.put(decoded_data)

            while len(self._decoded_buffer) < amt and data:
                # TODO make sure to initially read enough data to get past the headers
                # For example, the GZ file header takes 10 bytes, we don't want to read
                # it one byte at a time
                data = self._raw_read(amt)
                decoded_data = self._decode(
                    data,
                    decode_content,
                    flush_decoder,
                    max_length=amt - len(self._decoded_buffer),
                )
                self._decoded_buffer.put(decoded_data)
            data = self._decoded_buffer.get(amt)

        return data

    def read1(
        self,
        amt: int | None = None,
        decode_content: bool | None = None,
    ) -> bytes:
        """
        Similar to ``http.client.HTTPResponse.read1`` and documented
        in :meth:`io.BufferedReader.read1`, but with an additional parameter:
        ``decode_content``.

        :param amt:
            How much of the content to read.

        :param decode_content:
            If True, will attempt to decode the body based on the
            'content-encoding' header.
        """
        if decode_content is None:
            decode_content = self.decode_content
        if amt and amt < 0:
            # Negative numbers and `None` should be treated the same.
            amt = None
        # try and respond without going to the network
        if self._has_decoded_content:
            if not decode_content:
                raise RuntimeError(
                    "Calling read1(decode_content=False) is not supported after "
                    "read1(decode_content=True) was called."
                )
            if (
                self._decoder
                and self._decoder.has_unconsumed_tail
                and (amt is None or len(self._decoded_buffer) < amt)
            ):
                decoded_data = self._decode(
                    b"",
                    decode_content,
                    flush_decoder=False,
                    max_length=(
                        amt - len(self._decoded_buffer) if amt is not None else None
                    ),
                )
                self._decoded_buffer.put(decoded_data)
            if len(self._decoded_buffer) > 0:
                if amt is None:
                    return self._decoded_buffer.get_all()
                return self._decoded_buffer.get(amt)
        if amt == 0:
            return b""

        # FIXME, this method's type doesn't say returning None is possible
        data = self._raw_read(amt, read1=True)
        if not decode_content or data is None:
            return data

        self._init_decoder()
        while True:
            flush_decoder = not data
            decoded_data = self._decode(
                data, decode_content, flush_decoder, max_length=amt
            )
            self._decoded_buffer.put(decoded_data)
            if decoded_data or flush_decoder:
                break
            data = self._raw_read(8192, read1=True)

        if amt is None:
            return self._decoded_buffer.get_all()
        return self._decoded_buffer.get(amt)

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
        if self.chunked and self.supports_chunked_reads():
            yield from self.read_chunked(amt, decode_content=decode_content)
        else:
            while (
                not is_fp_closed(self._fp)
                or len(self._decoded_buffer) > 0
                or (self._decoder and self._decoder.has_unconsumed_tail)
            ):
                data = self.read(amt=amt, decode_content=decode_content)

                if data:
                    yield data

    # Overrides from io.IOBase
    def readable(self) -> bool:
        return True

    def shutdown(self) -> None:
        if not self._sock_shutdown:
            raise ValueError("Cannot shutdown socket as self._sock_shutdown is not set")
        if self._connection is None:
            raise RuntimeError(
                "Cannot shutdown as connection has already been released to the pool"
            )
        self._sock_shutdown(socket.SHUT_RD)

    def close(self) -> None:
        self._sock_shutdown = None

        if not self.closed and self._fp:
            self._fp.close()

        if self._connection:
            self._connection.close()

        if not self.auto_close:
            io.IOBase.close(self)

    @property
    def closed(self) -> bool:
        if not self.auto_close:
            return io.IOBase.closed.__get__(self)  # type: ignore[no-any-return]
        elif self._fp is None:
            return True
        elif hasattr(self._fp, "isclosed"):
            return self._fp.isclosed()
        elif hasattr(self._fp, "closed"):
            return self._fp.closed
        else:
            return True

    def fileno(self) -> int:
        if self._fp is None:
            raise OSError("HTTPResponse has no file to get a fileno from")
        elif hasattr(self._fp, "fileno"):
            return self._fp.fileno()
        else:
            raise OSError(
                "The file-like object this HTTPResponse is wrapped "
                "around has no file descriptor"
            )

    def flush(self) -> None:
        if (
            self._fp is not None
            and hasattr(self._fp, "flush")
            and not getattr(self._fp, "closed", False)
        ):
            return self._fp.flush()

    def supports_chunked_reads(self) -> bool:
        """
        Checks if the underlying file-like object looks like a
        :class:`http.client.HTTPResponse` object. We do this by testing for
        the fp attribute. If it is present we assume it returns raw chunks as
        processed by read_chunked().
        """
        return hasattr(self._fp, "fp")

    def _update_chunk_length(self) -> None:
        # First, we'll figure out length of a chunk and then
        # we'll try to read it from socket.
        if self.chunk_left is not None:
            return None
        line = self._fp.fp.readline()  # type: ignore[union-attr]
        line = line.split(b";", 1)[0]
        try:
            self.chunk_left = int(line, 16)
        except ValueError:
            self.close()
            if line:
                # Invalid chunked protocol response, abort.
                raise InvalidChunkLength(self, line) from None
            else:
                # Truncated at start of next chunk
                raise ProtocolError("Response ended prematurely") from None

    def _handle_chunk(self, amt: int | None) -> bytes:
        returned_chunk = None
        if amt is None:
            chunk = self._fp._safe_read(self.chunk_left)  # type: ignore[union-attr]
            returned_chunk = chunk
            self._fp._safe_read(2)  # type: ignore[union-attr] # Toss the CRLF at the end of the chunk.
            self.chunk_left = None
        elif self.chunk_left is not None and amt < self.chunk_left:
            value = self._fp._safe_read(amt)  # type: ignore[union-attr]
            self.chunk_left = self.chunk_left - amt
            returned_chunk = value
        elif amt == self.chunk_left:
            value = self._fp._safe_read(amt)  # type: ignore[union-attr]
            self._fp._safe_read(2)  # type: ignore[union-attr] # Toss the CRLF at the end of the chunk.
            self.chunk_left = None
            returned_chunk = value
        else:  # amt > self.chunk_left
            returned_chunk = self._fp._safe_read(self.chunk_left)  # type: ignore[union-attr]
            self._fp._safe_read(2)  # type: ignore[union-attr] # Toss the CRLF at the end of the chunk.
            self.chunk_left = None
        return returned_chunk  # type: ignore[no-any-return]

    def read_chunked(
        self, amt: int | None = None, decode_content: bool | None = None
    ) -> typing.Generator[bytes]:
        """
        Similar to :meth:`HTTPResponse.read`, but with an additional
        parameter: ``decode_content``.

        :param amt:
            How much of the content to read. If specified, caching is skipped
            because it doesn't make sense to cache partial content as the full
            response.

        :param decode_content:
            If True, will attempt to decode the body based on the
            'content-encoding' header.
        """
        self._init_decoder()
        # FIXME: Rewrite this method and make it a class with a better structured logic.
        if not self.chunked:
            raise ResponseNotChunked(
                "Response is not chunked. "
                "Header 'transfer-encoding: chunked' is missing."
            )
        if not self.supports_chunked_reads():
            raise BodyNotHttplibCompatible(
                "Body should be http.client.HTTPResponse like. "
                "It should have have an fp attribute which returns raw chunks."
            )

        with self._error_catcher():
            # Don't bother reading the body of a HEAD request.
            if self._original_response and is_response_to_head(self._original_response):
                self._original_response.close()
                return None

            # If a response is already read and closed
            # then return immediately.
            if self._fp.fp is None:  # type: ignore[union-attr]
                return None

            if amt and amt < 0:
                # Negative numbers and `None` should be treated the same,
                # but httplib handles only `None` correctly.
                amt = None

            while True:
                # First, check if any data is left in the decoder's buffer.
                if self._decoder and self._decoder.has_unconsumed_tail:
                    chunk = b""
                else:
                    self._update_chunk_length()
                    if self.chunk_left == 0:
                        break
                    chunk = self._handle_chunk(amt)
                decoded = self._decode(
                    chunk,
                    decode_content=decode_content,
                    flush_decoder=False,
                    max_length=amt,
                )
                if decoded:
                    yield decoded

            if decode_content:
                # On CPython and PyPy, we should never need to flush the
                # decoder. However, on Jython we *might* need to, so
                # lets defensively do it anyway.
                decoded = self._flush_decoder()
                if decoded:  # Platform-specific: Jython.
                    yield decoded

            # Chunk content ends with \r\n: discard it.
            while self._fp is not None:
                line = self._fp.fp.readline()
                if not line:
                    # Some sites may not end with '\r\n'.
                    break
                if line == b"\r\n":
                    break

            # We read everything; close the "file".
            if self._original_response:
                self._original_response.close()

    @property
    def url(self) -> str | None:
        """
        Returns the URL that was the source of this response.
        If the request that generated this response redirected, this method
        will return the final redirect location.
        """
        return self._request_url

    @url.setter
    def url(self, url: str | None) -> None:
        self._request_url = url

    def __iter__(self) -> typing.Iterator[bytes]:
        buffer: list[bytes] = []
        for chunk in self.stream(decode_content=True):
            if b"\n" in chunk:
                chunks = chunk.split(b"\n")
                yield b"".join(buffer) + chunks[0] + b"\n"
                for x in chunks[1:-1]:
                    yield x + b"\n"
                if chunks[-1]:
                    buffer = [chunks[-1]]
                else:
                    buffer = []
            else:
                buffer.append(chunk)
        if buffer:
            yield b"".join(buffer)

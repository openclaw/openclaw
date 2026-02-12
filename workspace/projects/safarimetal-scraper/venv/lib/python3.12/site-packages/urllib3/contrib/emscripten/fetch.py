"""
Support for streaming http requests in emscripten.

A few caveats -

If your browser (or Node.js) has WebAssembly JavaScript Promise Integration enabled
https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
*and* you launch pyodide using `pyodide.runPythonAsync`, this will fetch data using the
JavaScript asynchronous fetch api (wrapped via `pyodide.ffi.call_sync`). In this case
timeouts and streaming should just work.

Otherwise, it uses a combination of XMLHttpRequest and a web-worker for streaming.

This approach has several caveats:

Firstly, you can't do streaming http in the main UI thread, because atomics.wait isn't allowed.
Streaming only works if you're running pyodide in a web worker.

Secondly, this uses an extra web worker and SharedArrayBuffer to do the asynchronous fetch
operation, so it requires that you have crossOriginIsolation enabled, by serving over https
(or from localhost) with the two headers below set:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

You can tell if cross origin isolation is successfully enabled by looking at the global crossOriginIsolated variable in
JavaScript console. If it isn't, streaming requests will fallback to XMLHttpRequest, i.e. getting the whole
request into a buffer and then returning it. it shows a warning in the JavaScript console in this case.

Finally, the webworker which does the streaming fetch is created on initial import, but will only be started once
control is returned to javascript. Call `await wait_for_streaming_ready()` to wait for streaming fetch.

NB: in this code, there are a lot of JavaScript objects. They are named js_*
to make it clear what type of object they are.
"""

from __future__ import annotations

import io
import json
from email.parser import Parser
from importlib.resources import files
from typing import TYPE_CHECKING, Any

import js  # type: ignore[import-not-found]
from pyodide.ffi import (  # type: ignore[import-not-found]
    JsArray,
    JsException,
    JsProxy,
    to_js,
)

if TYPE_CHECKING:
    from typing_extensions import Buffer

from .request import EmscriptenRequest
from .response import EmscriptenResponse

"""
There are some headers that trigger unintended CORS preflight requests.
See also https://github.com/koenvo/pyodide-http/issues/22
"""
HEADERS_TO_IGNORE = ("user-agent",)

SUCCESS_HEADER = -1
SUCCESS_EOF = -2
ERROR_TIMEOUT = -3
ERROR_EXCEPTION = -4


class _RequestError(Exception):
    def __init__(
        self,
        message: str | None = None,
        *,
        request: EmscriptenRequest | None = None,
        response: EmscriptenResponse | None = None,
    ):
        self.request = request
        self.response = response
        self.message = message
        super().__init__(self.message)


class _StreamingError(_RequestError):
    pass


class _TimeoutError(_RequestError):
    pass


def _obj_from_dict(dict_val: dict[str, Any]) -> JsProxy:
    return to_js(dict_val, dict_converter=js.Object.fromEntries)


class _ReadStream(io.RawIOBase):
    def __init__(
        self,
        int_buffer: JsArray,
        byte_buffer: JsArray,
        timeout: float,
        worker: JsProxy,
        connection_id: int,
        request: EmscriptenRequest,
    ):
        self.int_buffer = int_buffer
        self.byte_buffer = byte_buffer
        self.read_pos = 0
        self.read_len = 0
        self.connection_id = connection_id
        self.worker = worker
        self.timeout = int(1000 * timeout) if timeout > 0 else None
        self.is_live = True
        self._is_closed = False
        self.request: EmscriptenRequest | None = request

    def __del__(self) -> None:
        self.close()

    # this is compatible with _base_connection
    def is_closed(self) -> bool:
        return self._is_closed

    # for compatibility with RawIOBase
    @property
    def closed(self) -> bool:
        return self.is_closed()

    def close(self) -> None:
        if self.is_closed():
            return
        self.read_len = 0
        self.read_pos = 0
        self.int_buffer = None
        self.byte_buffer = None
        self._is_closed = True
        self.request = None
        if self.is_live:
            self.worker.postMessage(_obj_from_dict({"close": self.connection_id}))
            self.is_live = False
        super().close()

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return False

    def readinto(self, byte_obj: Buffer) -> int:
        if not self.int_buffer:
            raise _StreamingError(
                "No buffer for stream in _ReadStream.readinto",
                request=self.request,
                response=None,
            )
        if self.read_len == 0:
            # wait for the worker to send something
            js.Atomics.store(self.int_buffer, 0, ERROR_TIMEOUT)
            self.worker.postMessage(_obj_from_dict({"getMore": self.connection_id}))
            if (
                js.Atomics.wait(self.int_buffer, 0, ERROR_TIMEOUT, self.timeout)
                == "timed-out"
            ):
                raise _TimeoutError
            data_len = self.int_buffer[0]
            if data_len > 0:
                self.read_len = data_len
                self.read_pos = 0
            elif data_len == ERROR_EXCEPTION:
                string_len = self.int_buffer[1]
                # decode the error string
                js_decoder = js.TextDecoder.new()
                json_str = js_decoder.decode(self.byte_buffer.slice(0, string_len))
                raise _StreamingError(
                    f"Exception thrown in fetch: {json_str}",
                    request=self.request,
                    response=None,
                )
            else:
                # EOF, free the buffers and return zero
                # and free the request
                self.is_live = False
                self.close()
                return 0
        # copy from int32array to python bytes
        ret_length = min(self.read_len, len(memoryview(byte_obj)))
        subarray = self.byte_buffer.subarray(
            self.read_pos, self.read_pos + ret_length
        ).to_py()
        memoryview(byte_obj)[0:ret_length] = subarray
        self.read_len -= ret_length
        self.read_pos += ret_length
        return ret_length


class _StreamingFetcher:
    def __init__(self) -> None:
        # make web-worker and data buffer on startup
        self.streaming_ready = False
        streaming_worker_code = (
            files(__package__)
            .joinpath("emscripten_fetch_worker.js")
            .read_text(encoding="utf-8")
        )
        js_data_blob = js.Blob.new(
            to_js([streaming_worker_code], create_pyproxies=False),
            _obj_from_dict({"type": "application/javascript"}),
        )

        def promise_resolver(js_resolve_fn: JsProxy, js_reject_fn: JsProxy) -> None:
            def onMsg(e: JsProxy) -> None:
                self.streaming_ready = True
                js_resolve_fn(e)

            def onErr(e: JsProxy) -> None:
                js_reject_fn(e)  # Defensive: never happens in ci

            self.js_worker.onmessage = onMsg
            self.js_worker.onerror = onErr

        js_data_url = js.URL.createObjectURL(js_data_blob)
        self.js_worker = js.globalThis.Worker.new(js_data_url)
        self.js_worker_ready_promise = js.globalThis.Promise.new(promise_resolver)

    def send(self, request: EmscriptenRequest) -> EmscriptenResponse:
        headers = {
            k: v for k, v in request.headers.items() if k not in HEADERS_TO_IGNORE
        }

        body = request.body
        fetch_data = {"headers": headers, "body": to_js(body), "method": request.method}
        # start the request off in the worker
        timeout = int(1000 * request.timeout) if request.timeout > 0 else None
        js_shared_buffer = js.SharedArrayBuffer.new(1048576)
        js_int_buffer = js.Int32Array.new(js_shared_buffer)
        js_byte_buffer = js.Uint8Array.new(js_shared_buffer, 8)

        js.Atomics.store(js_int_buffer, 0, ERROR_TIMEOUT)
        js.Atomics.notify(js_int_buffer, 0)
        js_absolute_url = js.URL.new(request.url, js.location).href
        self.js_worker.postMessage(
            _obj_from_dict(
                {
                    "buffer": js_shared_buffer,
                    "url": js_absolute_url,
                    "fetchParams": fetch_data,
                }
            )
        )
        # wait for the worker to send something
        js.Atomics.wait(js_int_buffer, 0, ERROR_TIMEOUT, timeout)
        if js_int_buffer[0] == ERROR_TIMEOUT:
            raise _TimeoutError(
                "Timeout connecting to streaming request",
                request=request,
                response=None,
            )
        elif js_int_buffer[0] == SUCCESS_HEADER:
            # got response
            # header length is in second int of intBuffer
            string_len = js_int_buffer[1]
            # decode the rest to a JSON string
            js_decoder = js.TextDecoder.new()
            # this does a copy (the slice) because decode can't work on shared array
            # for some silly reason
            json_str = js_decoder.decode(js_byte_buffer.slice(0, string_len))
            # get it as an object
            response_obj = json.loads(json_str)
            return EmscriptenResponse(
                request=request,
                status_code=response_obj["status"],
                headers=response_obj["headers"],
                body=_ReadStream(
                    js_int_buffer,
                    js_byte_buffer,
                    request.timeout,
                    self.js_worker,
                    response_obj["connectionID"],
                    request,
                ),
            )
        elif js_int_buffer[0] == ERROR_EXCEPTION:
            string_len = js_int_buffer[1]
            # decode the error string
            js_decoder = js.TextDecoder.new()
            json_str = js_decoder.decode(js_byte_buffer.slice(0, string_len))
            raise _StreamingError(
                f"Exception thrown in fetch: {json_str}", request=request, response=None
            )
        else:
            raise _StreamingError(
                f"Unknown status from worker in fetch: {js_int_buffer[0]}",
                request=request,
                response=None,
            )


class _JSPIReadStream(io.RawIOBase):
    """
    A read stream that uses pyodide.ffi.run_sync to read from a JavaScript fetch
    response. This requires support for WebAssembly JavaScript Promise Integration
    in the containing browser, and for pyodide to be launched via runPythonAsync.

    :param js_read_stream:
        The JavaScript stream reader

    :param timeout:
        Timeout in seconds

    :param request:
        The request we're handling

    :param response:
        The response this stream relates to

    :param js_abort_controller:
        A JavaScript AbortController object, used for timeouts
    """

    def __init__(
        self,
        js_read_stream: Any,
        timeout: float,
        request: EmscriptenRequest,
        response: EmscriptenResponse,
        js_abort_controller: Any,  # JavaScript AbortController for timeouts
    ):
        self.js_read_stream = js_read_stream
        self.timeout = timeout
        self._is_closed = False
        self._is_done = False
        self.request: EmscriptenRequest | None = request
        self.response: EmscriptenResponse | None = response
        self.current_buffer = None
        self.current_buffer_pos = 0
        self.js_abort_controller = js_abort_controller

    def __del__(self) -> None:
        self.close()

    # this is compatible with _base_connection
    def is_closed(self) -> bool:
        return self._is_closed

    # for compatibility with RawIOBase
    @property
    def closed(self) -> bool:
        return self.is_closed()

    def close(self) -> None:
        if self.is_closed():
            return
        self.read_len = 0
        self.read_pos = 0
        self.js_read_stream.cancel()
        self.js_read_stream = None
        self._is_closed = True
        self._is_done = True
        self.request = None
        self.response = None
        super().close()

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return False

    def _get_next_buffer(self) -> bool:
        result_js = _run_sync_with_timeout(
            self.js_read_stream.read(),
            self.timeout,
            self.js_abort_controller,
            request=self.request,
            response=self.response,
        )
        if result_js.done:
            self._is_done = True
            return False
        else:
            self.current_buffer = result_js.value.to_py()
            self.current_buffer_pos = 0
            return True

    def readinto(self, byte_obj: Buffer) -> int:
        if self.current_buffer is None:
            if not self._get_next_buffer() or self.current_buffer is None:
                self.close()
                return 0
        ret_length = min(
            len(byte_obj), len(self.current_buffer) - self.current_buffer_pos
        )
        byte_obj[0:ret_length] = self.current_buffer[
            self.current_buffer_pos : self.current_buffer_pos + ret_length
        ]
        self.current_buffer_pos += ret_length
        if self.current_buffer_pos == len(self.current_buffer):
            self.current_buffer = None
        return ret_length


# check if we are in a worker or not
def is_in_browser_main_thread() -> bool:
    return hasattr(js, "window") and hasattr(js, "self") and js.self == js.window


def is_cross_origin_isolated() -> bool:
    return hasattr(js, "crossOriginIsolated") and js.crossOriginIsolated


def is_in_node() -> bool:
    return (
        hasattr(js, "process")
        and hasattr(js.process, "release")
        and hasattr(js.process.release, "name")
        and js.process.release.name == "node"
    )


def is_worker_available() -> bool:
    return hasattr(js, "Worker") and hasattr(js, "Blob")


_fetcher: _StreamingFetcher | None = None

if is_worker_available() and (
    (is_cross_origin_isolated() and not is_in_browser_main_thread())
    and (not is_in_node())
):
    _fetcher = _StreamingFetcher()
else:
    _fetcher = None


NODE_JSPI_ERROR = (
    "urllib3 only works in Node.js with pyodide.runPythonAsync"
    " and requires the flag --experimental-wasm-stack-switching in "
    " versions of node <24."
)


def send_streaming_request(request: EmscriptenRequest) -> EmscriptenResponse | None:
    if has_jspi():
        return send_jspi_request(request, True)
    elif is_in_node():
        raise _RequestError(
            message=NODE_JSPI_ERROR,
            request=request,
            response=None,
        )

    if _fetcher and streaming_ready():
        return _fetcher.send(request)
    else:
        _show_streaming_warning()
        return None


_SHOWN_TIMEOUT_WARNING = False


def _show_timeout_warning() -> None:
    global _SHOWN_TIMEOUT_WARNING
    if not _SHOWN_TIMEOUT_WARNING:
        _SHOWN_TIMEOUT_WARNING = True
        message = "Warning: Timeout is not available on main browser thread"
        js.console.warn(message)


_SHOWN_STREAMING_WARNING = False


def _show_streaming_warning() -> None:
    global _SHOWN_STREAMING_WARNING
    if not _SHOWN_STREAMING_WARNING:
        _SHOWN_STREAMING_WARNING = True
        message = "Can't stream HTTP requests because: \n"
        if not is_cross_origin_isolated():
            message += "  Page is not cross-origin isolated\n"
        if is_in_browser_main_thread():
            message += "  Python is running in main browser thread\n"
        if not is_worker_available():
            message += " Worker or Blob classes are not available in this environment."  # Defensive: this is always False in browsers that we test in
        if streaming_ready() is False:
            message += """ Streaming fetch worker isn't ready. If you want to be sure that streaming fetch
is working, you need to call: 'await urllib3.contrib.emscripten.fetch.wait_for_streaming_ready()`"""
        from js import console

        console.warn(message)


def send_request(request: EmscriptenRequest) -> EmscriptenResponse:
    if has_jspi():
        return send_jspi_request(request, False)
    elif is_in_node():
        raise _RequestError(
            message=NODE_JSPI_ERROR,
            request=request,
            response=None,
        )
    try:
        js_xhr = js.XMLHttpRequest.new()

        if not is_in_browser_main_thread():
            js_xhr.responseType = "arraybuffer"
            if request.timeout:
                js_xhr.timeout = int(request.timeout * 1000)
        else:
            js_xhr.overrideMimeType("text/plain; charset=ISO-8859-15")
            if request.timeout:
                # timeout isn't available on the main thread - show a warning in console
                # if it is set
                _show_timeout_warning()

        js_xhr.open(request.method, request.url, False)
        for name, value in request.headers.items():
            if name.lower() not in HEADERS_TO_IGNORE:
                js_xhr.setRequestHeader(name, value)

        js_xhr.send(to_js(request.body))

        headers = dict(Parser().parsestr(js_xhr.getAllResponseHeaders()))

        if not is_in_browser_main_thread():
            body = js_xhr.response.to_py().tobytes()
        else:
            body = js_xhr.response.encode("ISO-8859-15")
        return EmscriptenResponse(
            status_code=js_xhr.status, headers=headers, body=body, request=request
        )
    except JsException as err:
        if err.name == "TimeoutError":
            raise _TimeoutError(err.message, request=request)
        elif err.name == "NetworkError":
            raise _RequestError(err.message, request=request)
        else:
            # general http error
            raise _RequestError(err.message, request=request)


def send_jspi_request(
    request: EmscriptenRequest, streaming: bool
) -> EmscriptenResponse:
    """
    Send a request using WebAssembly JavaScript Promise Integration
    to wrap the asynchronous JavaScript fetch api (experimental).

    :param request:
        Request to send

    :param streaming:
        Whether to stream the response

    :return: The response object
    :rtype: EmscriptenResponse
    """
    timeout = request.timeout
    js_abort_controller = js.AbortController.new()
    headers = {k: v for k, v in request.headers.items() if k not in HEADERS_TO_IGNORE}
    req_body = request.body
    fetch_data = {
        "headers": headers,
        "body": to_js(req_body),
        "method": request.method,
        "signal": js_abort_controller.signal,
    }
    # Node.js returns the whole response (unlike opaqueredirect in browsers),
    # so urllib3 can set `redirect: manual` to control redirects itself.
    # https://stackoverflow.com/a/78524615
    if _is_node_js():
        fetch_data["redirect"] = "manual"
    # Call JavaScript fetch (async api, returns a promise)
    fetcher_promise_js = js.fetch(request.url, _obj_from_dict(fetch_data))
    # Now suspend WebAssembly until we resolve that promise
    # or time out.
    response_js = _run_sync_with_timeout(
        fetcher_promise_js,
        timeout,
        js_abort_controller,
        request=request,
        response=None,
    )
    headers = {}
    header_iter = response_js.headers.entries()
    while True:
        iter_value_js = header_iter.next()
        if getattr(iter_value_js, "done", False):
            break
        else:
            headers[str(iter_value_js.value[0])] = str(iter_value_js.value[1])
    status_code = response_js.status
    body: bytes | io.RawIOBase = b""

    response = EmscriptenResponse(
        status_code=status_code, headers=headers, body=b"", request=request
    )
    if streaming:
        # get via inputstream
        if response_js.body is not None:
            # get a reader from the fetch response
            body_stream_js = response_js.body.getReader()
            body = _JSPIReadStream(
                body_stream_js, timeout, request, response, js_abort_controller
            )
    else:
        # get directly via arraybuffer
        # n.b. this is another async JavaScript call.
        body = _run_sync_with_timeout(
            response_js.arrayBuffer(),
            timeout,
            js_abort_controller,
            request=request,
            response=response,
        ).to_py()
    response.body = body
    return response


def _run_sync_with_timeout(
    promise: Any,
    timeout: float,
    js_abort_controller: Any,
    request: EmscriptenRequest | None,
    response: EmscriptenResponse | None,
) -> Any:
    """
    Await a JavaScript promise synchronously with a timeout which is implemented
    via the AbortController

    :param promise:
        Javascript promise to await

    :param timeout:
        Timeout in seconds

    :param js_abort_controller:
        A JavaScript AbortController object, used on timeout

    :param request:
        The request being handled

    :param response:
        The response being handled (if it exists yet)

    :raises _TimeoutError: If the request times out
    :raises _RequestError: If the request raises a JavaScript exception

    :return: The result of awaiting the promise.
    """
    timer_id = None
    if timeout > 0:
        timer_id = js.setTimeout(
            js_abort_controller.abort.bind(js_abort_controller), int(timeout * 1000)
        )
    try:
        from pyodide.ffi import run_sync

        # run_sync here uses WebAssembly JavaScript Promise Integration to
        # suspend python until the JavaScript promise resolves.
        return run_sync(promise)
    except JsException as err:
        if err.name == "AbortError":
            raise _TimeoutError(
                message="Request timed out", request=request, response=response
            )
        else:
            raise _RequestError(message=err.message, request=request, response=response)
    finally:
        if timer_id is not None:
            js.clearTimeout(timer_id)


def has_jspi() -> bool:
    """
    Return true if jspi can be used.

    This requires both browser support and also WebAssembly
    to be in the correct state - i.e. that the javascript
    call into python was async not sync.

    :return: True if jspi can be used.
    :rtype: bool
    """
    try:
        from pyodide.ffi import can_run_sync, run_sync  # noqa: F401

        return bool(can_run_sync())
    except ImportError:
        return False


def _is_node_js() -> bool:
    """
    Check if we are in Node.js.

    :return: True if we are in Node.js.
    :rtype: bool
    """
    return (
        hasattr(js, "process")
        and hasattr(js.process, "release")
        # According to the Node.js documentation, the release name is always "node".
        and js.process.release.name == "node"
    )


def streaming_ready() -> bool | None:
    if _fetcher:
        return _fetcher.streaming_ready
    else:
        return None  # no fetcher, return None to signify that


async def wait_for_streaming_ready() -> bool:
    if _fetcher:
        await _fetcher.js_worker_ready_promise
        return True
    else:
        return False

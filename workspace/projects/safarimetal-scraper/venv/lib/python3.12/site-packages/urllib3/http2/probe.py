from __future__ import annotations

import threading


class _HTTP2ProbeCache:
    __slots__ = (
        "_lock",
        "_cache_locks",
        "_cache_values",
    )

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache_locks: dict[tuple[str, int], threading.RLock] = {}
        self._cache_values: dict[tuple[str, int], bool | None] = {}

    def acquire_and_get(self, host: str, port: int) -> bool | None:
        # By the end of this block we know that
        # _cache_[values,locks] is available.
        value = None
        with self._lock:
            key = (host, port)
            try:
                value = self._cache_values[key]
                # If it's a known value we return right away.
                if value is not None:
                    return value
            except KeyError:
                self._cache_locks[key] = threading.RLock()
                self._cache_values[key] = None

        # If the value is unknown, we acquire the lock to signal
        # to the requesting thread that the probe is in progress
        # or that the current thread needs to return their findings.
        key_lock = self._cache_locks[key]
        key_lock.acquire()
        try:
            # If the by the time we get the lock the value has been
            # updated we want to return the updated value.
            value = self._cache_values[key]

        # In case an exception like KeyboardInterrupt is raised here.
        except BaseException as e:  # Defensive:
            assert not isinstance(e, KeyError)  # KeyError shouldn't be possible.
            key_lock.release()
            raise

        return value

    def set_and_release(
        self, host: str, port: int, supports_http2: bool | None
    ) -> None:
        key = (host, port)
        key_lock = self._cache_locks[key]
        with key_lock:  # Uses an RLock, so can be locked again from same thread.
            if supports_http2 is None and self._cache_values[key] is not None:
                raise ValueError(
                    "Cannot reset HTTP/2 support for origin after value has been set."
                )  # Defensive: not expected in normal usage

        self._cache_values[key] = supports_http2
        key_lock.release()

    def _values(self) -> dict[tuple[str, int], bool | None]:
        """This function is for testing purposes only. Gets the current state of the probe cache"""
        with self._lock:
            return {k: v for k, v in self._cache_values.items()}

    def _reset(self) -> None:
        """This function is for testing purposes only. Reset the cache values"""
        with self._lock:
            self._cache_locks = {}
            self._cache_values = {}


_HTTP2_PROBE_CACHE = _HTTP2ProbeCache()

set_and_release = _HTTP2_PROBE_CACHE.set_and_release
acquire_and_get = _HTTP2_PROBE_CACHE.acquire_and_get
_values = _HTTP2_PROBE_CACHE._values
_reset = _HTTP2_PROBE_CACHE._reset

__all__ = [
    "set_and_release",
    "acquire_and_get",
]

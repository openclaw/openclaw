from __future__ import annotations

import typing
from collections import OrderedDict
from enum import Enum, auto
from threading import RLock

if typing.TYPE_CHECKING:
    # We can only import Protocol if TYPE_CHECKING because it's a development
    # dependency, and is not available at runtime.
    from typing import Protocol

    from typing_extensions import Self

    class HasGettableStringKeys(Protocol):
        def keys(self) -> typing.Iterator[str]: ...

        def __getitem__(self, key: str) -> str: ...


__all__ = ["RecentlyUsedContainer", "HTTPHeaderDict"]


# Key type
_KT = typing.TypeVar("_KT")
# Value type
_VT = typing.TypeVar("_VT")
# Default type
_DT = typing.TypeVar("_DT")

ValidHTTPHeaderSource = typing.Union[
    "HTTPHeaderDict",
    typing.Mapping[str, str],
    typing.Iterable[tuple[str, str]],
    "HasGettableStringKeys",
]


class _Sentinel(Enum):
    not_passed = auto()


def ensure_can_construct_http_header_dict(
    potential: object,
) -> ValidHTTPHeaderSource | None:
    if isinstance(potential, HTTPHeaderDict):
        return potential
    elif isinstance(potential, typing.Mapping):
        # Full runtime checking of the contents of a Mapping is expensive, so for the
        # purposes of typechecking, we assume that any Mapping is the right shape.
        return typing.cast(typing.Mapping[str, str], potential)
    elif isinstance(potential, typing.Iterable):
        # Similarly to Mapping, full runtime checking of the contents of an Iterable is
        # expensive, so for the purposes of typechecking, we assume that any Iterable
        # is the right shape.
        return typing.cast(typing.Iterable[tuple[str, str]], potential)
    elif hasattr(potential, "keys") and hasattr(potential, "__getitem__"):
        return typing.cast("HasGettableStringKeys", potential)
    else:
        return None


class RecentlyUsedContainer(typing.Generic[_KT, _VT], typing.MutableMapping[_KT, _VT]):
    """
    Provides a thread-safe dict-like container which maintains up to
    ``maxsize`` keys while throwing away the least-recently-used keys beyond
    ``maxsize``.

    :param maxsize:
        Maximum number of recent elements to retain.

    :param dispose_func:
        Every time an item is evicted from the container,
        ``dispose_func(value)`` is called.  Callback which will get called
    """

    _container: typing.OrderedDict[_KT, _VT]
    _maxsize: int
    dispose_func: typing.Callable[[_VT], None] | None
    lock: RLock

    def __init__(
        self,
        maxsize: int = 10,
        dispose_func: typing.Callable[[_VT], None] | None = None,
    ) -> None:
        super().__init__()
        self._maxsize = maxsize
        self.dispose_func = dispose_func
        self._container = OrderedDict()
        self.lock = RLock()

    def __getitem__(self, key: _KT) -> _VT:
        # Re-insert the item, moving it to the end of the eviction line.
        with self.lock:
            item = self._container.pop(key)
            self._container[key] = item
            return item

    def __setitem__(self, key: _KT, value: _VT) -> None:
        evicted_item = None
        with self.lock:
            # Possibly evict the existing value of 'key'
            try:
                # If the key exists, we'll overwrite it, which won't change the
                # size of the pool. Because accessing a key should move it to
                # the end of the eviction line, we pop it out first.
                evicted_item = key, self._container.pop(key)
                self._container[key] = value
            except KeyError:
                # When the key does not exist, we insert the value first so that
                # evicting works in all cases, including when self._maxsize is 0
                self._container[key] = value
                if len(self._container) > self._maxsize:
                    # If we didn't evict an existing value, and we've hit our maximum
                    # size, then we have to evict the least recently used item from
                    # the beginning of the container.
                    evicted_item = self._container.popitem(last=False)

        # After releasing the lock on the pool, dispose of any evicted value.
        if evicted_item is not None and self.dispose_func:
            _, evicted_value = evicted_item
            self.dispose_func(evicted_value)

    def __delitem__(self, key: _KT) -> None:
        with self.lock:
            value = self._container.pop(key)

        if self.dispose_func:
            self.dispose_func(value)

    def __len__(self) -> int:
        with self.lock:
            return len(self._container)

    def __iter__(self) -> typing.NoReturn:
        raise NotImplementedError(
            "Iteration over this class is unlikely to be threadsafe."
        )

    def clear(self) -> None:
        with self.lock:
            # Copy pointers to all values, then wipe the mapping
            values = list(self._container.values())
            self._container.clear()

        if self.dispose_func:
            for value in values:
                self.dispose_func(value)

    def keys(self) -> set[_KT]:  # type: ignore[override]
        with self.lock:
            return set(self._container.keys())


class HTTPHeaderDictItemView(set[tuple[str, str]]):
    """
    HTTPHeaderDict is unusual for a Mapping[str, str] in that it has two modes of
    address.

    If we directly try to get an item with a particular name, we will get a string
    back that is the concatenated version of all the values:

    >>> d['X-Header-Name']
    'Value1, Value2, Value3'

    However, if we iterate over an HTTPHeaderDict's items, we will optionally combine
    these values based on whether combine=True was called when building up the dictionary

    >>> d = HTTPHeaderDict({"A": "1", "B": "foo"})
    >>> d.add("A", "2", combine=True)
    >>> d.add("B", "bar")
    >>> list(d.items())
    [
        ('A', '1, 2'),
        ('B', 'foo'),
        ('B', 'bar'),
    ]

    This class conforms to the interface required by the MutableMapping ABC while
    also giving us the nonstandard iteration behavior we want; items with duplicate
    keys, ordered by time of first insertion.
    """

    _headers: HTTPHeaderDict

    def __init__(self, headers: HTTPHeaderDict) -> None:
        self._headers = headers

    def __len__(self) -> int:
        return len(list(self._headers.iteritems()))

    def __iter__(self) -> typing.Iterator[tuple[str, str]]:
        return self._headers.iteritems()

    def __contains__(self, item: object) -> bool:
        if isinstance(item, tuple) and len(item) == 2:
            passed_key, passed_val = item
            if isinstance(passed_key, str) and isinstance(passed_val, str):
                return self._headers._has_value_for_header(passed_key, passed_val)
        return False


class HTTPHeaderDict(typing.MutableMapping[str, str]):
    """
    :param headers:
        An iterable of field-value pairs. Must not contain multiple field names
        when compared case-insensitively.

    :param kwargs:
        Additional field-value pairs to pass in to ``dict.update``.

    A ``dict`` like container for storing HTTP Headers.

    Field names are stored and compared case-insensitively in compliance with
    RFC 7230. Iteration provides the first case-sensitive key seen for each
    case-insensitive pair.

    Using ``__setitem__`` syntax overwrites fields that compare equal
    case-insensitively in order to maintain ``dict``'s api. For fields that
    compare equal, instead create a new ``HTTPHeaderDict`` and use ``.add``
    in a loop.

    If multiple fields that are equal case-insensitively are passed to the
    constructor or ``.update``, the behavior is undefined and some will be
    lost.

    >>> headers = HTTPHeaderDict()
    >>> headers.add('Set-Cookie', 'foo=bar')
    >>> headers.add('set-cookie', 'baz=quxx')
    >>> headers['content-length'] = '7'
    >>> headers['SET-cookie']
    'foo=bar, baz=quxx'
    >>> headers['Content-Length']
    '7'
    """

    _container: typing.MutableMapping[str, list[str]]

    def __init__(self, headers: ValidHTTPHeaderSource | None = None, **kwargs: str):
        super().__init__()
        self._container = {}  # 'dict' is insert-ordered
        if headers is not None:
            if isinstance(headers, HTTPHeaderDict):
                self._copy_from(headers)
            else:
                self.extend(headers)
        if kwargs:
            self.extend(kwargs)

    def __setitem__(self, key: str, val: str) -> None:
        # avoid a bytes/str comparison by decoding before httplib
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        self._container[key.lower()] = [key, val]

    def __getitem__(self, key: str) -> str:
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        val = self._container[key.lower()]
        return ", ".join(val[1:])

    def __delitem__(self, key: str) -> None:
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        del self._container[key.lower()]

    def __contains__(self, key: object) -> bool:
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        if isinstance(key, str):
            return key.lower() in self._container
        return False

    def setdefault(self, key: str, default: str = "") -> str:
        return super().setdefault(key, default)

    def __eq__(self, other: object) -> bool:
        maybe_constructable = ensure_can_construct_http_header_dict(other)
        if maybe_constructable is None:
            return False
        else:
            other_as_http_header_dict = type(self)(maybe_constructable)

        return {k.lower(): v for k, v in self.itermerged()} == {
            k.lower(): v for k, v in other_as_http_header_dict.itermerged()
        }

    def __ne__(self, other: object) -> bool:
        return not self.__eq__(other)

    def __len__(self) -> int:
        return len(self._container)

    def __iter__(self) -> typing.Iterator[str]:
        # Only provide the originally cased names
        for vals in self._container.values():
            yield vals[0]

    def discard(self, key: str) -> None:
        try:
            del self[key]
        except KeyError:
            pass

    def add(self, key: str, val: str, *, combine: bool = False) -> None:
        """Adds a (name, value) pair, doesn't overwrite the value if it already
        exists.

        If this is called with combine=True, instead of adding a new header value
        as a distinct item during iteration, this will instead append the value to
        any existing header value with a comma. If no existing header value exists
        for the key, then the value will simply be added, ignoring the combine parameter.

        >>> headers = HTTPHeaderDict(foo='bar')
        >>> headers.add('Foo', 'baz')
        >>> headers['foo']
        'bar, baz'
        >>> list(headers.items())
        [('foo', 'bar'), ('foo', 'baz')]
        >>> headers.add('foo', 'quz', combine=True)
        >>> list(headers.items())
        [('foo', 'bar, baz, quz')]
        """
        # avoid a bytes/str comparison by decoding before httplib
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        key_lower = key.lower()
        new_vals = [key, val]
        # Keep the common case aka no item present as fast as possible
        vals = self._container.setdefault(key_lower, new_vals)
        if new_vals is not vals:
            # if there are values here, then there is at least the initial
            # key/value pair
            assert len(vals) >= 2
            if combine:
                vals[-1] = vals[-1] + ", " + val
            else:
                vals.append(val)

    def extend(self, *args: ValidHTTPHeaderSource, **kwargs: str) -> None:
        """Generic import function for any type of header-like object.
        Adapted version of MutableMapping.update in order to insert items
        with self.add instead of self.__setitem__
        """
        if len(args) > 1:
            raise TypeError(
                f"extend() takes at most 1 positional arguments ({len(args)} given)"
            )
        other = args[0] if len(args) >= 1 else ()

        if isinstance(other, HTTPHeaderDict):
            for key, val in other.iteritems():
                self.add(key, val)
        elif isinstance(other, typing.Mapping):
            for key, val in other.items():
                self.add(key, val)
        elif isinstance(other, typing.Iterable):
            other = typing.cast(typing.Iterable[tuple[str, str]], other)
            for key, value in other:
                self.add(key, value)
        elif hasattr(other, "keys") and hasattr(other, "__getitem__"):
            # THIS IS NOT A TYPESAFE BRANCH
            # In this branch, the object has a `keys` attr but is not a Mapping or any of
            # the other types indicated in the method signature. We do some stuff with
            # it as though it partially implements the Mapping interface, but we're not
            # doing that stuff safely AT ALL.
            for key in other.keys():
                self.add(key, other[key])

        for key, value in kwargs.items():
            self.add(key, value)

    @typing.overload
    def getlist(self, key: str) -> list[str]: ...

    @typing.overload
    def getlist(self, key: str, default: _DT) -> list[str] | _DT: ...

    def getlist(
        self, key: str, default: _Sentinel | _DT = _Sentinel.not_passed
    ) -> list[str] | _DT:
        """Returns a list of all the values for the named field. Returns an
        empty list if the key doesn't exist."""
        if isinstance(key, bytes):
            key = key.decode("latin-1")
        try:
            vals = self._container[key.lower()]
        except KeyError:
            if default is _Sentinel.not_passed:
                # _DT is unbound; empty list is instance of List[str]
                return []
            # _DT is bound; default is instance of _DT
            return default
        else:
            # _DT may or may not be bound; vals[1:] is instance of List[str], which
            # meets our external interface requirement of `Union[List[str], _DT]`.
            return vals[1:]

    def _prepare_for_method_change(self) -> Self:
        """
        Remove content-specific header fields before changing the request
        method to GET or HEAD according to RFC 9110, Section 15.4.
        """
        content_specific_headers = [
            "Content-Encoding",
            "Content-Language",
            "Content-Location",
            "Content-Type",
            "Content-Length",
            "Digest",
            "Last-Modified",
        ]
        for header in content_specific_headers:
            self.discard(header)
        return self

    # Backwards compatibility for httplib
    getheaders = getlist
    getallmatchingheaders = getlist
    iget = getlist

    # Backwards compatibility for http.cookiejar
    get_all = getlist

    def __repr__(self) -> str:
        return f"{type(self).__name__}({dict(self.itermerged())})"

    def _copy_from(self, other: HTTPHeaderDict) -> None:
        for key in other:
            val = other.getlist(key)
            self._container[key.lower()] = [key, *val]

    def copy(self) -> Self:
        clone = type(self)()
        clone._copy_from(self)
        return clone

    def iteritems(self) -> typing.Iterator[tuple[str, str]]:
        """Iterate over all header lines, including duplicate ones."""
        for key in self:
            vals = self._container[key.lower()]
            for val in vals[1:]:
                yield vals[0], val

    def itermerged(self) -> typing.Iterator[tuple[str, str]]:
        """Iterate over all headers, merging duplicate ones together."""
        for key in self:
            val = self._container[key.lower()]
            yield val[0], ", ".join(val[1:])

    def items(self) -> HTTPHeaderDictItemView:  # type: ignore[override]
        return HTTPHeaderDictItemView(self)

    def _has_value_for_header(self, header_name: str, potential_value: str) -> bool:
        if header_name in self:
            return potential_value in self._container[header_name.lower()][1:]
        return False

    def __ior__(self, other: object) -> HTTPHeaderDict:
        # Supports extending a header dict in-place using operator |=
        # combining items with add instead of __setitem__
        maybe_constructable = ensure_can_construct_http_header_dict(other)
        if maybe_constructable is None:
            return NotImplemented
        self.extend(maybe_constructable)
        return self

    def __or__(self, other: object) -> Self:
        # Supports merging header dicts using operator |
        # combining items with add instead of __setitem__
        maybe_constructable = ensure_can_construct_http_header_dict(other)
        if maybe_constructable is None:
            return NotImplemented
        result = self.copy()
        result.extend(maybe_constructable)
        return result

    def __ror__(self, other: object) -> Self:
        # Supports merging header dicts using operator | when other is on left side
        # combining items with add instead of __setitem__
        maybe_constructable = ensure_can_construct_http_header_dict(other)
        if maybe_constructable is None:
            return NotImplemented
        result = type(self)(maybe_constructable)
        result.extend(self)
        return result

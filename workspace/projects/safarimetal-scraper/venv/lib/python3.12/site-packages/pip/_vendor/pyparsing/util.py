# util.py
import inspect
import warnings
import types
import collections
import itertools
from functools import lru_cache, wraps
from typing import Callable, List, Union, Iterable, TypeVar, cast

_bslash = chr(92)
C = TypeVar("C", bound=Callable)


class __config_flags:
    """Internal class for defining compatibility and debugging flags"""

    _all_names: List[str] = []
    _fixed_names: List[str] = []
    _type_desc = "configuration"

    @classmethod
    def _set(cls, dname, value):
        if dname in cls._fixed_names:
            warnings.warn(
                f"{cls.__name__}.{dname} {cls._type_desc} is {str(getattr(cls, dname)).upper()}"
                f" and cannot be overridden",
                stacklevel=3,
            )
            return
        if dname in cls._all_names:
            setattr(cls, dname, value)
        else:
            raise ValueError(f"no such {cls._type_desc} {dname!r}")

    enable = classmethod(lambda cls, name: cls._set(name, True))
    disable = classmethod(lambda cls, name: cls._set(name, False))


@lru_cache(maxsize=128)
def col(loc: int, strg: str) -> int:
    """
    Returns current column within a string, counting newlines as line separators.
    The first column is number 1.

    Note: the default parsing behavior is to expand tabs in the input string
    before starting the parsing process.  See
    :class:`ParserElement.parse_string` for more
    information on parsing strings containing ``<TAB>`` s, and suggested
    methods to maintain a consistent view of the parsed string, the parse
    location, and line and column positions within the parsed string.
    """
    s = strg
    return 1 if 0 < loc < len(s) and s[loc - 1] == "\n" else loc - s.rfind("\n", 0, loc)


@lru_cache(maxsize=128)
def lineno(loc: int, strg: str) -> int:
    """Returns current line number within a string, counting newlines as line separators.
    The first line is number 1.

    Note - the default parsing behavior is to expand tabs in the input string
    before starting the parsing process.  See :class:`ParserElement.parse_string`
    for more information on parsing strings containing ``<TAB>`` s, and
    suggested methods to maintain a consistent view of the parsed string, the
    parse location, and line and column positions within the parsed string.
    """
    return strg.count("\n", 0, loc) + 1


@lru_cache(maxsize=128)
def line(loc: int, strg: str) -> str:
    """
    Returns the line of text containing loc within a string, counting newlines as line separators.
    """
    last_cr = strg.rfind("\n", 0, loc)
    next_cr = strg.find("\n", loc)
    return strg[last_cr + 1 : next_cr] if next_cr >= 0 else strg[last_cr + 1 :]


class _UnboundedCache:
    def __init__(self):
        cache = {}
        cache_get = cache.get
        self.not_in_cache = not_in_cache = object()

        def get(_, key):
            return cache_get(key, not_in_cache)

        def set_(_, key, value):
            cache[key] = value

        def clear(_):
            cache.clear()

        self.size = None
        self.get = types.MethodType(get, self)
        self.set = types.MethodType(set_, self)
        self.clear = types.MethodType(clear, self)


class _FifoCache:
    def __init__(self, size):
        self.not_in_cache = not_in_cache = object()
        cache = {}
        keyring = [object()] * size
        cache_get = cache.get
        cache_pop = cache.pop
        keyiter = itertools.cycle(range(size))

        def get(_, key):
            return cache_get(key, not_in_cache)

        def set_(_, key, value):
            cache[key] = value
            i = next(keyiter)
            cache_pop(keyring[i], None)
            keyring[i] = key

        def clear(_):
            cache.clear()
            keyring[:] = [object()] * size

        self.size = size
        self.get = types.MethodType(get, self)
        self.set = types.MethodType(set_, self)
        self.clear = types.MethodType(clear, self)


class LRUMemo:
    """
    A memoizing mapping that retains `capacity` deleted items

    The memo tracks retained items by their access order; once `capacity` items
    are retained, the least recently used item is discarded.
    """

    def __init__(self, capacity):
        self._capacity = capacity
        self._active = {}
        self._memory = collections.OrderedDict()

    def __getitem__(self, key):
        try:
            return self._active[key]
        except KeyError:
            self._memory.move_to_end(key)
            return self._memory[key]

    def __setitem__(self, key, value):
        self._memory.pop(key, None)
        self._active[key] = value

    def __delitem__(self, key):
        try:
            value = self._active.pop(key)
        except KeyError:
            pass
        else:
            while len(self._memory) >= self._capacity:
                self._memory.popitem(last=False)
            self._memory[key] = value

    def clear(self):
        self._active.clear()
        self._memory.clear()


class UnboundedMemo(dict):
    """
    A memoizing mapping that retains all deleted items
    """

    def __delitem__(self, key):
        pass


def _escape_regex_range_chars(s: str) -> str:
    # escape these chars: ^-[]
    for c in r"\^-[]":
        s = s.replace(c, _bslash + c)
    s = s.replace("\n", r"\n")
    s = s.replace("\t", r"\t")
    return str(s)


def _collapse_string_to_ranges(
    s: Union[str, Iterable[str]], re_escape: bool = True
) -> str:
    def is_consecutive(c):
        c_int = ord(c)
        is_consecutive.prev, prev = c_int, is_consecutive.prev
        if c_int - prev > 1:
            is_consecutive.value = next(is_consecutive.counter)
        return is_consecutive.value

    is_consecutive.prev = 0  # type: ignore [attr-defined]
    is_consecutive.counter = itertools.count()  # type: ignore [attr-defined]
    is_consecutive.value = -1  # type: ignore [attr-defined]

    def escape_re_range_char(c):
        return "\\" + c if c in r"\^-][" else c

    def no_escape_re_range_char(c):
        return c

    if not re_escape:
        escape_re_range_char = no_escape_re_range_char

    ret = []
    s = "".join(sorted(set(s)))
    if len(s) > 3:
        for _, chars in itertools.groupby(s, key=is_consecutive):
            first = last = next(chars)
            last = collections.deque(
                itertools.chain(iter([last]), chars), maxlen=1
            ).pop()
            if first == last:
                ret.append(escape_re_range_char(first))
            else:
                sep = "" if ord(last) == ord(first) + 1 else "-"
                ret.append(
                    f"{escape_re_range_char(first)}{sep}{escape_re_range_char(last)}"
                )
    else:
        ret = [escape_re_range_char(c) for c in s]

    return "".join(ret)


def _flatten(ll: list) -> list:
    ret = []
    for i in ll:
        if isinstance(i, list):
            ret.extend(_flatten(i))
        else:
            ret.append(i)
    return ret


def _make_synonym_function(compat_name: str, fn: C) -> C:
    # In a future version, uncomment the code in the internal _inner() functions
    # to begin emitting DeprecationWarnings.

    # Unwrap staticmethod/classmethod
    fn = getattr(fn, "__func__", fn)

    # (Presence of 'self' arg in signature is used by explain_exception() methods, so we take
    # some extra steps to add it if present in decorated function.)
    if "self" == list(inspect.signature(fn).parameters)[0]:

        @wraps(fn)
        def _inner(self, *args, **kwargs):
            # warnings.warn(
            #     f"Deprecated - use {fn.__name__}", DeprecationWarning, stacklevel=3
            # )
            return fn(self, *args, **kwargs)

    else:

        @wraps(fn)
        def _inner(*args, **kwargs):
            # warnings.warn(
            #     f"Deprecated - use {fn.__name__}", DeprecationWarning, stacklevel=3
            # )
            return fn(*args, **kwargs)

    _inner.__doc__ = f"""Deprecated - use :class:`{fn.__name__}`"""
    _inner.__name__ = compat_name
    _inner.__annotations__ = fn.__annotations__
    if isinstance(fn, types.FunctionType):
        _inner.__kwdefaults__ = fn.__kwdefaults__
    elif isinstance(fn, type) and hasattr(fn, "__init__"):
        _inner.__kwdefaults__ = fn.__init__.__kwdefaults__
    else:
        _inner.__kwdefaults__ = None
    _inner.__qualname__ = fn.__qualname__
    return cast(C, _inner)


def replaced_by_pep8(fn: C) -> Callable[[Callable], C]:
    """
    Decorator for pre-PEP8 compatibility synonyms, to link them to the new function.
    """
    return lambda other: _make_synonym_function(other.__name__, fn)

"""Utility."""
from __future__ import annotations
from functools import wraps, lru_cache
import warnings
import re
from typing import Callable, Any

DEBUG = 0x00001

RE_PATTERN_LINE_SPLIT = re.compile(r'(?:\r\n|(?!\r\n)[\n\r])|$')

UC_A = ord('A')
UC_Z = ord('Z')


@lru_cache(maxsize=512)
def lower(string: str) -> str:
    """Lower."""

    new_string = []
    for c in string:
        o = ord(c)
        new_string.append(chr(o + 32) if UC_A <= o <= UC_Z else c)
    return ''.join(new_string)


class SelectorSyntaxError(Exception):
    """Syntax error in a CSS selector."""

    def __init__(self, msg: str, pattern: str | None = None, index: int | None = None) -> None:
        """Initialize."""

        self.line = None
        self.col = None
        self.context = None

        if pattern is not None and index is not None:
            # Format pattern to show line and column position
            self.context, self.line, self.col = get_pattern_context(pattern, index)
            msg = f'{msg}\n  line {self.line}:\n{self.context}'

        super().__init__(msg)


def deprecated(message: str, stacklevel: int = 2) -> Callable[..., Any]:  # pragma: no cover
    """
    Raise a `DeprecationWarning` when wrapped function/method is called.

    Usage:

        @deprecated("This method will be removed in version X; use Y instead.")
        def some_method()"
            pass
    """

    def _wrapper(func: Callable[..., Any]) -> Callable[..., Any]:
        @wraps(func)
        def _deprecated_func(*args: Any, **kwargs: Any) -> Any:
            warnings.warn(
                f"'{func.__name__}' is deprecated. {message}",
                category=DeprecationWarning,
                stacklevel=stacklevel
            )
            return func(*args, **kwargs)
        return _deprecated_func
    return _wrapper


def warn_deprecated(message: str, stacklevel: int = 2) -> None:  # pragma: no cover
    """Warn deprecated."""

    warnings.warn(
        message,
        category=DeprecationWarning,
        stacklevel=stacklevel
    )


def get_pattern_context(pattern: str, index: int) -> tuple[str, int, int]:
    """Get the pattern context."""

    last = 0
    current_line = 1
    col = 1
    text = []  # type: list[str]
    line = 1
    offset = None  # type: int | None

    # Split pattern by newline and handle the text before the newline
    for m in RE_PATTERN_LINE_SPLIT.finditer(pattern):
        linetext = pattern[last:m.start(0)]
        if not len(m.group(0)) and not len(text):
            indent = ''
            offset = -1
            col = index - last + 1
        elif last <= index < m.end(0):
            indent = '--> '
            offset = (-1 if index > m.start(0) else 0) + 3
            col = index - last + 1
        else:
            indent = '    '
            offset = None
        if len(text):
            # Regardless of whether we are presented with `\r\n`, `\r`, or `\n`,
            # we will render the output with just `\n`. We will still log the column
            # correctly though.
            text.append('\n')
        text.append(f'{indent}{linetext}')
        if offset is not None:
            text.append('\n')
            text.append(' ' * (col + offset) + '^')
            line = current_line

        current_line += 1
        last = m.end(0)

    return ''.join(text), line, col

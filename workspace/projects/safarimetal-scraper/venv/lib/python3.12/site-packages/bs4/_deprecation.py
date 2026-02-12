"""Helper functions for deprecation.

This interface is itself unstable and may change without warning. Do
not use these functions yourself, even as a joke. The underscores are
there for a reason. No support will be given.

In particular, most of this will go away without warning once
Beautiful Soup drops support for Python 3.11, since Python 3.12
defines a `@typing.deprecated()
decorator. <https://peps.python.org/pep-0702/>`_
"""

import functools
import warnings

from typing import (
    Any,
    Callable,
)


def _deprecated_alias(old_name: str, new_name: str, version: str):
    """Alias one attribute name to another for backward compatibility

    :meta private:
    """

    @property # type:ignore
    def alias(self) -> Any:
        ":meta private:"
        warnings.warn(
            f"Access to deprecated property {old_name}. (Replaced by {new_name}) -- Deprecated since version {version}.",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(self, new_name)

    @alias.setter
    def alias(self, value: str) -> None:
        ":meta private:"
        warnings.warn(
            f"Write to deprecated property {old_name}. (Replaced by {new_name}) -- Deprecated since version {version}.",
            DeprecationWarning,
            stacklevel=2,
        )
        return setattr(self, new_name, value)

    return alias


def _deprecated_function_alias(
    old_name: str, new_name: str, version: str
) -> Callable[[Any], Any]:
    def alias(self, *args: Any, **kwargs: Any) -> Any:
        ":meta private:"
        warnings.warn(
            f"Call to deprecated method {old_name}. (Replaced by {new_name}) -- Deprecated since version {version}.",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(self, new_name)(*args, **kwargs)

    return alias


def _deprecated(replaced_by: str, version: str) -> Callable:
    def deprecate(func: Callable) -> Callable:
        @functools.wraps(func)
        def with_warning(*args: Any, **kwargs: Any) -> Any:
            ":meta private:"
            warnings.warn(
                f"Call to deprecated method {func.__name__}. (Replaced by {replaced_by}) -- Deprecated since version {version}.",
                DeprecationWarning,
                stacklevel=2,
            )
            return func(*args, **kwargs)

        return with_warning

    return deprecate

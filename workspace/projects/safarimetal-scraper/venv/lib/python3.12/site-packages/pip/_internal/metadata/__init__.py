import contextlib
import functools
import os
import sys
from typing import TYPE_CHECKING, List, Optional, Type, cast

from pip._internal.utils.misc import strtobool

from .base import BaseDistribution, BaseEnvironment, FilesystemWheel, MemoryWheel, Wheel

if TYPE_CHECKING:
    from typing import Literal, Protocol
else:
    Protocol = object

__all__ = [
    "BaseDistribution",
    "BaseEnvironment",
    "FilesystemWheel",
    "MemoryWheel",
    "Wheel",
    "get_default_environment",
    "get_environment",
    "get_wheel_distribution",
    "select_backend",
]


def _should_use_importlib_metadata() -> bool:
    """Whether to use the ``importlib.metadata`` or ``pkg_resources`` backend.

    By default, pip uses ``importlib.metadata`` on Python 3.11+, and
    ``pkg_resourcess`` otherwise. This can be overridden by a couple of ways:

    * If environment variable ``_PIP_USE_IMPORTLIB_METADATA`` is set, it
      dictates whether ``importlib.metadata`` is used, regardless of Python
      version.
    * On Python 3.11+, Python distributors can patch ``importlib.metadata``
      to add a global constant ``_PIP_USE_IMPORTLIB_METADATA = False``. This
      makes pip use ``pkg_resources`` (unless the user set the aforementioned
      environment variable to *True*).
    """
    with contextlib.suppress(KeyError, ValueError):
        return bool(strtobool(os.environ["_PIP_USE_IMPORTLIB_METADATA"]))
    if sys.version_info < (3, 11):
        return False
    import importlib.metadata

    return bool(getattr(importlib.metadata, "_PIP_USE_IMPORTLIB_METADATA", True))


class Backend(Protocol):
    NAME: 'Literal["importlib", "pkg_resources"]'
    Distribution: Type[BaseDistribution]
    Environment: Type[BaseEnvironment]


@functools.lru_cache(maxsize=None)
def select_backend() -> Backend:
    if _should_use_importlib_metadata():
        from . import importlib

        return cast(Backend, importlib)
    from . import pkg_resources

    return cast(Backend, pkg_resources)


def get_default_environment() -> BaseEnvironment:
    """Get the default representation for the current environment.

    This returns an Environment instance from the chosen backend. The default
    Environment instance should be built from ``sys.path`` and may use caching
    to share instance state accorss calls.
    """
    return select_backend().Environment.default()


def get_environment(paths: Optional[List[str]]) -> BaseEnvironment:
    """Get a representation of the environment specified by ``paths``.

    This returns an Environment instance from the chosen backend based on the
    given import paths. The backend must build a fresh instance representing
    the state of installed distributions when this function is called.
    """
    return select_backend().Environment.from_paths(paths)


def get_directory_distribution(directory: str) -> BaseDistribution:
    """Get the distribution metadata representation in the specified directory.

    This returns a Distribution instance from the chosen backend based on
    the given on-disk ``.dist-info`` directory.
    """
    return select_backend().Distribution.from_directory(directory)


def get_wheel_distribution(wheel: Wheel, canonical_name: str) -> BaseDistribution:
    """Get the representation of the specified wheel's distribution metadata.

    This returns a Distribution instance from the chosen backend based on
    the given wheel's ``.dist-info`` directory.

    :param canonical_name: Normalized project name of the given wheel.
    """
    return select_backend().Distribution.from_wheel(wheel, canonical_name)


def get_metadata_distribution(
    metadata_contents: bytes,
    filename: str,
    canonical_name: str,
) -> BaseDistribution:
    """Get the dist representation of the specified METADATA file contents.

    This returns a Distribution instance from the chosen backend sourced from the data
    in `metadata_contents`.

    :param metadata_contents: Contents of a METADATA file within a dist, or one served
                              via PEP 658.
    :param filename: Filename for the dist this metadata represents.
    :param canonical_name: Normalized project name of the given dist.
    """
    return select_backend().Distribution.from_metadata_file_contents(
        metadata_contents,
        filename,
        canonical_name,
    )

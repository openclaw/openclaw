import functools
import importlib.metadata
import logging
import os
import pathlib
import sys
import zipfile
import zipimport
from typing import Iterator, List, Optional, Sequence, Set, Tuple

from pip._vendor.packaging.utils import NormalizedName, canonicalize_name

from pip._internal.metadata.base import BaseDistribution, BaseEnvironment
from pip._internal.models.wheel import Wheel
from pip._internal.utils.deprecation import deprecated
from pip._internal.utils.filetypes import WHEEL_EXTENSION

from ._compat import BadMetadata, BasePath, get_dist_name, get_info_location
from ._dists import Distribution

logger = logging.getLogger(__name__)


def _looks_like_wheel(location: str) -> bool:
    if not location.endswith(WHEEL_EXTENSION):
        return False
    if not os.path.isfile(location):
        return False
    if not Wheel.wheel_file_re.match(os.path.basename(location)):
        return False
    return zipfile.is_zipfile(location)


class _DistributionFinder:
    """Finder to locate distributions.

    The main purpose of this class is to memoize found distributions' names, so
    only one distribution is returned for each package name. At lot of pip code
    assumes this (because it is setuptools's behavior), and not doing the same
    can potentially cause a distribution in lower precedence path to override a
    higher precedence one if the caller is not careful.

    Eventually we probably want to make it possible to see lower precedence
    installations as well. It's useful feature, after all.
    """

    FoundResult = Tuple[importlib.metadata.Distribution, Optional[BasePath]]

    def __init__(self) -> None:
        self._found_names: Set[NormalizedName] = set()

    def _find_impl(self, location: str) -> Iterator[FoundResult]:
        """Find distributions in a location."""
        # Skip looking inside a wheel. Since a package inside a wheel is not
        # always valid (due to .data directories etc.), its .dist-info entry
        # should not be considered an installed distribution.
        if _looks_like_wheel(location):
            return
        # To know exactly where we find a distribution, we have to feed in the
        # paths one by one, instead of dumping the list to importlib.metadata.
        for dist in importlib.metadata.distributions(path=[location]):
            info_location = get_info_location(dist)
            try:
                raw_name = get_dist_name(dist)
            except BadMetadata as e:
                logger.warning("Skipping %s due to %s", info_location, e.reason)
                continue
            normalized_name = canonicalize_name(raw_name)
            if normalized_name in self._found_names:
                continue
            self._found_names.add(normalized_name)
            yield dist, info_location

    def find(self, location: str) -> Iterator[BaseDistribution]:
        """Find distributions in a location.

        The path can be either a directory, or a ZIP archive.
        """
        for dist, info_location in self._find_impl(location):
            if info_location is None:
                installed_location: Optional[BasePath] = None
            else:
                installed_location = info_location.parent
            yield Distribution(dist, info_location, installed_location)

    def find_linked(self, location: str) -> Iterator[BaseDistribution]:
        """Read location in egg-link files and return distributions in there.

        The path should be a directory; otherwise this returns nothing. This
        follows how setuptools does this for compatibility. The first non-empty
        line in the egg-link is read as a path (resolved against the egg-link's
        containing directory if relative). Distributions found at that linked
        location are returned.
        """
        path = pathlib.Path(location)
        if not path.is_dir():
            return
        for child in path.iterdir():
            if child.suffix != ".egg-link":
                continue
            with child.open() as f:
                lines = (line.strip() for line in f)
                target_rel = next((line for line in lines if line), "")
            if not target_rel:
                continue
            target_location = str(path.joinpath(target_rel))
            for dist, info_location in self._find_impl(target_location):
                yield Distribution(dist, info_location, path)

    def _find_eggs_in_dir(self, location: str) -> Iterator[BaseDistribution]:
        from pip._vendor.pkg_resources import find_distributions

        from pip._internal.metadata import pkg_resources as legacy

        with os.scandir(location) as it:
            for entry in it:
                if not entry.name.endswith(".egg"):
                    continue
                for dist in find_distributions(entry.path):
                    yield legacy.Distribution(dist)

    def _find_eggs_in_zip(self, location: str) -> Iterator[BaseDistribution]:
        from pip._vendor.pkg_resources import find_eggs_in_zip

        from pip._internal.metadata import pkg_resources as legacy

        try:
            importer = zipimport.zipimporter(location)
        except zipimport.ZipImportError:
            return
        for dist in find_eggs_in_zip(importer, location):
            yield legacy.Distribution(dist)

    def find_eggs(self, location: str) -> Iterator[BaseDistribution]:
        """Find eggs in a location.

        This actually uses the old *pkg_resources* backend. We likely want to
        deprecate this so we can eventually remove the *pkg_resources*
        dependency entirely. Before that, this should first emit a deprecation
        warning for some versions when using the fallback since importing
        *pkg_resources* is slow for those who don't need it.
        """
        if os.path.isdir(location):
            yield from self._find_eggs_in_dir(location)
        if zipfile.is_zipfile(location):
            yield from self._find_eggs_in_zip(location)


@functools.lru_cache(maxsize=None)  # Warn a distribution exactly once.
def _emit_egg_deprecation(location: Optional[str]) -> None:
    deprecated(
        reason=f"Loading egg at {location} is deprecated.",
        replacement="to use pip for package installation.",
        gone_in="24.3",
        issue=12330,
    )


class Environment(BaseEnvironment):
    def __init__(self, paths: Sequence[str]) -> None:
        self._paths = paths

    @classmethod
    def default(cls) -> BaseEnvironment:
        return cls(sys.path)

    @classmethod
    def from_paths(cls, paths: Optional[List[str]]) -> BaseEnvironment:
        if paths is None:
            return cls(sys.path)
        return cls(paths)

    def _iter_distributions(self) -> Iterator[BaseDistribution]:
        finder = _DistributionFinder()
        for location in self._paths:
            yield from finder.find(location)
            for dist in finder.find_eggs(location):
                _emit_egg_deprecation(dist.location)
                yield dist
            # This must go last because that's how pkg_resources tie-breaks.
            yield from finder.find_linked(location)

    def get_distribution(self, name: str) -> Optional[BaseDistribution]:
        matches = (
            distribution
            for distribution in self.iter_all_distributions()
            if distribution.canonical_name == canonicalize_name(name)
        )
        return next(matches, None)

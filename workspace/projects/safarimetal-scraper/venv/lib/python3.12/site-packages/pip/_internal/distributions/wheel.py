from typing import Optional

from pip._vendor.packaging.utils import canonicalize_name

from pip._internal.distributions.base import AbstractDistribution
from pip._internal.index.package_finder import PackageFinder
from pip._internal.metadata import (
    BaseDistribution,
    FilesystemWheel,
    get_wheel_distribution,
)


class WheelDistribution(AbstractDistribution):
    """Represents a wheel distribution.

    This does not need any preparation as wheels can be directly unpacked.
    """

    @property
    def build_tracker_id(self) -> Optional[str]:
        return None

    def get_metadata_distribution(self) -> BaseDistribution:
        """Loads the metadata from the wheel file into memory and returns a
        Distribution that uses it, not relying on the wheel file or
        requirement.
        """
        assert self.req.local_file_path, "Set as part of preparation during download"
        assert self.req.name, "Wheels are never unnamed"
        wheel = FilesystemWheel(self.req.local_file_path)
        return get_wheel_distribution(wheel, canonicalize_name(self.req.name))

    def prepare_distribution_metadata(
        self,
        finder: PackageFinder,
        build_isolation: bool,
        check_build_deps: bool,
    ) -> None:
        pass

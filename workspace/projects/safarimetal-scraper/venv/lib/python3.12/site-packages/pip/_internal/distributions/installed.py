from typing import Optional

from pip._internal.distributions.base import AbstractDistribution
from pip._internal.index.package_finder import PackageFinder
from pip._internal.metadata import BaseDistribution


class InstalledDistribution(AbstractDistribution):
    """Represents an installed package.

    This does not need any preparation as the required information has already
    been computed.
    """

    @property
    def build_tracker_id(self) -> Optional[str]:
        return None

    def get_metadata_distribution(self) -> BaseDistribution:
        assert self.req.satisfied_by is not None, "not actually installed"
        return self.req.satisfied_by

    def prepare_distribution_metadata(
        self,
        finder: PackageFinder,
        build_isolation: bool,
        check_build_deps: bool,
    ) -> None:
        pass

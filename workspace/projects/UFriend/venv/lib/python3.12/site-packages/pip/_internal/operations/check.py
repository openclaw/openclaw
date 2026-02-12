"""Validation of dependencies of packages
"""

import logging
from typing import Callable, Dict, List, NamedTuple, Optional, Set, Tuple

from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.specifiers import LegacySpecifier
from pip._vendor.packaging.utils import NormalizedName, canonicalize_name
from pip._vendor.packaging.version import LegacyVersion

from pip._internal.distributions import make_distribution_for_install_requirement
from pip._internal.metadata import get_default_environment
from pip._internal.metadata.base import DistributionVersion
from pip._internal.req.req_install import InstallRequirement
from pip._internal.utils.deprecation import deprecated

logger = logging.getLogger(__name__)


class PackageDetails(NamedTuple):
    version: DistributionVersion
    dependencies: List[Requirement]


# Shorthands
PackageSet = Dict[NormalizedName, PackageDetails]
Missing = Tuple[NormalizedName, Requirement]
Conflicting = Tuple[NormalizedName, DistributionVersion, Requirement]

MissingDict = Dict[NormalizedName, List[Missing]]
ConflictingDict = Dict[NormalizedName, List[Conflicting]]
CheckResult = Tuple[MissingDict, ConflictingDict]
ConflictDetails = Tuple[PackageSet, CheckResult]


def create_package_set_from_installed() -> Tuple[PackageSet, bool]:
    """Converts a list of distributions into a PackageSet."""
    package_set = {}
    problems = False
    env = get_default_environment()
    for dist in env.iter_installed_distributions(local_only=False, skip=()):
        name = dist.canonical_name
        try:
            dependencies = list(dist.iter_dependencies())
            package_set[name] = PackageDetails(dist.version, dependencies)
        except (OSError, ValueError) as e:
            # Don't crash on unreadable or broken metadata.
            logger.warning("Error parsing requirements for %s: %s", name, e)
            problems = True
    return package_set, problems


def check_package_set(
    package_set: PackageSet, should_ignore: Optional[Callable[[str], bool]] = None
) -> CheckResult:
    """Check if a package set is consistent

    If should_ignore is passed, it should be a callable that takes a
    package name and returns a boolean.
    """

    warn_legacy_versions_and_specifiers(package_set)

    missing = {}
    conflicting = {}

    for package_name, package_detail in package_set.items():
        # Info about dependencies of package_name
        missing_deps: Set[Missing] = set()
        conflicting_deps: Set[Conflicting] = set()

        if should_ignore and should_ignore(package_name):
            continue

        for req in package_detail.dependencies:
            name = canonicalize_name(req.name)

            # Check if it's missing
            if name not in package_set:
                missed = True
                if req.marker is not None:
                    missed = req.marker.evaluate({"extra": ""})
                if missed:
                    missing_deps.add((name, req))
                continue

            # Check if there's a conflict
            version = package_set[name].version
            if not req.specifier.contains(version, prereleases=True):
                conflicting_deps.add((name, version, req))

        if missing_deps:
            missing[package_name] = sorted(missing_deps, key=str)
        if conflicting_deps:
            conflicting[package_name] = sorted(conflicting_deps, key=str)

    return missing, conflicting


def check_install_conflicts(to_install: List[InstallRequirement]) -> ConflictDetails:
    """For checking if the dependency graph would be consistent after \
    installing given requirements
    """
    # Start from the current state
    package_set, _ = create_package_set_from_installed()
    # Install packages
    would_be_installed = _simulate_installation_of(to_install, package_set)

    # Only warn about directly-dependent packages; create a whitelist of them
    whitelist = _create_whitelist(would_be_installed, package_set)

    return (
        package_set,
        check_package_set(
            package_set, should_ignore=lambda name: name not in whitelist
        ),
    )


def _simulate_installation_of(
    to_install: List[InstallRequirement], package_set: PackageSet
) -> Set[NormalizedName]:
    """Computes the version of packages after installing to_install."""
    # Keep track of packages that were installed
    installed = set()

    # Modify it as installing requirement_set would (assuming no errors)
    for inst_req in to_install:
        abstract_dist = make_distribution_for_install_requirement(inst_req)
        dist = abstract_dist.get_metadata_distribution()
        name = dist.canonical_name
        package_set[name] = PackageDetails(dist.version, list(dist.iter_dependencies()))

        installed.add(name)

    return installed


def _create_whitelist(
    would_be_installed: Set[NormalizedName], package_set: PackageSet
) -> Set[NormalizedName]:
    packages_affected = set(would_be_installed)

    for package_name in package_set:
        if package_name in packages_affected:
            continue

        for req in package_set[package_name].dependencies:
            if canonicalize_name(req.name) in packages_affected:
                packages_affected.add(package_name)
                break

    return packages_affected


def warn_legacy_versions_and_specifiers(package_set: PackageSet) -> None:
    for project_name, package_details in package_set.items():
        if isinstance(package_details.version, LegacyVersion):
            deprecated(
                reason=(
                    f"{project_name} {package_details.version} "
                    f"has a non-standard version number."
                ),
                replacement=(
                    f"to upgrade to a newer version of {project_name} "
                    f"or contact the author to suggest that they "
                    f"release a version with a conforming version number"
                ),
                issue=12063,
                gone_in="24.1",
            )
        for dep in package_details.dependencies:
            if any(isinstance(spec, LegacySpecifier) for spec in dep.specifier):
                deprecated(
                    reason=(
                        f"{project_name} {package_details.version} "
                        f"has a non-standard dependency specifier {dep}."
                    ),
                    replacement=(
                        f"to upgrade to a newer version of {project_name} "
                        f"or contact the author to suggest that they "
                        f"release a version with a conforming dependency specifiers"
                    ),
                    issue=12063,
                    gone_in="24.1",
                )

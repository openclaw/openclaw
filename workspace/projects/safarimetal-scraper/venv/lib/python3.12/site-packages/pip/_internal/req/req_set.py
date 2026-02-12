import logging
from collections import OrderedDict
from typing import Dict, List

from pip._vendor.packaging.specifiers import LegacySpecifier
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import LegacyVersion

from pip._internal.req.req_install import InstallRequirement
from pip._internal.utils.deprecation import deprecated

logger = logging.getLogger(__name__)


class RequirementSet:
    def __init__(self, check_supported_wheels: bool = True) -> None:
        """Create a RequirementSet."""

        self.requirements: Dict[str, InstallRequirement] = OrderedDict()
        self.check_supported_wheels = check_supported_wheels

        self.unnamed_requirements: List[InstallRequirement] = []

    def __str__(self) -> str:
        requirements = sorted(
            (req for req in self.requirements.values() if not req.comes_from),
            key=lambda req: canonicalize_name(req.name or ""),
        )
        return " ".join(str(req.req) for req in requirements)

    def __repr__(self) -> str:
        requirements = sorted(
            self.requirements.values(),
            key=lambda req: canonicalize_name(req.name or ""),
        )

        format_string = "<{classname} object; {count} requirement(s): {reqs}>"
        return format_string.format(
            classname=self.__class__.__name__,
            count=len(requirements),
            reqs=", ".join(str(req.req) for req in requirements),
        )

    def add_unnamed_requirement(self, install_req: InstallRequirement) -> None:
        assert not install_req.name
        self.unnamed_requirements.append(install_req)

    def add_named_requirement(self, install_req: InstallRequirement) -> None:
        assert install_req.name

        project_name = canonicalize_name(install_req.name)
        self.requirements[project_name] = install_req

    def has_requirement(self, name: str) -> bool:
        project_name = canonicalize_name(name)

        return (
            project_name in self.requirements
            and not self.requirements[project_name].constraint
        )

    def get_requirement(self, name: str) -> InstallRequirement:
        project_name = canonicalize_name(name)

        if project_name in self.requirements:
            return self.requirements[project_name]

        raise KeyError(f"No project with the name {name!r}")

    @property
    def all_requirements(self) -> List[InstallRequirement]:
        return self.unnamed_requirements + list(self.requirements.values())

    @property
    def requirements_to_install(self) -> List[InstallRequirement]:
        """Return the list of requirements that need to be installed.

        TODO remove this property together with the legacy resolver, since the new
             resolver only returns requirements that need to be installed.
        """
        return [
            install_req
            for install_req in self.all_requirements
            if not install_req.constraint and not install_req.satisfied_by
        ]

    def warn_legacy_versions_and_specifiers(self) -> None:
        for req in self.requirements_to_install:
            version = req.get_dist().version
            if isinstance(version, LegacyVersion):
                deprecated(
                    reason=(
                        f"pip has selected the non standard version {version} "
                        f"of {req}. In the future this version will be "
                        f"ignored as it isn't standard compliant."
                    ),
                    replacement=(
                        "set or update constraints to select another version "
                        "or contact the package author to fix the version number"
                    ),
                    issue=12063,
                    gone_in="24.1",
                )
            for dep in req.get_dist().iter_dependencies():
                if any(isinstance(spec, LegacySpecifier) for spec in dep.specifier):
                    deprecated(
                        reason=(
                            f"pip has selected {req} {version} which has non "
                            f"standard dependency specifier {dep}. "
                            f"In the future this version of {req} will be "
                            f"ignored as it isn't standard compliant."
                        ),
                        replacement=(
                            "set or update constraints to select another version "
                            "or contact the package author to fix the version number"
                        ),
                        issue=12063,
                        gone_in="24.1",
                    )

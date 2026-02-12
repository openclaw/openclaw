class AbstractProvider(object):
    """Delegate class to provide the required interface for the resolver."""

    def identify(self, requirement_or_candidate):
        """Given a requirement, return an identifier for it.

        This is used to identify a requirement, e.g. whether two requirements
        should have their specifier parts merged.
        """
        raise NotImplementedError

    def get_preference(
        self,
        identifier,
        resolutions,
        candidates,
        information,
        backtrack_causes,
    ):
        """Produce a sort key for given requirement based on preference.

        The preference is defined as "I think this requirement should be
        resolved first". The lower the return value is, the more preferred
        this group of arguments is.

        :param identifier: An identifier as returned by ``identify()``. This
            identifies the dependency matches which should be returned.
        :param resolutions: Mapping of candidates currently pinned by the
            resolver. Each key is an identifier, and the value is a candidate.
            The candidate may conflict with requirements from ``information``.
        :param candidates: Mapping of each dependency's possible candidates.
            Each value is an iterator of candidates.
        :param information: Mapping of requirement information of each package.
            Each value is an iterator of *requirement information*.
        :param backtrack_causes: Sequence of requirement information that were
            the requirements that caused the resolver to most recently backtrack.

        A *requirement information* instance is a named tuple with two members:

        * ``requirement`` specifies a requirement contributing to the current
          list of candidates.
        * ``parent`` specifies the candidate that provides (depended on) the
          requirement, or ``None`` to indicate a root requirement.

        The preference could depend on various issues, including (not
        necessarily in this order):

        * Is this package pinned in the current resolution result?
        * How relaxed is the requirement? Stricter ones should probably be
          worked on first? (I don't know, actually.)
        * How many possibilities are there to satisfy this requirement? Those
          with few left should likely be worked on first, I guess?
        * Are there any known conflicts for this requirement? We should
          probably work on those with the most known conflicts.

        A sortable value should be returned (this will be used as the ``key``
        parameter of the built-in sorting function). The smaller the value is,
        the more preferred this requirement is (i.e. the sorting function
        is called with ``reverse=False``).
        """
        raise NotImplementedError

    def find_matches(self, identifier, requirements, incompatibilities):
        """Find all possible candidates that satisfy the given constraints.

        :param identifier: An identifier as returned by ``identify()``. This
            identifies the dependency matches of which should be returned.
        :param requirements: A mapping of requirements that all returned
            candidates must satisfy. Each key is an identifier, and the value
            an iterator of requirements for that dependency.
        :param incompatibilities: A mapping of known incompatibilities of
            each dependency. Each key is an identifier, and the value an
            iterator of incompatibilities known to the resolver. All
            incompatibilities *must* be excluded from the return value.

        This should try to get candidates based on the requirements' types.
        For VCS, local, and archive requirements, the one-and-only match is
        returned, and for a "named" requirement, the index(es) should be
        consulted to find concrete candidates for this requirement.

        The return value should produce candidates ordered by preference; the
        most preferred candidate should come first. The return type may be one
        of the following:

        * A callable that returns an iterator that yields candidates.
        * An collection of candidates.
        * An iterable of candidates. This will be consumed immediately into a
          list of candidates.
        """
        raise NotImplementedError

    def is_satisfied_by(self, requirement, candidate):
        """Whether the given requirement can be satisfied by a candidate.

        The candidate is guaranteed to have been generated from the
        requirement.

        A boolean should be returned to indicate whether ``candidate`` is a
        viable solution to the requirement.
        """
        raise NotImplementedError

    def get_dependencies(self, candidate):
        """Get dependencies of a candidate.

        This should return a collection of requirements that `candidate`
        specifies as its dependencies.
        """
        raise NotImplementedError


class AbstractResolver(object):
    """The thing that performs the actual resolution work."""

    base_exception = Exception

    def __init__(self, provider, reporter):
        self.provider = provider
        self.reporter = reporter

    def resolve(self, requirements, **kwargs):
        """Take a collection of constraints, spit out the resolution result.

        This returns a representation of the final resolution state, with one
        guarenteed attribute ``mapping`` that contains resolved candidates as
        values. The keys are their respective identifiers.

        :param requirements: A collection of constraints.
        :param kwargs: Additional keyword arguments that subclasses may accept.

        :raises: ``self.base_exception`` or its subclass.
        """
        raise NotImplementedError

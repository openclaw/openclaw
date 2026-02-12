class BaseReporter(object):
    """Delegate class to provider progress reporting for the resolver."""

    def starting(self):
        """Called before the resolution actually starts."""

    def starting_round(self, index):
        """Called before each round of resolution starts.

        The index is zero-based.
        """

    def ending_round(self, index, state):
        """Called before each round of resolution ends.

        This is NOT called if the resolution ends at this round. Use `ending`
        if you want to report finalization. The index is zero-based.
        """

    def ending(self, state):
        """Called before the resolution ends successfully."""

    def adding_requirement(self, requirement, parent):
        """Called when adding a new requirement into the resolve criteria.

        :param requirement: The additional requirement to be applied to filter
            the available candidaites.
        :param parent: The candidate that requires ``requirement`` as a
            dependency, or None if ``requirement`` is one of the root
            requirements passed in from ``Resolver.resolve()``.
        """

    def resolving_conflicts(self, causes):
        """Called when starting to attempt requirement conflict resolution.

        :param causes: The information on the collision that caused the backtracking.
        """

    def rejecting_candidate(self, criterion, candidate):
        """Called when rejecting a candidate during backtracking."""

    def pinning(self, candidate):
        """Called when adding a candidate to the potential solution."""

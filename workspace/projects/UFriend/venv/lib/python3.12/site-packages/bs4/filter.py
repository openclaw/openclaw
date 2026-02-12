from __future__ import annotations
from collections import defaultdict
import re
from typing import (
    Any,
    Callable,
    cast,
    Dict,
    Iterator,
    Iterable,
    List,
    Optional,
    Sequence,
    Type,
    Union,
)
import warnings

from bs4._deprecation import _deprecated
from bs4.element import (
    AttributeDict,
    NavigableString,
    PageElement,
    ResultSet,
    Tag,
)
from bs4._typing import (
    _AtMostOneElement,
    _AttributeValue,
    _NullableStringMatchFunction,
    _OneElement,
    _PageElementMatchFunction,
    _QueryResults,
    _RawAttributeValues,
    _RegularExpressionProtocol,
    _StrainableAttribute,
    _StrainableElement,
    _StrainableString,
    _StringMatchFunction,
    _TagMatchFunction,
)


class ElementFilter(object):
    """`ElementFilter` encapsulates the logic necessary to decide:

    1. whether a `PageElement` (a `Tag` or a `NavigableString`) matches a
    user-specified query.

    2. whether a given sequence of markup found during initial parsing
    should be turned into a `PageElement` at all, or simply discarded.

    The base class is the simplest `ElementFilter`. By default, it
    matches everything and allows all markup to become `PageElement`
    objects. You can make it more selective by passing in a
    user-defined match function, or defining a subclass.

    Most users of Beautiful Soup will never need to use
    `ElementFilter`, or its more capable subclass
    `SoupStrainer`. Instead, they will use methods like
    :py:meth:`Tag.find`, which will convert their arguments into
    `SoupStrainer` objects and run them against the tree.

    However, if you find yourself wanting to treat the arguments to
    Beautiful Soup's find_*() methods as first-class objects, those
    objects will be `SoupStrainer` objects. You can create them
    yourself and then make use of functions like
    `ElementFilter.filter()`.
    """

    match_function: Optional[_PageElementMatchFunction]

    def __init__(self, match_function: Optional[_PageElementMatchFunction] = None):
        """Pass in a match function to easily customize the behavior of
        `ElementFilter.match` without needing to subclass.

        :param match_function: A function that takes a `PageElement`
          and returns `True` if that `PageElement` matches some criteria.
        """
        self.match_function = match_function

    @property
    def includes_everything(self) -> bool:
        """Does this `ElementFilter` obviously include everything? If so,
        the filter process can be made much faster.

        The `ElementFilter` might turn out to include everything even
        if this returns `False`, but it won't include everything in an
        obvious way.

        The base `ElementFilter` implementation includes things based on
        the match function, so includes_everything is only true if
        there is no match function.
        """
        return not self.match_function

    @property
    def excludes_everything(self) -> bool:
        """Does this `ElementFilter` obviously exclude everything? If
        so, Beautiful Soup will issue a warning if you try to use it
        when parsing a document.

        The `ElementFilter` might turn out to exclude everything even
        if this returns `False`, but it won't exclude everything in an
        obvious way.

        The base `ElementFilter` implementation excludes things based
        on a match function we can't inspect, so excludes_everything
        is always false.
        """
        return False

    def match(self, element: PageElement, _known_rules:bool=False) -> bool:
        """Does the given PageElement match the rules set down by this
        ElementFilter?

        The base implementation delegates to the function passed in to
        the constructor.

        :param _known_rules: Defined for compatibility with
            SoupStrainer._match(). Used more for consistency than because
            we need the performance optimization.
        """
        if not _known_rules and self.includes_everything:
            return True
        if not self.match_function:
            return True
        return self.match_function(element)

    def filter(self, generator: Iterator[PageElement]) -> Iterator[_OneElement]:
        """The most generic search method offered by Beautiful Soup.

        Acts like Python's built-in `filter`, using
        `ElementFilter.match` as the filtering function.
        """
        # If there are no rules at all, don't bother filtering. Let
        # anything through.
        if self.includes_everything:
            yield from generator
        while True:
            try:
                i = next(generator)
            except StopIteration:
                break
            if i:
                if self.match(i, _known_rules=True):
                    yield cast("_OneElement", i)

    def find(self, generator: Iterator[PageElement]) -> _AtMostOneElement:
        """A lower-level equivalent of :py:meth:`Tag.find`.

        You can pass in your own generator for iterating over
        `PageElement` objects. The first one that matches this
        `ElementFilter` will be returned.

        :param generator: A way of iterating over `PageElement`
            objects.
        """
        for match in self.filter(generator):
            return match
        return None

    def find_all(
        self, generator: Iterator[PageElement], limit: Optional[int] = None
    ) -> _QueryResults:
        """A lower-level equivalent of :py:meth:`Tag.find_all`.

        You can pass in your own generator for iterating over
        `PageElement` objects. Only elements that match this
        `ElementFilter` will be returned in the :py:class:`ResultSet`.

        :param generator: A way of iterating over `PageElement`
            objects.

        :param limit: Stop looking after finding this many results.
        """
        results = []
        for match in self.filter(generator):
            results.append(match)
            if limit is not None and len(results) >= limit:
                break
        return ResultSet(self, results)

    def allow_tag_creation(
        self, nsprefix: Optional[str], name: str, attrs: Optional[_RawAttributeValues]
    ) -> bool:
        """Based on the name and attributes of a tag, see whether this
        `ElementFilter` will allow a `Tag` object to even be created.

        By default, all tags are parsed. To change this, subclass
        `ElementFilter`.

        :param name: The name of the prospective tag.
        :param attrs: The attributes of the prospective tag.
        """
        return True

    def allow_string_creation(self, string: str) -> bool:
        """Based on the content of a string, see whether this
        `ElementFilter` will allow a `NavigableString` object based on
        this string to be added to the parse tree.

        By default, all strings are processed into `NavigableString`
        objects. To change this, subclass `ElementFilter`.

        :param str: The string under consideration.
        """
        return True


class MatchRule(object):
    """Each MatchRule encapsulates the logic behind a single argument
    passed in to one of the Beautiful Soup find* methods.
    """

    string: Optional[str]
    pattern: Optional[_RegularExpressionProtocol]
    present: Optional[bool]
    exclude_everything: Optional[bool]
    # TODO-TYPING: All MatchRule objects also have an attribute
    # ``function``, but the type of the function depends on the
    # subclass.

    def __init__(
        self,
        string: Optional[Union[str, bytes]] = None,
        pattern: Optional[_RegularExpressionProtocol] = None,
        function: Optional[Callable] = None,
        present: Optional[bool] = None,
        exclude_everything: Optional[bool] = None
    ):
        if isinstance(string, bytes):
            string = string.decode("utf8")
        self.string = string
        if isinstance(pattern, bytes):
            self.pattern = re.compile(pattern.decode("utf8"))
        elif isinstance(pattern, str):
            self.pattern = re.compile(pattern)
        else:
            self.pattern = pattern
        self.function = function
        self.present = present
        self.exclude_everything = exclude_everything

        values = [
            x
            for x in (self.string, self.pattern, self.function, self.present, self.exclude_everything)
            if x is not None
        ]
        if len(values) == 0:
            raise ValueError(
                "Either string, pattern, function, present, or exclude_everything must be provided."
            )
        if len(values) > 1:
            raise ValueError(
                "At most one of string, pattern, function, present, and exclude_everything must be provided."
            )

    def _base_match(self, string: Optional[str]) -> Optional[bool]:
        """Run the 'cheap' portion of a match, trying to get an answer without
        calling a potentially expensive custom function.

        :return: True or False if we have a (positive or negative)
        match; None if we need to keep trying.
        """
        # self.exclude_everything matches nothing.
        if self.exclude_everything:
            return False

        # self.present==True matches everything except None.
        if self.present is True:
            return string is not None

        # self.present==False matches _only_ None.
        if self.present is False:
            return string is None

        # self.string does an exact string match.
        if self.string is not None:
            # print(f"{self.string} ?= {string}")
            return self.string == string

        # self.pattern does a regular expression search.
        if self.pattern is not None:
            # print(f"{self.pattern} ?~ {string}")
            if string is None:
                return False
            return self.pattern.search(string) is not None

        return None

    def matches_string(self, string: Optional[str]) -> bool:
        _base_result = self._base_match(string)
        if _base_result is not None:
            # No need to invoke the test function.
            return _base_result
        if self.function is not None and not self.function(string):
            # print(f"{self.function}({string}) == False")
            return False
        return True

    def __repr__(self) -> str:
        cls = type(self).__name__
        return f"<{cls} string={self.string} pattern={self.pattern} function={self.function} present={self.present}>"

    def __eq__(self, other: Any) -> bool:
        return (
            isinstance(other, MatchRule)
            and self.string == other.string
            and self.pattern == other.pattern
            and self.function == other.function
            and self.present == other.present
        )


class TagNameMatchRule(MatchRule):
    """A MatchRule implementing the rules for matches against tag name."""

    function: Optional[_TagMatchFunction]

    def matches_tag(self, tag: Tag) -> bool:
        base_value = self._base_match(tag.name)
        if base_value is not None:
            return base_value

        # The only remaining possibility is that the match is determined
        # by a function call. Call the function.
        function = cast(_TagMatchFunction, self.function)
        if function(tag):
            return True
        return False


class AttributeValueMatchRule(MatchRule):
    """A MatchRule implementing the rules for matches against attribute value."""

    function: Optional[_NullableStringMatchFunction]


class StringMatchRule(MatchRule):
    """A MatchRule implementing the rules for matches against a NavigableString."""

    function: Optional[_StringMatchFunction]


class SoupStrainer(ElementFilter):
    """The `ElementFilter` subclass used internally by Beautiful Soup.

    A `SoupStrainer` encapsulates the logic necessary to perform the
    kind of matches supported by methods such as
    :py:meth:`Tag.find`. `SoupStrainer` objects are primarily created
    internally, but you can create one yourself and pass it in as
    ``parse_only`` to the `BeautifulSoup` constructor, to parse a
    subset of a large document.

    Internally, `SoupStrainer` objects work by converting the
    constructor arguments into `MatchRule` objects. Incoming
    tags/markup are matched against those rules.

    :param name: One or more restrictions on the tags found in a document.

    :param attrs: A dictionary that maps attribute names to
      restrictions on tags that use those attributes.

    :param string: One or more restrictions on the strings found in a
      document.

    :param kwargs: A dictionary that maps attribute names to restrictions
      on tags that use those attributes. These restrictions are additive to
      any specified in ``attrs``.

    """

    name_rules: List[TagNameMatchRule]
    attribute_rules: Dict[str, List[AttributeValueMatchRule]]
    string_rules: List[StringMatchRule]

    def __init__(
        self,
        name: Optional[_StrainableElement] = None,
        attrs: Optional[Dict[str, _StrainableAttribute]] = None,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ):
        if string is None and "text" in kwargs:
            string = cast(Optional[_StrainableString], kwargs.pop("text"))
            warnings.warn(
                "As of version 4.11.0, the 'text' argument to the SoupStrainer constructor is deprecated. Use 'string' instead.",
                DeprecationWarning,
                stacklevel=2,
            )

        if name is None and not attrs and not string and not kwargs:
            # Special case for backwards compatibility. Instantiating
            # a SoupStrainer with no arguments whatsoever gets you one
            # that matches all Tags, and only Tags.
            self.name_rules = [TagNameMatchRule(present=True)]
        else:
            self.name_rules = cast(
                List[TagNameMatchRule], list(self._make_match_rules(name, TagNameMatchRule))
            )
        self.attribute_rules = defaultdict(list)

        if attrs is None:
            attrs = {}
        if not isinstance(attrs, dict):
            # Passing something other than a dictionary as attrs is
            # sugar for matching that thing against the 'class'
            # attribute.
            attrs = {"class": attrs}

        for attrdict in attrs, kwargs:
            for attr, value in attrdict.items():
                if attr == "class_" and attrdict is kwargs:
                    # If you pass in 'class_' as part of kwargs, it's
                    # because class is a Python reserved word. If you
                    # pass it in as part of the attrs dict, it's
                    # because you really are looking for an attribute
                    # called 'class_'.
                    attr = "class"

                if value is None:
                    value = False
                for rule_obj in self._make_match_rules(value, AttributeValueMatchRule):
                    self.attribute_rules[attr].append(
                        cast(AttributeValueMatchRule, rule_obj)
                    )

        self.string_rules = cast(
            List[StringMatchRule], list(self._make_match_rules(string, StringMatchRule))
        )

        #: DEPRECATED 4.13.0: You shouldn't need to check this under
        #: any name (.string or .text), and if you do, you're probably
        #: not taking into account all of the types of values this
        #: variable might have. Look at the .string_rules list instead.
        self.__string = string

    @property
    def includes_everything(self) -> bool:
        """Check whether the provided rules will obviously include
        everything. (They might include everything even if this returns `False`,
        but not in an obvious way.)
        """
        return not self.name_rules and not self.string_rules and not self.attribute_rules

    @property
    def excludes_everything(self) -> bool:
        """Check whether the provided rules will obviously exclude
        everything. (They might exclude everything even if this returns `False`,
        but not in an obvious way.)
        """
        if (self.string_rules and (self.name_rules or self.attribute_rules)):
            # This is self-contradictory, so the rules exclude everything.
            return True

        # If there's a rule that ended up treated as an "exclude everything"
        # rule due to creating a logical inconsistency, then the rules
        # exclude everything.
        if any(x.exclude_everything for x in self.string_rules):
            return True
        if any(x.exclude_everything for x in self.name_rules):
            return True
        for ruleset in self.attribute_rules.values():
            if any(x.exclude_everything for x in ruleset):
                return True
        return False

    @property
    def string(self) -> Optional[_StrainableString]:
        ":meta private:"
        warnings.warn(
            "Access to deprecated property string. (Look at .string_rules instead) -- Deprecated since version 4.13.0.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.__string

    @property
    def text(self) -> Optional[_StrainableString]:
        ":meta private:"
        warnings.warn(
            "Access to deprecated property text. (Look at .string_rules instead) -- Deprecated since version 4.13.0.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.__string

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} name={self.name_rules} attrs={self.attribute_rules} string={self.string_rules}>"

    @classmethod
    def _make_match_rules(
        cls,
        obj: Optional[Union[_StrainableElement, _StrainableAttribute]],
        rule_class: Type[MatchRule],
    ) -> Iterator[MatchRule]:
        """Convert a vaguely-specific 'object' into one or more well-defined
        `MatchRule` objects.

        :param obj: Some kind of object that corresponds to one or more
           matching rules.
        :param rule_class: Create instances of this `MatchRule` subclass.
        """
        if obj is None:
            return
        if isinstance(obj, (str, bytes)):
            yield rule_class(string=obj)
        elif isinstance(obj, bool):
            yield rule_class(present=obj)
        elif callable(obj):
            yield rule_class(function=obj)
        elif isinstance(obj, _RegularExpressionProtocol):
            yield rule_class(pattern=obj)
        elif hasattr(obj, "__iter__"):
            if not obj:
                # The attribute is being matched against the null set,
                # which means it should exclude everything.
                yield rule_class(exclude_everything=True)
            for o in obj:
                if not isinstance(o, (bytes, str)) and hasattr(o, "__iter__"):
                    # This is almost certainly the user's
                    # mistake. This list contains another list, which
                    # opens up the possibility of infinite
                    # self-reference. In the interests of avoiding
                    # infinite recursion, we'll treat this as an
                    # impossible match and issue a rule that excludes
                    # everything, rather than looking inside.
                    warnings.warn(
                        f"Ignoring nested list {o} to avoid the possibility of infinite recursion.",
                        stacklevel=5,
                    )
                    yield rule_class(exclude_everything=True)
                    continue
                for x in cls._make_match_rules(o, rule_class):
                    yield x
        else:
            yield rule_class(string=str(obj))

    def matches_tag(self, tag: Tag) -> bool:
        """Do the rules of this `SoupStrainer` trigger a match against the
        given `Tag`?

        If the `SoupStrainer` has any `TagNameMatchRule`, at least one
        must match the `Tag` or its `Tag.name`.

        If there are any `AttributeValueMatchRule` for a given
        attribute, at least one of them must match the attribute
        value.

        If there are any `StringMatchRule`, at least one must match,
        but a `SoupStrainer` that *only* contains `StringMatchRule`
        cannot match a `Tag`, only a `NavigableString`.
        """
        # If there are no rules at all, let anything through.
        #if self.includes_everything:
        #    return True

        # String rules cannot not match a Tag on their own.
        if not self.name_rules and not self.attribute_rules:
            return False

        # Optimization for a very common case where the user is
        # searching for a tag with one specific name, and we're
        # looking at a tag with a different name.
        if (
            not tag.prefix
            and len(self.name_rules) == 1
            and self.name_rules[0].string is not None
            and tag.name != self.name_rules[0].string
        ):
            return False

        # If there are name rules, at least one must match. It can
        # match either the Tag object itself or the prefixed name of
        # the tag.
        prefixed_name = None
        if tag.prefix:
            prefixed_name = f"{tag.prefix}:{tag.name}"
        if self.name_rules:
            name_matches = False
            for rule in self.name_rules:
                # attrs = " ".join(
                #     [f"{k}={v}" for k, v in sorted(tag.attrs.items())]
                # )
                # print(f"Testing <{tag.name} {attrs}>{tag.string}</{tag.name}> against {rule}")

                # If the rule contains a function, the function will be called
                # with `tag`. It will not be called a second time with
                # `prefixed_name`.
                if rule.matches_tag(tag) or (
                        not rule.function and prefixed_name is not None and rule.matches_string(prefixed_name)
                ):
                    name_matches = True
                    break

            if not name_matches:
                return False

        # If there are attribute rules for a given attribute, at least
        # one of them must match. If there are rules for multiple
        # attributes, each attribute must have at least one match.
        for attr, rules in self.attribute_rules.items():
            attr_value = tag.get(attr, None)
            this_attr_match = self._attribute_match(attr_value, rules)
            if not this_attr_match:
                return False

        # If there are string rules, at least one must match.
        if self.string_rules:
            _str = tag.string
            if _str is None:
                return False
            if not self.matches_any_string_rule(_str):
                return False
        return True

    def _attribute_match(
        self,
        attr_value: Optional[_AttributeValue],
        rules: Iterable[AttributeValueMatchRule],
    ) -> bool:
        attr_values: Sequence[Optional[str]]
        if isinstance(attr_value, list):
            attr_values = attr_value
        else:
            attr_values = [cast(str, attr_value)]

        def _match_attribute_value_helper(attr_values: Sequence[Optional[str]]) -> bool:
            for rule in rules:
                for attr_value in attr_values:
                    if rule.matches_string(attr_value):
                        return True
            return False

        this_attr_match = _match_attribute_value_helper(attr_values)
        if not this_attr_match and len(attr_values) != 1:
            # Try again but treat the attribute value as a single
            # string instead of a list. The result can only be
            # different if the list of values contains more or less
            # than one item.

            # This cast converts Optional[str] to plain str.
            #
            # We know there can't be any None in the list. Beautiful
            # Soup never uses None as a value of a multi-valued
            # attribute, and if None is passed in as attr_value, it's
            # turned into a list with 1 element, which was excluded by
            # the if statement above.
            attr_values = cast(Sequence[str], attr_values)

            joined_attr_value = " ".join(attr_values)
            this_attr_match = _match_attribute_value_helper([joined_attr_value])
        return this_attr_match

    def allow_tag_creation(
        self, nsprefix: Optional[str], name: str, attrs: Optional[_RawAttributeValues]
    ) -> bool:
        """Based on the name and attributes of a tag, see whether this
        `SoupStrainer` will allow a `Tag` object to even be created.

        :param name: The name of the prospective tag.
        :param attrs: The attributes of the prospective tag.
        """
        if self.string_rules:
            # A SoupStrainer that has string rules can't be used to
            # manage tag creation, because the string rule can't be
            # evaluated until after the tag and all of its contents
            # have been parsed.
            return False
        prefixed_name = None
        if nsprefix:
            prefixed_name = f"{nsprefix}:{name}"
        if self.name_rules:
            # At least one name rule must match.
            name_match = False
            for rule in self.name_rules:
                for x in name, prefixed_name:
                    if x is not None:
                        if rule.matches_string(x):
                            name_match = True
                            break
            if not name_match:
                return False

        # For each attribute that has rules, at least one rule must
        # match.
        if attrs is None:
            attrs = AttributeDict()
        for attr, rules in self.attribute_rules.items():
            attr_value = attrs.get(attr)
            if not self._attribute_match(attr_value, rules):
                return False

        return True

    def allow_string_creation(self, string: str) -> bool:
        """Based on the content of a markup string, see whether this
        `SoupStrainer` will allow it to be instantiated as a
        `NavigableString` object, or whether it should be ignored.
        """
        if self.name_rules or self.attribute_rules:
            # A SoupStrainer that has name or attribute rules won't
            # match any strings; it's designed to match tags with
            # certain properties.
            return False
        if not self.string_rules:
            # A SoupStrainer with no string rules will match
            # all strings.
            return True
        if not self.matches_any_string_rule(string):
            return False
        return True

    def matches_any_string_rule(self, string: str) -> bool:
        """See whether the content of a string matches any of
        this `SoupStrainer`'s string rules.
        """
        if not self.string_rules:
            return True
        for string_rule in self.string_rules:
            if string_rule.matches_string(string):
                return True
        return False

    def match(self, element: PageElement, _known_rules: bool=False) -> bool:
        """Does the given `PageElement` match the rules set down by this
        `SoupStrainer`?

        The find_* methods rely heavily on this method to find matches.

        :param element: A `PageElement`.
        :param _known_rules: Set to true in the common case where
           we already checked and found at least one rule in this SoupStrainer
           that might exclude a PageElement. Without this, we need
           to check .includes_everything every time, just to be safe.
        :return: `True` if the element matches this `SoupStrainer`'s rules; `False` otherwise.
        """
        # If there are no rules at all, let anything through.
        if not _known_rules and self.includes_everything:
            return True
        if isinstance(element, Tag):
            return self.matches_tag(element)
        assert isinstance(element, NavigableString)
        if not (self.name_rules or self.attribute_rules):
            # A NavigableString can only match a SoupStrainer that
            # does not define any name or attribute rules.
            # Then it comes down to the string rules.
            return self.matches_any_string_rule(element)
        return False

    @_deprecated("allow_tag_creation", "4.13.0")
    def search_tag(self, name: str, attrs: Optional[_RawAttributeValues]) -> bool:
        """A less elegant version of `allow_tag_creation`. Deprecated as of 4.13.0"""
        ":meta private:"
        return self.allow_tag_creation(None, name, attrs)

    @_deprecated("match", "4.13.0")
    def search(self, element: PageElement) -> Optional[PageElement]:
        """A less elegant version of match(). Deprecated as of 4.13.0.

        :meta private:
        """
        return element if self.match(element) else None

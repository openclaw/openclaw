# Custom type aliases used throughout Beautiful Soup to improve readability.

# Notes on improvements to the type system in newer versions of Python
# that can be used once Beautiful Soup drops support for older
# versions:
#
# * ClassVar can be put on class variables now.
# * In 3.10, x|y is an accepted shorthand for Union[x,y].
# * In 3.10, TypeAlias gains capabilities that can be used to
#   improve the tree matching types (I don't remember what, exactly).
# * In 3.9 it's possible to specialize the re.Match type,
#   e.g. re.Match[str]. In 3.8 there's a typing.re namespace for this,
#   but it's removed in 3.12, so to support the widest possible set of
#   versions I'm not using it.

from typing_extensions import (
    runtime_checkable,
    Protocol,
    TypeAlias,
)
from typing import (
    Any,
    Callable,
    Dict,
    IO,
    Iterable,
    Mapping,
    Optional,
    Pattern,
    TYPE_CHECKING,
    Union,
)

if TYPE_CHECKING:
    from bs4.element import (
        AttributeValueList,
        NamespacedAttribute,
        NavigableString,
        PageElement,
        ResultSet,
        Tag,
    )


@runtime_checkable
class _RegularExpressionProtocol(Protocol):
    """A protocol object which can accept either Python's built-in
    `re.Pattern` objects, or the similar ``Regex`` objects defined by the
    third-party ``regex`` package.
    """

    def search(
        self, string: str, pos: int = ..., endpos: int = ...
    ) -> Optional[Any]: ...

    @property
    def pattern(self) -> str: ...


# Aliases for markup in various stages of processing.
#
#: The rawest form of markup: either a string, bytestring, or an open filehandle.
_IncomingMarkup: TypeAlias = Union[str, bytes, IO[str], IO[bytes]]

#: Markup that is in memory but has (potentially) yet to be converted
#: to Unicode.
_RawMarkup: TypeAlias = Union[str, bytes]

# Aliases for character encodings
#

#: A data encoding.
_Encoding: TypeAlias = str

#: One or more data encodings.
_Encodings: TypeAlias = Iterable[_Encoding]

# Aliases for XML namespaces
#

#: The prefix for an XML namespace.
_NamespacePrefix: TypeAlias = str

#: The URL of an XML namespace
_NamespaceURL: TypeAlias = str

#: A mapping of prefixes to namespace URLs.
_NamespaceMapping: TypeAlias = Dict[_NamespacePrefix, _NamespaceURL]

#: A mapping of namespace URLs to prefixes
_InvertedNamespaceMapping: TypeAlias = Dict[_NamespaceURL, _NamespacePrefix]

# Aliases for the attribute values associated with HTML/XML tags.
#

#: The value associated with an HTML or XML attribute. This is the
#: relatively unprocessed value Beautiful Soup expects to come from a
#: `TreeBuilder`.
_RawAttributeValue: TypeAlias = str

#: A dictionary of names to `_RawAttributeValue` objects. This is how
#: Beautiful Soup expects a `TreeBuilder` to represent a tag's
#: attribute values.
_RawAttributeValues: TypeAlias = (
    "Mapping[Union[str, NamespacedAttribute], _RawAttributeValue]"
)

#: An attribute value in its final form, as stored in the
# `Tag` class, after it has been processed and (in some cases)
# split into a list of strings.
_AttributeValue: TypeAlias = Union[str, "AttributeValueList"]

#: A dictionary of names to :py:data:`_AttributeValue` objects. This is what
#: a tag's attributes look like after processing.
_AttributeValues: TypeAlias = Dict[str, _AttributeValue]

#: The methods that deal with turning :py:data:`_RawAttributeValue` into
#: :py:data:`_AttributeValue` may be called several times, even after the values
#: are already processed (e.g. when cloning a tag), so they need to
#: be able to acommodate both possibilities.
_RawOrProcessedAttributeValues: TypeAlias = Union[_RawAttributeValues, _AttributeValues]

#: A number of tree manipulation methods can take either a `PageElement` or a
#: normal Python string (which will be converted to a `NavigableString`).
_InsertableElement: TypeAlias = Union["PageElement", str]

# Aliases to represent the many possibilities for matching bits of a
# parse tree.
#
# This is very complicated because we're applying a formal type system
# to some very DWIM code. The types we end up with will be the types
# of the arguments to the SoupStrainer constructor and (more
# familiarly to Beautiful Soup users) the find* methods.

#: A function that takes a PageElement and returns a yes-or-no answer.
_PageElementMatchFunction: TypeAlias = Callable[["PageElement"], bool]

#: A function that takes the raw parsed ingredients of a markup tag
#: and returns a yes-or-no answer.
#  Not necessary at the moment.
# _AllowTagCreationFunction:TypeAlias = Callable[[Optional[str], str, Optional[_RawAttributeValues]], bool]

#: A function that takes the raw parsed ingredients of a markup string node
#: and returns a yes-or-no answer.
#  Not necessary at the moment.
# _AllowStringCreationFunction:TypeAlias = Callable[[Optional[str]], bool]

#: A function that takes a `Tag` and returns a yes-or-no answer.
#: A `TagNameMatchRule` expects this kind of function, if you're
#: going to pass it a function.
_TagMatchFunction: TypeAlias = Callable[["Tag"], bool]

#: A function that takes a string (or None) and returns a yes-or-no
#: answer. An `AttributeValueMatchRule` expects this kind of function, if
#: you're going to pass it a function.
_NullableStringMatchFunction: TypeAlias = Callable[[Optional[str]], bool]

#: A function that takes a string and returns a yes-or-no answer.  A
# `StringMatchRule` expects this kind of function, if you're going to
# pass it a function.
_StringMatchFunction: TypeAlias = Callable[[str], bool]

#: Either a tag name, an attribute value or a string can be matched
#: against a string, bytestring, regular expression, or a boolean.
_BaseStrainable: TypeAlias = Union[str, bytes, Pattern[str], bool]

#: A tag can be matched either with the `_BaseStrainable` options, or
#: using a function that takes the `Tag` as its sole argument.
_BaseStrainableElement: TypeAlias = Union[_BaseStrainable, _TagMatchFunction]

#: A tag's attribute value can be matched either with the
#: `_BaseStrainable` options, or using a function that takes that
#: value as its sole argument.
_BaseStrainableAttribute: TypeAlias = Union[_BaseStrainable, _NullableStringMatchFunction]

#: A tag can be matched using either a single criterion or a list of
#: criteria.
_StrainableElement: TypeAlias = Union[
    _BaseStrainableElement, Iterable[_BaseStrainableElement]
]

#: An attribute value can be matched using either a single criterion
#: or a list of criteria.
_StrainableAttribute: TypeAlias = Union[
    _BaseStrainableAttribute, Iterable[_BaseStrainableAttribute]
]

#: An string can be matched using the same techniques as
#: an attribute value.
_StrainableString: TypeAlias = _StrainableAttribute

#: A dictionary may be used to match against multiple attribute vlaues at once.
_StrainableAttributes: TypeAlias = Dict[str, _StrainableAttribute]

#: Many Beautiful soup methods return a PageElement or an ResultSet of
#: PageElements. A PageElement is either a Tag or a NavigableString.
#: These convenience aliases make it easier for IDE users to see which methods
#: are available on the objects they're dealing with.
_OneElement: TypeAlias = Union["PageElement", "Tag", "NavigableString"]
_AtMostOneElement: TypeAlias = Optional[_OneElement]
_AtMostOneTag: TypeAlias = Optional["Tag"]
_AtMostOneNavigableString: TypeAlias = Optional["NavigableString"]
_QueryResults: TypeAlias = "ResultSet[_OneElement]"
_SomeTags: TypeAlias = "ResultSet[Tag]"
_SomeNavigableStrings: TypeAlias = "ResultSet[NavigableString]"

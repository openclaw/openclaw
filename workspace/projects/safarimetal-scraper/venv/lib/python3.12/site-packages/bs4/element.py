from __future__ import annotations

# Use of this source code is governed by the MIT license.
__license__ = "MIT"

import re
import warnings

from bs4.css import CSS
from bs4._deprecation import (
    _deprecated,
    _deprecated_alias,
    _deprecated_function_alias,
)
from bs4.formatter import (
    Formatter,
    HTMLFormatter,
    XMLFormatter,
)
from bs4._warnings import AttributeResemblesVariableWarning

from typing import (
    Any,
    Callable,
    Dict,
    Generic,
    Iterable,
    Iterator,
    List,
    Mapping,
    MutableSequence,
    Optional,
    Pattern,
    Set,
    TYPE_CHECKING,
    Tuple,
    Type,
    TypeVar,
    Union,
    cast,
    overload,
)
from typing_extensions import (
    Self,
    TypeAlias,
)

if TYPE_CHECKING:
    from bs4 import BeautifulSoup
    from bs4.builder import TreeBuilder
    from bs4.filter import ElementFilter
    from bs4.formatter import (
        _EntitySubstitutionFunction,
        _FormatterOrName,
    )
    from bs4._typing import (
        _AtMostOneElement,
        _AtMostOneTag,
        _AtMostOneNavigableString,
        _AttributeValue,
        _AttributeValues,
        _Encoding,
        _InsertableElement,
        _OneElement,
        _QueryResults,
        _RawOrProcessedAttributeValues,
        _StrainableElement,
        _StrainableAttribute,
        _StrainableAttributes,
        _StrainableString,
        _SomeNavigableStrings,
        _SomeTags,
    )

_OneOrMoreStringTypes: TypeAlias = Union[
    Type["NavigableString"], Iterable[Type["NavigableString"]]
]

_FindMethodName: TypeAlias = Optional[Union["_StrainableElement", "ElementFilter"]]

# Deprecated module-level attributes.
# See https://peps.python.org/pep-0562/
_deprecated_names = dict(
    whitespace_re="The {name} attribute was deprecated in version 4.7.0. If you need it, make your own copy."
)
#: :meta private:
_deprecated_whitespace_re: Pattern[str] = re.compile(r"\s+")


def __getattr__(name: str) -> Any:
    if name in _deprecated_names:
        message = _deprecated_names[name]
        warnings.warn(message.format(name=name), DeprecationWarning, stacklevel=2)

        return globals()[f"_deprecated_{name}"]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


#: Documents output by Beautiful Soup will be encoded with
#: this encoding unless you specify otherwise.
DEFAULT_OUTPUT_ENCODING: str = "utf-8"

#: A regular expression that can be used to split on whitespace.
nonwhitespace_re: Pattern[str] = re.compile(r"\S+")

#: These encodings are recognized by Python (so `Tag.encode`
#: could theoretically support them) but XML and HTML don't recognize
#: them (so they should not show up in an XML or HTML document as that
#: document's encoding).
#:
#: If an XML document is encoded in one of these encodings, no encoding
#: will be mentioned in the XML declaration. If an HTML document is
#: encoded in one of these encodings, and the HTML document has a
#: <meta> tag that mentions an encoding, the encoding will be given as
#: the empty string.
#:
#: Source:
#: Python documentation, `Python Specific Encodings <https://docs.python.org/3/library/codecs.html#python-specific-encodings>`_
PYTHON_SPECIFIC_ENCODINGS: Set[_Encoding] = set(
    [
        "idna",
        "mbcs",
        "oem",
        "palmos",
        "punycode",
        "raw_unicode_escape",
        "undefined",
        "unicode_escape",
        "raw-unicode-escape",
        "unicode-escape",
        "string-escape",
        "string_escape",
    ]
)


class NamespacedAttribute(str):
    """A namespaced attribute (e.g. the 'xml:lang' in 'xml:lang="en"')
    which remembers the namespace prefix ('xml') and the name ('lang')
    that were used to create it.
    """

    prefix: Optional[str]
    name: Optional[str]
    namespace: Optional[str]

    def __new__(
        cls,
        prefix: Optional[str],
        name: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> Self:
        if not name:
            # This is the default namespace. Its name "has no value"
            # per https://www.w3.org/TR/xml-names/#defaulting
            name = None

        if not name:
            obj = str.__new__(cls, prefix)
        elif not prefix:
            # Not really namespaced.
            obj = str.__new__(cls, name)
        else:
            obj = str.__new__(cls, prefix + ":" + name)
        obj.prefix = prefix
        obj.name = name
        obj.namespace = namespace
        return obj


class AttributeValueWithCharsetSubstitution(str):
    """An abstract class standing in for a character encoding specified
    inside an HTML ``<meta>`` tag.

    Subclasses exist for each place such a character encoding might be
    found: either inside the ``charset`` attribute
    (`CharsetMetaAttributeValue`) or inside the ``content`` attribute
    (`ContentMetaAttributeValue`)

    This allows Beautiful Soup to replace that part of the HTML file
    with a different encoding when ouputting a tree as a string.
    """

    # The original, un-encoded value of the ``content`` attribute.
    #: :meta private:
    original_value: str

    def substitute_encoding(self, eventual_encoding: str) -> str:
        """Do whatever's necessary in this implementation-specific
        portion an HTML document to substitute in a specific encoding.
        """
        raise NotImplementedError()


class CharsetMetaAttributeValue(AttributeValueWithCharsetSubstitution):
    """A generic stand-in for the value of a ``<meta>`` tag's ``charset``
    attribute.

    When Beautiful Soup parses the markup ``<meta charset="utf8">``, the
    value of the ``charset`` attribute will become one of these objects.

    If the document is later encoded to an encoding other than UTF-8, its
    ``<meta>`` tag will mention the new encoding instead of ``utf8``.
    """

    def __new__(cls, original_value: str) -> Self:
        # We don't need to use the original value for anything, but
        # it might be useful for the user to know.
        obj = str.__new__(cls, original_value)
        obj.original_value = original_value
        return obj

    def substitute_encoding(self, eventual_encoding: _Encoding = "utf-8") -> str:
        """When an HTML document is being encoded to a given encoding, the
        value of a ``<meta>`` tag's ``charset`` becomes the name of
        the encoding.
        """
        if eventual_encoding in PYTHON_SPECIFIC_ENCODINGS:
            return ""
        return eventual_encoding


class AttributeValueList(List[str]):
    """Class for the list used to hold the values of attributes which
    have multiple values (such as HTML's 'class'). It's just a regular
    list, but you can subclass it and pass it in to the TreeBuilder
    constructor as attribute_value_list_class, to have your subclass
    instantiated instead.
    """


class AttributeDict(Dict[Any,Any]):
    """Superclass for the dictionary used to hold a tag's
    attributes. You can use this, but it's just a regular dict with no
    special logic.
    """


class XMLAttributeDict(AttributeDict):
    """A dictionary for holding a Tag's attributes, which processes
    incoming values for consistency with the HTML spec.
    """

    def __setitem__(self, key: str, value: Any) -> None:
        """Set an attribute value, possibly modifying it to comply with
        the XML spec.

        This just means converting common non-string values to
        strings: XML attributes may have "any literal string as a
        value."
        """
        if value is None:
            value = ""
        if isinstance(value, bool):
            # XML does not define any rules for boolean attributes.
            # Preserve the old Beautiful Soup behavior (a bool that
            # gets converted to a string on output) rather than
            # guessing what the value should be.
            pass
        elif isinstance(value, (int, float)):
            # It's dangerous to convert _every_ attribute value into a
            # plain string, since an attribute value may be a more
            # sophisticated string-like object
            # (e.g. CharsetMetaAttributeValue). But we can definitely
            # convert numeric values and booleans, which are the most common.
            value = str(value)

        super().__setitem__(key, value)


class HTMLAttributeDict(AttributeDict):
    """A dictionary for holding a Tag's attributes, which processes
    incoming values for consistency with the HTML spec, which says
    'Attribute values are a mixture of text and character
    references...'

    Basically, this means converting common non-string values into
    strings, like XMLAttributeDict, though HTML also has some rules
    around boolean attributes that XML doesn't have.
    """

    def __setitem__(self, key: str, value: Any) -> None:
        """Set an attribute value, possibly modifying it to comply
        with the HTML spec,
        """
        if value in (False, None):
            # 'The values "true" and "false" are not allowed on
            # boolean attributes. To represent a false value, the
            # attribute has to be omitted altogether.'
            if key in self:
                del self[key]
            return
        if isinstance(value, bool):
            # 'If the [boolean] attribute is present, its value must
            # either be the empty string or a value that is an ASCII
            # case-insensitive match for the attribute's canonical
            # name, with no leading or trailing whitespace.'
            #
            # [fixme] It's not clear to me whether "canonical name"
            # means fully-qualified name, unqualified name, or
            # (probably not) name with namespace prefix. For now I'm
            # going with unqualified name.
            if isinstance(key, NamespacedAttribute):
                value = key.name
            else:
                value = key
        elif isinstance(value, (int, float)):
            # See note in XMLAttributeDict for the reasoning why we
            # only do this to numbers.
            value = str(value)
        super().__setitem__(key, value)


class ContentMetaAttributeValue(AttributeValueWithCharsetSubstitution):
    """A generic stand-in for the value of a ``<meta>`` tag's ``content``
    attribute.

    When Beautiful Soup parses the markup:
     ``<meta http-equiv="content-type" content="text/html; charset=utf8">``

    The value of the ``content`` attribute will become one of these objects.

    If the document is later encoded to an encoding other than UTF-8, its
    ``<meta>`` tag will mention the new encoding instead of ``utf8``.
    """

    #: Match the 'charset' argument inside the 'content' attribute
    #: of a <meta> tag.
    #: :meta private:
    CHARSET_RE: Pattern[str] = re.compile(r"((^|;)\s*charset=)([^;]*)", re.M)

    def __new__(cls, original_value: str) -> Self:
        cls.CHARSET_RE.search(original_value)
        obj = str.__new__(cls, original_value)
        obj.original_value = original_value
        return obj

    def substitute_encoding(self, eventual_encoding: _Encoding = "utf-8") -> str:
        """When an HTML document is being encoded to a given encoding, the
        value of the ``charset=`` in a ``<meta>`` tag's ``content`` becomes
        the name of the encoding.
        """
        if eventual_encoding in PYTHON_SPECIFIC_ENCODINGS:
            return self.CHARSET_RE.sub("", self.original_value)

        def rewrite(match: re.Match[str]) -> str:
            return match.group(1) + eventual_encoding

        return self.CHARSET_RE.sub(rewrite, self.original_value)


class PageElement(object):
    """An abstract class representing a single element in the parse tree.

    `NavigableString`, `Tag`, etc. are all subclasses of
    `PageElement`. For this reason you'll see a lot of methods that
    return `PageElement`, but you'll never see an actual `PageElement`
    object. For the most part you can think of `PageElement` as
    meaning "a `Tag` or a `NavigableString`."
    """

    #: In general, we can't tell just by looking at an element whether
    #: it's contained in an XML document or an HTML document. But for
    #: `Tag` objects (q.v.) we can store this information at parse time.
    #: :meta private:
    known_xml: Optional[bool] = None

    #: Whether or not this element has been decomposed from the tree
    #: it was created in.
    _decomposed: bool

    parent: Optional[Tag]
    next_element: _AtMostOneElement
    previous_element: _AtMostOneElement
    next_sibling: _AtMostOneElement
    previous_sibling: _AtMostOneElement

    #: Whether or not this element is hidden from generated output.
    #: Only the `BeautifulSoup` object itself is hidden.
    hidden: bool = False

    def setup(
        self,
        parent: Optional[Tag] = None,
        previous_element: _AtMostOneElement = None,
        next_element: _AtMostOneElement = None,
        previous_sibling: _AtMostOneElement = None,
        next_sibling: _AtMostOneElement = None,
    ) -> None:
        """Sets up the initial relations between this element and
        other elements.

        :param parent: The parent of this element.

        :param previous_element: The element parsed immediately before
            this one.

        :param next_element: The element parsed immediately after
            this one.

        :param previous_sibling: The most recently encountered element
            on the same level of the parse tree as this one.

        :param previous_sibling: The next element to be encountered
            on the same level of the parse tree as this one.
        """
        self.parent = parent

        self.previous_element = previous_element
        if self.previous_element is not None:
            self.previous_element.next_element = self

        self.next_element = next_element
        if self.next_element is not None:
            self.next_element.previous_element = self

        self.next_sibling = next_sibling
        if self.next_sibling is not None:
            self.next_sibling.previous_sibling = self

        if (
            previous_sibling is None
            and self.parent is not None
            and self.parent.contents
        ):
            previous_sibling = self.parent.contents[-1]

        self.previous_sibling = previous_sibling
        if self.previous_sibling is not None:
            self.previous_sibling.next_sibling = self

    def format_string(self, s: str, formatter: Optional[_FormatterOrName]) -> str:
        """Format the given string using the given formatter.

        :param s: A string.
        :param formatter: A Formatter object, or a string naming one of the standard formatters.
        """
        if formatter is None:
            return s
        if not isinstance(formatter, Formatter):
            formatter = self.formatter_for_name(formatter)
        output = formatter.substitute(s)
        return output

    def formatter_for_name(
        self, formatter_name: Union[_FormatterOrName, _EntitySubstitutionFunction]
    ) -> Formatter:
        """Look up or create a Formatter for the given identifier,
        if necessary.

        :param formatter: Can be a `Formatter` object (used as-is), a
            function (used as the entity substitution hook for an
            `bs4.formatter.XMLFormatter` or
            `bs4.formatter.HTMLFormatter`), or a string (used to look
            up an `bs4.formatter.XMLFormatter` or
            `bs4.formatter.HTMLFormatter` in the appropriate registry.

        """
        if isinstance(formatter_name, Formatter):
            return formatter_name
        c: type[Formatter]
        registry: Mapping[Optional[str], Formatter]
        if self._is_xml:
            c = XMLFormatter
            registry = XMLFormatter.REGISTRY
        else:
            c = HTMLFormatter
            registry = HTMLFormatter.REGISTRY
        if callable(formatter_name):
            return c(entity_substitution=formatter_name)
        return registry[formatter_name]

    @property
    def _is_xml(self) -> bool:
        """Is this element part of an XML tree or an HTML tree?

        This is used in formatter_for_name, when deciding whether an
        XMLFormatter or HTMLFormatter is more appropriate. It can be
        inefficient, but it should be called very rarely.
        """
        if self.known_xml is not None:
            # Most of the time we will have determined this when the
            # document is parsed.
            return self.known_xml

        # Otherwise, it's likely that this element was created by
        # direct invocation of the constructor from within the user's
        # Python code.
        if self.parent is None:
            # This is the top-level object. It should have .known_xml set
            # from tree creation. If not, take a guess--BS is usually
            # used on HTML markup.
            return getattr(self, "is_xml", False)
        return self.parent._is_xml

    nextSibling = _deprecated_alias("nextSibling", "next_sibling", "4.0.0")
    previousSibling = _deprecated_alias("previousSibling", "previous_sibling", "4.0.0")

    def __deepcopy__(self, memo: Dict[Any, Any], recursive: bool = False) -> Self:
        raise NotImplementedError()

    def __copy__(self) -> Self:
        """A copy of a PageElement can only be a deep copy, because
        only one PageElement can occupy a given place in a parse tree.
        """
        return self.__deepcopy__({})

    default: Iterable[type[NavigableString]] = tuple()  #: :meta private:

    def _all_strings(
        self, strip: bool = False, types: Iterable[type[NavigableString]] = default
    ) -> Iterator[str]:
        """Yield all strings of certain classes, possibly stripping them.

        This is implemented differently in `Tag` and `NavigableString`.
        """
        raise NotImplementedError()

    @property
    def stripped_strings(self) -> Iterator[str]:
        """Yield all interesting strings in this PageElement, stripping them
        first.

        See `Tag` for information on which strings are considered
        interesting in a given context.
        """
        for string in self._all_strings(True):
            yield string

    def get_text(
        self,
        separator: str = "",
        strip: bool = False,
        types: Iterable[Type[NavigableString]] = default,
    ) -> str:
        """Get all child strings of this PageElement, concatenated using the
        given separator.

        :param separator: Strings will be concatenated using this separator.

        :param strip: If True, strings will be stripped before being
            concatenated.

        :param types: A tuple of NavigableString subclasses. Any
            strings of a subclass not found in this list will be
            ignored. Although there are exceptions, the default
            behavior in most cases is to consider only NavigableString
            and CData objects. That means no comments, processing
            instructions, etc.

        :return: A string.
        """
        return separator.join([s for s in self._all_strings(strip, types=types)])

    getText = get_text
    text = property(get_text)

    def replace_with(self, *args: _InsertableElement) -> Self:
        """Replace this `PageElement` with one or more other elements,
        objects, keeping the rest of the tree the same.

        :return: This `PageElement`, no longer part of the tree.
        """
        if self.parent is None:
            raise ValueError(
                "Cannot replace one element with another when the "
                "element to be replaced is not part of a tree."
            )
        if len(args) == 1 and args[0] is self:
            # Replacing an element with itself is a no-op.
            return self
        if any(x is self.parent for x in args):
            raise ValueError("Cannot replace a Tag with its parent.")
        old_parent = self.parent
        my_index = self.parent.index(self)
        self.extract(_self_index=my_index)
        for idx, replace_with in enumerate(args, start=my_index):
            old_parent.insert(idx, replace_with)
        return self

    replaceWith = _deprecated_function_alias("replaceWith", "replace_with", "4.0.0")

    def wrap(self, wrap_inside: Tag) -> Tag:
        """Wrap this `PageElement` inside a `Tag`.

        :return: ``wrap_inside``, occupying the position in the tree that used
           to be occupied by this object, and with this object now inside it.
        """
        me = self.replace_with(wrap_inside)
        wrap_inside.append(me)
        return wrap_inside

    def extract(self, _self_index: Optional[int] = None) -> Self:
        """Destructively rips this element out of the tree.

        :param _self_index: The location of this element in its parent's
           .contents, if known. Passing this in allows for a performance
           optimization.

        :return: this `PageElement`, no longer part of the tree.
        """
        if self.parent is not None:
            if _self_index is None:
                _self_index = self.parent.index(self)
            del self.parent.contents[_self_index]

        # Find the two elements that would be next to each other if
        # this element (and any children) hadn't been parsed. Connect
        # the two.
        last_child = self._last_descendant()

        # last_child can't be None because we passed accept_self=True
        # into _last_descendant. Worst case, last_child will be
        # self. Making this cast removes several mypy complaints later
        # on as we manipulate last_child.
        last_child = cast(PageElement, last_child)
        next_element = last_child.next_element

        if self.previous_element is not None:
            if self.previous_element is not next_element:
                self.previous_element.next_element = next_element
        if next_element is not None and next_element is not self.previous_element:
            next_element.previous_element = self.previous_element
        self.previous_element = None
        last_child.next_element = None

        self.parent = None
        if (
            self.previous_sibling is not None
            and self.previous_sibling is not self.next_sibling
        ):
            self.previous_sibling.next_sibling = self.next_sibling
        if (
            self.next_sibling is not None
            and self.next_sibling is not self.previous_sibling
        ):
            self.next_sibling.previous_sibling = self.previous_sibling
        self.previous_sibling = self.next_sibling = None
        return self

    def decompose(self) -> None:
        """Recursively destroys this `PageElement` and its children.

        The element will be removed from the tree and wiped out; so
        will everything beneath it.

        The behavior of a decomposed `PageElement` is undefined and you
        should never use one for anything, but if you need to *check*
        whether an element has been decomposed, you can use the
        `PageElement.decomposed` property.
        """
        self.extract()
        e: _AtMostOneElement = self
        next_up: _AtMostOneElement = None
        while e is not None:
            next_up = e.next_element
            e.__dict__.clear()
            if isinstance(e, Tag):
                e.name = ""
                e.contents = []
            e._decomposed = True
            e = next_up

    def _last_descendant(
        self, is_initialized: bool = True, accept_self: bool = True
    ) -> _AtMostOneElement:
        """Finds the last element beneath this object to be parsed.

        Special note to help you figure things out if your type
        checking is tripped up by the fact that this method returns
        _AtMostOneElement instead of PageElement: the only time
        this method returns None is if `accept_self` is False and the
        `PageElement` has no children--either it's a NavigableString
        or an empty Tag.

        :param is_initialized: Has `PageElement.setup` been called on
            this `PageElement` yet?

        :param accept_self: Is ``self`` an acceptable answer to the
            question?
        """
        if is_initialized and self.next_sibling is not None:
            last_child = self.next_sibling.previous_element
        else:
            last_child = self
            while isinstance(last_child, Tag) and last_child.contents:
                last_child = last_child.contents[-1]
        if not accept_self and last_child is self:
            last_child = None
        return last_child

    _lastRecursiveChild = _deprecated_alias(
        "_lastRecursiveChild", "_last_descendant", "4.0.0"
    )

    def insert_before(self, *args: _InsertableElement) -> List[PageElement]:
        """Makes the given element(s) the immediate predecessor of this one.

        All the elements will have the same `PageElement.parent` as
        this one, and the given elements will occur immediately before
        this one.

        :param args: One or more PageElements.

        :return The list of PageElements that were inserted.
        """
        parent = self.parent
        if parent is None:
            raise ValueError("Element has no parent, so 'before' has no meaning.")
        if any(x is self for x in args):
            raise ValueError("Can't insert an element before itself.")
        results: List[PageElement] = []
        for predecessor in args:
            # Extract first so that the index won't be screwed up if they
            # are siblings.
            if isinstance(predecessor, PageElement):
                predecessor.extract()
            index = parent.index(self)
            results.extend(parent.insert(index, predecessor))

        return results

    def insert_after(self, *args: _InsertableElement) -> List[PageElement]:
        """Makes the given element(s) the immediate successor of this one.

        The elements will have the same `PageElement.parent` as this
        one, and the given elements will occur immediately after this
        one.

        :param args: One or more PageElements.

        :return The list of PageElements that were inserted.
        """
        # Do all error checking before modifying the tree.
        parent = self.parent
        if parent is None:
            raise ValueError("Element has no parent, so 'after' has no meaning.")
        if any(x is self for x in args):
            raise ValueError("Can't insert an element after itself.")

        offset = 0
        results: List[PageElement] = []
        for successor in args:
            # Extract first so that the index won't be screwed up if they
            # are siblings.
            if isinstance(successor, PageElement):
                successor.extract()
            index = parent.index(self)
            results.extend(parent.insert(index + 1 + offset, successor))
            offset += 1

        return results

    # For the suppression of this pyright warning, see discussion here:
    # https://github.com/microsoft/pyright/issues/10929
    @overload
    def find_next( # pyright: ignore [reportOverlappingOverload]
            self,
            name: _FindMethodName = None,
            attrs: Optional[_StrainableAttributes] = None,
            string: None=None,
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        ...

    @overload
    def find_next(
            self,
            name: None=None,
            attrs: None=None,
            string: _StrainableString="",
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneNavigableString:
        ...

    def find_next(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ) -> Union[_AtMostOneTag,_AtMostOneNavigableString,_AtMostOneElement]:
        """Find the first PageElement that matches the given criteria and
        appears later in the document than this PageElement.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a NavigableString with specific text.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_one(self.find_all_next, name, attrs, string, **kwargs)

    findNext = _deprecated_function_alias("findNext", "find_next", "4.0.0")

    @overload
    def find_all_next( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def find_all_next(
        self,
        name: None = None,
        attrs: None = None,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def find_all_next(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Find all `PageElement` objects that match the given criteria and
        appear later in the document than this `PageElement`.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a NavigableString with specific text.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_all(
            name,
            attrs,
            string,
            limit,
            self.next_elements,
            _stacklevel=_stacklevel + 1,
            **kwargs,
        )

    findAllNext = _deprecated_function_alias("findAllNext", "find_all_next", "4.0.0")

    @overload
    def find_next_sibling( # pyright: ignore [reportOverlappingOverload]
            self,
            name: _FindMethodName = None,
            attrs: Optional[_StrainableAttributes] = None,
            string: None=None,
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        ...

    @overload
    def find_next_sibling(
            self,
            name: None=None,
            attrs: None=None,
            string: _StrainableString="",
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneNavigableString:
        ...

    def find_next_sibling(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ) -> Union[_AtMostOneTag,_AtMostOneNavigableString,_AtMostOneElement]:
        """Find the closest sibling to this PageElement that matches the
        given criteria and appears later in the document.

        All find_* methods take a common set of arguments. See the
        online documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a `NavigableString` with specific text.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_one(self.find_next_siblings, name, attrs, string, **kwargs)

    findNextSibling = _deprecated_function_alias(
        "findNextSibling", "find_next_sibling", "4.0.0"
    )

    @overload
    def find_next_siblings( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def find_next_siblings(
        self,
        name: None = None,
        attrs: None = None,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def find_next_siblings(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Find all siblings of this `PageElement` that match the given criteria
        and appear later in the document.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a `NavigableString` with specific text.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_all(
            name,
            attrs,
            string,
            limit,
            self.next_siblings,
            _stacklevel=_stacklevel + 1,
            **kwargs,
        )

    findNextSiblings = _deprecated_function_alias(
        "findNextSiblings", "find_next_siblings", "4.0.0"
    )
    fetchNextSiblings = _deprecated_function_alias(
        "fetchNextSiblings", "find_next_siblings", "3.0.0"
    )

    @overload
    def find_previous( # pyright: ignore [reportOverlappingOverload]
            self,
            name: _FindMethodName = None,
            attrs: Optional[_StrainableAttributes] = None,
            string: None=None,
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        ...

    @overload
    def find_previous(
            self,
            name: None=None,
            attrs: None=None,
            string: _StrainableString="",
           **kwargs: _StrainableAttribute,
    ) -> _AtMostOneNavigableString:
        ...

    def find_previous(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ) -> Union[_AtMostOneTag,_AtMostOneNavigableString,_AtMostOneElement]:
        """Look backwards in the document from this `PageElement` and find the
        first `PageElement` that matches the given criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a `NavigableString` with specific text.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_one(self.find_all_previous, name, attrs, string, **kwargs)

    findPrevious = _deprecated_function_alias("findPrevious", "find_previous", "3.0.0")

    @overload
    def find_all_previous( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def find_all_previous(
        self,
        name: None = None,
        attrs: None = None,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def find_all_previous(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Look backwards in the document from this `PageElement` and find all
        `PageElement` that match the given criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a `NavigableString` with specific text.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_all(
            name,
            attrs,
            string,
            limit,
            self.previous_elements,
            _stacklevel=_stacklevel + 1,
            **kwargs,
        )

    findAllPrevious = _deprecated_function_alias(
        "findAllPrevious", "find_all_previous", "4.0.0"
    )
    fetchAllPrevious = _deprecated_function_alias(
        "fetchAllPrevious", "find_all_previous", "3.0.0"
    )

    @overload
    def find_previous_sibling( # pyright: ignore [reportOverlappingOverload]
            self,
            name: _FindMethodName = None,
            attrs: Optional[_StrainableAttributes] = None,
            string: None=None,
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        ...

    @overload
    def find_previous_sibling(
            self,
            name: None=None,
            attrs: None=None,
            string: _StrainableString="",
           **kwargs: _StrainableAttribute,
    ) -> _AtMostOneNavigableString:
        ...

    def find_previous_sibling(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ) -> Union[_AtMostOneTag,_AtMostOneNavigableString,_AtMostOneElement]:
        """Returns the closest sibling to this `PageElement` that matches the
        given criteria and appears earlier in the document.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a `NavigableString` with specific text.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_one(
            self.find_previous_siblings, name, attrs, string, **kwargs
        )

    findPreviousSibling = _deprecated_function_alias(
        "findPreviousSibling", "find_previous_sibling", "4.0.0"
    )

    @overload
    def find_previous_siblings( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def find_previous_siblings(
        self,
        name: None = None,
        attrs: None = None,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def find_previous_siblings(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Returns all siblings to this PageElement that match the
        given criteria and appear earlier in the document.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param string: A filter for a NavigableString with specific text.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        return self._find_all(
            name,
            attrs,
            string,
            limit,
            self.previous_siblings,
            _stacklevel=_stacklevel + 1,
            **kwargs,
        )

    findPreviousSiblings = _deprecated_function_alias(
        "findPreviousSiblings", "find_previous_siblings", "4.0.0"
    )
    fetchPreviousSiblings = _deprecated_function_alias(
        "fetchPreviousSiblings", "find_previous_siblings", "3.0.0"
    )

    def find_parent(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        """Find the closest parent of this PageElement that matches the given
        criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param self: Whether the PageElement itself should be considered
           as one of its 'parents'.
        :kwargs: Additional filters on attribute values.
        """
        # NOTE: We can't use _find_one because findParents takes a different
        # set of arguments.
        r = None
        results = self.find_parents(
            name, attrs, 1, _stacklevel=3, **kwargs
        )
        if results:
            r = results[0]
        return r

    findParent = _deprecated_function_alias("findParent", "find_parent", "4.0.0")

    def find_parents(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        """Find all parents of this `PageElement` that match the given criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        iterator = self.parents
        # Only Tags can have children, so this ResultSet will contain
        # nothing but Tags.
        return cast(ResultSet[Tag], self._find_all(
            name, attrs, None, limit, iterator, _stacklevel=_stacklevel + 1, **kwargs
        ))

    findParents = _deprecated_function_alias("findParents", "find_parents", "4.0.0")
    fetchParents = _deprecated_function_alias("fetchParents", "find_parents", "3.0.0")

    @property
    def next(self) -> _AtMostOneElement:
        """The `PageElement`, if any, that was parsed just after this one."""
        return self.next_element

    @property
    def previous(self) -> _AtMostOneElement:
        """The `PageElement`, if any, that was parsed just before this one."""
        return self.previous_element

    # These methods do the real heavy lifting.

    def _find_one(
        self,
        # TODO-TYPING: "There is no syntax to indicate optional or
        # keyword arguments; such function types are rarely used
        # as callback types." - So, not sure how to get more
        # specific here.
        method: Callable,
        name: _FindMethodName,
        attrs: Optional[_StrainableAttributes],
        string: Optional[_StrainableString],
        **kwargs: _StrainableAttribute,
    ) -> _AtMostOneElement:
        r: _AtMostOneElement = None
        results: _QueryResults = method(name, attrs, string, 1, _stacklevel=4, **kwargs)
        if results:
            r = results[0]
        return r

    def _find_all(
        self,
        name: _FindMethodName,
        attrs: Optional[_StrainableAttributes],
        string: Optional[_StrainableString],
        limit: Optional[int],
        generator: Iterator[PageElement],
        _stacklevel: int = 3,
        **kwargs: _StrainableAttribute,
    ) -> _QueryResults:
        """Iterates over a generator looking for things that match."""

        if string is None and "text" in kwargs:
            string = kwargs.pop("text")
            warnings.warn(
                "The 'text' argument to find()-type methods is deprecated. Use 'string' instead.",
                DeprecationWarning,
                stacklevel=_stacklevel,
            )

        if "_class" in kwargs:
            warnings.warn(
                AttributeResemblesVariableWarning.MESSAGE
                % dict(
                    original="_class",
                    autocorrect="class_",
                ),
                AttributeResemblesVariableWarning,
                stacklevel=_stacklevel,
            )

        from bs4.filter import ElementFilter

        if isinstance(name, ElementFilter):
            matcher = name
        else:
            matcher = SoupStrainer(name, attrs, string, **kwargs)

        result: MutableSequence[_OneElement]
        if string is None and not limit and not attrs and not kwargs:
            if name is True or name is None:
                # Optimization to find all tags.
                result = [element for element in generator if isinstance(element, Tag)]
                return ResultSet(matcher, result)
            elif isinstance(name, str):
                # Optimization to find all tags with a given name.
                if name.count(":") == 1:
                    # This is a name with a prefix. If this is a namespace-aware document,
                    # we need to match the local name against tag.name. If not,
                    # we need to match the fully-qualified name against tag.name.
                    prefix, local_name = name.split(":", 1)
                else:
                    prefix = None
                    local_name = name
                result = []
                for element in generator:
                    if not isinstance(element, Tag):
                        continue
                    if element.name == name or (
                        element.name == local_name
                        and (prefix is None or element.prefix == prefix)
                    ):
                        result.append(element)
                return ResultSet(matcher, result)
        return matcher.find_all(generator, limit)

    # These generators can be used to navigate starting from both
    # NavigableStrings and Tags.
    @property
    def next_elements(self) -> Iterator[PageElement]:
        """All PageElements that were parsed after this one."""
        i = self.next_element
        while i is not None:
            successor = i.next_element
            yield i
            i = successor

    @property
    def self_and_next_elements(self) -> Iterator[PageElement]:
        """This PageElement, then all PageElements that were parsed after it."""
        return self._self_and(self.next_elements)

    @property
    def next_siblings(self) -> Iterator[PageElement]:
        """All PageElements that are siblings of this one but were parsed
        later.
        """
        i = self.next_sibling
        while i is not None:
            successor = i.next_sibling
            yield i
            i = successor

    @property
    def self_and_next_siblings(self) -> Iterator[PageElement]:
        """This PageElement, then all of its siblings."""
        return self._self_and(self.next_siblings)

    @property
    def previous_elements(self) -> Iterator[PageElement]:
        """All PageElements that were parsed before this one.

        :yield: A sequence of PageElements.
        """
        i = self.previous_element
        while i is not None:
            successor = i.previous_element
            yield i
            i = successor

    @property
    def self_and_previous_elements(self) -> Iterator[PageElement]:
        """This PageElement, then all elements that were parsed
        earlier."""
        return self._self_and(self.previous_elements)

    @property
    def previous_siblings(self) -> Iterator[PageElement]:
        """All PageElements that are siblings of this one but were parsed
        earlier.

        :yield: A sequence of PageElements.
        """
        i = self.previous_sibling
        while i is not None:
            successor = i.previous_sibling
            yield i
            i = successor

    @property
    def self_and_previous_siblings(self) -> Iterator[PageElement]:
        """This PageElement, then all of its siblings that were parsed
        earlier."""
        return self._self_and(self.previous_siblings)

    @property
    def parents(self) -> Iterator[Tag]:
        """All elements that are parents of this PageElement.

        :yield: A sequence of Tags, ending with a BeautifulSoup object.
        """
        i = self.parent
        while i is not None:
            successor = i.parent
            yield i
            i = successor

    @property
    def self_and_parents(self) -> Iterator[PageElement]:
        """This element, then all of its parents.

        :yield: A sequence of PageElements, ending with a BeautifulSoup object.
        """
        return self._self_and(self.parents)

    def _self_and(self, other_generator:Iterator[PageElement]) -> Iterator[PageElement]:
        """Modify a generator by yielding this element, then everything
        yielded by the other generator.
        """
        if not self.hidden:
            yield self
        for i in other_generator:
            yield i

    @property
    def decomposed(self) -> bool:
        """Check whether a PageElement has been decomposed."""
        return getattr(self, "_decomposed", False) or False

    @_deprecated("next_elements", "4.0.0")
    def nextGenerator(self) -> Iterator[PageElement]:
        ":meta private:"
        return self.next_elements

    @_deprecated("next_siblings", "4.0.0")
    def nextSiblingGenerator(self) -> Iterator[PageElement]:
        ":meta private:"
        return self.next_siblings

    @_deprecated("previous_elements", "4.0.0")
    def previousGenerator(self) -> Iterator[PageElement]:
        ":meta private:"
        return self.previous_elements

    @_deprecated("previous_siblings", "4.0.0")
    def previousSiblingGenerator(self) -> Iterator[PageElement]:
        ":meta private:"
        return self.previous_siblings

    @_deprecated("parents", "4.0.0")
    def parentGenerator(self) -> Iterator[PageElement]:
        ":meta private:"
        return self.parents


class NavigableString(str, PageElement):
    """A Python string that is part of a parse tree.

    When Beautiful Soup parses the markup ``<b>penguin</b>``, it will
    create a `NavigableString` for the string "penguin".
    """

    #: A string prepended to the body of the 'real' string
    #: when formatting it as part of a document, such as the '<!--'
    #: in an HTML comment.
    PREFIX: str = ""

    #: A string appended to the body of the 'real' string
    #: when formatting it as part of a document, such as the '-->'
    #: in an HTML comment.
    SUFFIX: str = ""

    def __new__(cls, value: Union[str, bytes]) -> Self:
        """Create a new NavigableString.

        When unpickling a NavigableString, this method is called with
        the string in DEFAULT_OUTPUT_ENCODING. That encoding needs to be
        passed in to the superclass's __new__ or the superclass won't know
        how to handle non-ASCII characters.
        """
        if isinstance(value, str):
            u = str.__new__(cls, value)
        else:
            u = str.__new__(cls, value, DEFAULT_OUTPUT_ENCODING)
        u.hidden = False
        u.setup()
        return u

    def __deepcopy__(self, memo: Dict[Any, Any], recursive: bool = False) -> Self:
        """A copy of a NavigableString has the same contents and class
        as the original, but it is not connected to the parse tree.

        :param recursive: This parameter is ignored; it's only defined
           so that NavigableString.__deepcopy__ implements the same
           signature as Tag.__deepcopy__.
        """
        return type(self)(self)

    def __getnewargs__(self) -> Tuple[str]:
        return (str(self),)

    # TODO-TYPING This should be SupportsIndex|slice but SupportsIndex
    # is introduced in 3.8. This can be changed once 3.7 support is dropped.
    def __getitem__(self, key: Union[int|slice]) -> str: # type:ignore
        """Raise an exception """
        if isinstance(key, str):
            raise TypeError("string indices must be integers, not '{0}'. Are you treating a NavigableString like a Tag?".format(key.__class__.__name__))
        return super(NavigableString, self).__getitem__(key)

    @property
    def string(self) -> str:
        """Convenience property defined to match `Tag.string`.

        :return: This property always returns the `NavigableString` it was
           called on.

        :meta private:
        """
        return self

    def output_ready(self, formatter: _FormatterOrName = "minimal") -> str:
        """Run the string through the provided formatter, making it
        ready for output as part of an HTML or XML document.

        :param formatter: A `Formatter` object, or a string naming one
            of the standard formatters.
        """
        output = self.format_string(self, formatter)
        return self.PREFIX + output + self.SUFFIX

    @property
    def name(self) -> None:
        """Since a NavigableString is not a Tag, it has no .name.

        This property is implemented so that code like this doesn't crash
        when run on a mixture of Tag and NavigableString objects:
            [x.name for x in tag.children]

        :meta private:
        """
        return None

    @name.setter
    def name(self, name: str) -> None:
        """Prevent NavigableString.name from ever being set.

        :meta private:
        """
        raise AttributeError("A NavigableString cannot be given a name.")

    def _all_strings(
        self, strip: bool = False, types: _OneOrMoreStringTypes = PageElement.default
    ) -> Iterator[str]:
        """Yield all strings of certain classes, possibly stripping them.

        This makes it easy for NavigableString to implement methods
        like get_text() as conveniences, creating a consistent
        text-extraction API across all PageElements.

        :param strip: If True, all strings will be stripped before being
            yielded.

        :param types: A tuple of NavigableString subclasses. If this
            NavigableString isn't one of those subclasses, the
            sequence will be empty. By default, the subclasses
            considered are NavigableString and CData objects. That
            means no comments, processing instructions, etc.

        :yield: A sequence that either contains this string, or is empty.
        """
        if types is self.default:
            # This is kept in Tag because it's full of subclasses of
            # this class, which aren't defined until later in the file.
            types = Tag.MAIN_CONTENT_STRING_TYPES

        # Do nothing if the caller is looking for specific types of
        # string, and we're of a different type.
        #
        # We check specific types instead of using isinstance(self,
        # types) because all of these classes subclass
        # NavigableString. Anyone who's using this feature probably
        # wants generic NavigableStrings but not other stuff.
        my_type = type(self)
        if types is not None:
            if isinstance(types, type):
                # Looking for a single type.
                if my_type is not types:
                    return
            elif my_type not in types:
                # Looking for one of a list of types.
                return

        value = self
        if strip:
            final_value = value.strip()
        else:
            final_value = self
        if len(final_value) > 0:
            yield final_value

    @property
    def strings(self) -> Iterator[str]:
        """Yield this string, but only if it is interesting.

        This is defined the way it is for compatibility with
        `Tag.strings`. See `Tag` for information on which strings are
        interesting in a given context.

        :yield: A sequence that either contains this string, or is empty.
        """
        return self._all_strings()


class PreformattedString(NavigableString):
    """A `NavigableString` not subject to the normal formatting rules.

    This is an abstract class used for special kinds of strings such
    as comments (`Comment`) and CDATA blocks (`CData`).
    """

    PREFIX: str = ""
    SUFFIX: str = ""

    def output_ready(self, formatter: Optional[_FormatterOrName] = None) -> str:
        """Make this string ready for output by adding any subclass-specific
            prefix or suffix.

        :param formatter: A `Formatter` object, or a string naming one
            of the standard formatters. The string will be passed into the
            `Formatter`, but only to trigger any side effects: the return
            value is ignored.

        :return: The string, with any subclass-specific prefix and
           suffix added on.
        """
        if formatter is not None:
            self.format_string(self, formatter)
        return self.PREFIX + self + self.SUFFIX


class CData(PreformattedString):
    """A `CDATA section <https://dev.w3.org/html5/spec-LC/syntax.html#cdata-sections>`_."""

    PREFIX: str = "<![CDATA["
    SUFFIX: str = "]]>"


class ProcessingInstruction(PreformattedString):
    """A SGML processing instruction."""

    PREFIX: str = "<?"
    SUFFIX: str = ">"


class XMLProcessingInstruction(ProcessingInstruction):
    """An `XML processing instruction <https://www.w3.org/TR/REC-xml/#sec-pi>`_."""

    PREFIX: str = "<?"
    SUFFIX: str = "?>"


class Comment(PreformattedString):
    """An `HTML comment <https://dev.w3.org/html5/spec-LC/syntax.html#comments>`_ or `XML comment <https://www.w3.org/TR/REC-xml/#sec-comments>`_."""

    PREFIX: str = "<!--"
    SUFFIX: str = "-->"


class Declaration(PreformattedString):
    """An `XML declaration <https://www.w3.org/TR/REC-xml/#sec-prolog-dtd>`_."""

    PREFIX: str = "<?"
    SUFFIX: str = "?>"


class Doctype(PreformattedString):
    """A `document type declaration <https://www.w3.org/TR/REC-xml/#dt-doctype>`_."""

    @classmethod
    def for_name_and_ids(
        cls, name: str, pub_id: Optional[str], system_id: Optional[str]
    ) -> Doctype:
        """Generate an appropriate document type declaration for a given
        public ID and system ID.

        :param name: The name of the document's root element, e.g. 'html'.
        :param pub_id: The Formal Public Identifier for this document type,
            e.g. '-//W3C//DTD XHTML 1.1//EN'
        :param system_id: The system identifier for this document type,
            e.g. 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'
        """
        return Doctype(cls._string_for_name_and_ids(name, pub_id, system_id))

    @classmethod
    def _string_for_name_and_ids(
        cls, name: str, pub_id: Optional[str], system_id: Optional[str]
    ) -> str:
        """Generate a string to be used as the basis of a Doctype object.

        This is a separate method from for_name_and_ids() because the lxml
        TreeBuilder needs to call it.
        """
        value = name or ""
        if pub_id is not None:
            value += ' PUBLIC "%s"' % pub_id
            if system_id is not None:
                value += ' "%s"' % system_id
        elif system_id is not None:
            value += ' SYSTEM "%s"' % system_id
        return value

    PREFIX: str = "<!DOCTYPE "
    SUFFIX: str = ">\n"


class Stylesheet(NavigableString):
    """A `NavigableString` representing the contents of a `<style> HTML
    tag <https://dev.w3.org/html5/spec-LC/Overview.html#the-style-element>`_
    (probably CSS).

    Used to distinguish embedded stylesheets from textual content.
    """


class Script(NavigableString):
    """A `NavigableString` representing the contents of a `<script>
    HTML tag
    <https://dev.w3.org/html5/spec-LC/Overview.html#the-script-element>`_
    (probably Javascript).

    Used to distinguish executable code from textual content.
    """


class TemplateString(NavigableString):
    """A `NavigableString` representing a string found inside an `HTML
    <template> tag <https://html.spec.whatwg.org/multipage/scripting.html#the-template-element>`_
    embedded in a larger document.

    Used to distinguish such strings from the main body of the document.
    """


class RubyTextString(NavigableString):
    """A NavigableString representing the contents of an `<rt> HTML
    tag <https://dev.w3.org/html5/spec-LC/text-level-semantics.html#the-rt-element>`_.

    Can be used to distinguish such strings from the strings they're
    annotating.
    """


class RubyParenthesisString(NavigableString):
    """A NavigableString representing the contents of an `<rp> HTML
    tag <https://dev.w3.org/html5/spec-LC/text-level-semantics.html#the-rp-element>`_.
    """


class Tag(PageElement):
    """An HTML or XML tag that is part of a parse tree, along with its
    attributes, contents, and relationships to other parts of the tree.

    When Beautiful Soup parses the markup ``<b>penguin</b>``, it will
    create a `Tag` object representing the ``<b>`` tag. You can
    instantiate `Tag` objects directly, but it's not necessary unless
    you're adding entirely new markup to a parsed document. Most of
    the constructor arguments are intended for use by the `TreeBuilder`
    that's parsing a document.

    :param parser: A `BeautifulSoup` object representing the parse tree this
        `Tag` will be part of.
    :param builder: The `TreeBuilder` being used to build the tree.
    :param name: The name of the tag.
    :param namespace: The URI of this tag's XML namespace, if any.
    :param prefix: The prefix for this tag's XML namespace, if any.
    :param attrs: A dictionary of attribute values.
    :param parent: The `Tag` to use as the parent of this `Tag`. May be
       the `BeautifulSoup` object itself.
    :param previous: The `PageElement` that was parsed immediately before
        parsing this tag.
    :param is_xml: If True, this is an XML tag. Otherwise, this is an
        HTML tag.
    :param sourceline: The line number where this tag was found in its
        source document.
    :param sourcepos: The character position within ``sourceline`` where this
        tag was found.
    :param can_be_empty_element: If True, this tag should be
        represented as <tag/>. If False, this tag should be represented
        as <tag></tag>.
    :param cdata_list_attributes: A dictionary of attributes whose values should
        be parsed as lists of strings if they ever show up on this tag.
    :param preserve_whitespace_tags: Names of tags whose contents
        should have their whitespace preserved if they are encountered inside
        this tag.
    :param interesting_string_types: When iterating over this tag's
        string contents in methods like `Tag.strings` or
        `PageElement.get_text`, these are the types of strings that are
        interesting enough to be considered. By default,
        `NavigableString` (normal strings) and `CData` (CDATA
        sections) are the only interesting string subtypes.
    :param namespaces: A dictionary mapping currently active
        namespace prefixes to URIs, as of the point in the parsing process when
        this tag was encountered. This can be used later to
        construct CSS selectors.

    """

    def __init__(
        self,
        parser: Optional[BeautifulSoup] = None,
        builder: Optional[TreeBuilder] = None,
        name: Optional[str] = None,
        namespace: Optional[str] = None,
        prefix: Optional[str] = None,
        attrs: Optional[_RawOrProcessedAttributeValues] = None,
        parent: Optional[Union[BeautifulSoup, Tag]] = None,
        previous: _AtMostOneElement = None,
        is_xml: Optional[bool] = None,
        sourceline: Optional[int] = None,
        sourcepos: Optional[int] = None,
        can_be_empty_element: Optional[bool] = None,
        cdata_list_attributes: Optional[Dict[str, Set[str]]] = None,
        preserve_whitespace_tags: Optional[Set[str]] = None,
        interesting_string_types: Optional[Set[Type[NavigableString]]] = None,
        namespaces: Optional[Dict[str, str]] = None,
        # NOTE: Any new arguments here need to be mirrored in
        # Tag.copy_self, and potentially BeautifulSoup.new_tag
        # as well.
    ):
        if parser is None:
            self.parser_class = None
        else:
            # We don't actually store the parser object: that lets extracted
            # chunks be garbage-collected.
            self.parser_class = parser.__class__
        if name is None:
            raise ValueError("No value provided for new tag's name.")
        self.name = name
        self.namespace = namespace
        self._namespaces = namespaces or {}
        self.prefix = prefix
        if (not builder or builder.store_line_numbers) and (
            sourceline is not None or sourcepos is not None
        ):
            self.sourceline = sourceline
            self.sourcepos = sourcepos
        else:
            self.sourceline = sourceline
            self.sourcepos = sourcepos

        attr_dict_class: type[AttributeDict]
        attribute_value_list_class: type[AttributeValueList]
        if builder is None:
            if is_xml:
                attr_dict_class = XMLAttributeDict
            else:
                attr_dict_class = HTMLAttributeDict
            attribute_value_list_class = AttributeValueList
        else:
            attr_dict_class = builder.attribute_dict_class
            attribute_value_list_class = builder.attribute_value_list_class
        self.attribute_value_list_class = attribute_value_list_class

        if attrs is None:
            self.attrs = attr_dict_class()
        else:
            if builder is not None and builder.cdata_list_attributes:
                self.attrs = builder._replace_cdata_list_attribute_values(
                    self.name, attrs
                )
            else:
                self.attrs = attr_dict_class()
                # Make sure that the values of any multi-valued
                # attributes (e.g. when a Tag is copied) are stored in
                # new lists.
                for k, v in attrs.items():
                    if isinstance(v, list):
                        v = v.__class__(v)
                    self.attrs[k] = v

        # If possible, determine ahead of time whether this tag is an
        # XML tag.
        if builder:
            self.known_xml = builder.is_xml
        else:
            self.known_xml = is_xml
        self.contents: List[PageElement] = []
        self.setup(parent, previous)
        self.hidden = False

        if builder is None:
            # In the absence of a TreeBuilder, use whatever values were
            # passed in here. They're probably None, unless this is a copy of some
            # other tag.
            self.can_be_empty_element = can_be_empty_element
            self.cdata_list_attributes = cdata_list_attributes
            self.preserve_whitespace_tags = preserve_whitespace_tags
            self.interesting_string_types = interesting_string_types
        else:
            # Set up any substitutions for this tag, such as the charset in a META tag.
            self.attribute_value_list_class = builder.attribute_value_list_class
            builder.set_up_substitutions(self)

            # Ask the TreeBuilder whether this tag might be an empty-element tag.
            self.can_be_empty_element = builder.can_be_empty_element(name)

            # Keep track of the list of attributes of this tag that
            # might need to be treated as a list.
            #
            # For performance reasons, we store the whole data structure
            # rather than asking the question of every tag. Asking would
            # require building a new data structure every time, and
            # (unlike can_be_empty_element), we almost never need
            # to check this.
            self.cdata_list_attributes = builder.cdata_list_attributes

            # Keep track of the names that might cause this tag to be treated as a
            # whitespace-preserved tag.
            self.preserve_whitespace_tags = builder.preserve_whitespace_tags

            if self.name in builder.string_containers:
                # This sort of tag uses a special string container
                # subclass for most of its strings. We need to be able
                # to look up the proper container subclass.
                self.interesting_string_types = {builder.string_containers[self.name]}
            else:
                self.interesting_string_types = self.MAIN_CONTENT_STRING_TYPES

    parser_class: Optional[type[BeautifulSoup]]
    name: str
    namespace: Optional[str]
    prefix: Optional[str]
    attrs: _AttributeValues
    sourceline: Optional[int]
    sourcepos: Optional[int]
    known_xml: Optional[bool]
    contents: List[PageElement]
    hidden: bool
    interesting_string_types: Optional[Set[Type[NavigableString]]]

    can_be_empty_element: Optional[bool]
    cdata_list_attributes: Optional[Dict[str, Set[str]]]
    preserve_whitespace_tags: Optional[Set[str]]

    #: :meta private:
    parserClass = _deprecated_alias("parserClass", "parser_class", "4.0.0")

    def __deepcopy__(self, memo: Dict[Any, Any], recursive: bool = True) -> Self:
        """A deepcopy of a Tag is a new Tag, unconnected to the parse tree.
        Its contents are a copy of the old Tag's contents.
        """
        clone = self.copy_self()

        if recursive:
            # Clone this tag's descendants recursively, but without
            # making any recursive function calls.
            tag_stack: List[Tag] = [clone]
            for event, element in self._event_stream(self.descendants):
                if event is Tag.END_ELEMENT_EVENT:
                    # Stop appending incoming Tags to the Tag that was
                    # just closed.
                    tag_stack.pop()
                else:
                    descendant_clone = element.__deepcopy__(memo, recursive=False)
                    # Add to its parent's .contents
                    tag_stack[-1].append(descendant_clone)

                    if event is Tag.START_ELEMENT_EVENT:
                        # Add the Tag itself to the stack so that its
                        # children will be .appended to it.
                        tag_stack.append(cast(Tag, descendant_clone))
        return clone

    def copy_self(self) -> Self:
        """Create a new Tag just like this one, but with no
        contents and unattached to any parse tree.

        This is the first step in the deepcopy process, but you can
        call it on its own to create a copy of a Tag without copying its
        contents.
        """
        clone = type(self)(
            None,
            None,
            self.name,
            self.namespace,
            self.prefix,
            self.attrs,
            is_xml=self._is_xml,
            sourceline=self.sourceline,
            sourcepos=self.sourcepos,
            can_be_empty_element=self.can_be_empty_element,
            cdata_list_attributes=self.cdata_list_attributes,
            preserve_whitespace_tags=self.preserve_whitespace_tags,
            interesting_string_types=self.interesting_string_types,
            namespaces=self._namespaces,
        )
        for attr in ("can_be_empty_element", "hidden"):
            setattr(clone, attr, getattr(self, attr))
        return clone

    @property
    def is_empty_element(self) -> bool:
        """Is this tag an empty-element tag? (aka a self-closing tag)

        A tag that has contents is never an empty-element tag.

        A tag that has no contents may or may not be an empty-element
        tag. It depends on the `TreeBuilder` used to create the
        tag. If the builder has a designated list of empty-element
        tags, then only a tag whose name shows up in that list is
        considered an empty-element tag. This is usually the case
        for HTML documents.

        If the builder has no designated list of empty-element, then
        any tag with no contents is an empty-element tag. This is usually
        the case for XML documents.
        """
        return len(self.contents) == 0 and self.can_be_empty_element is True

    @_deprecated("is_empty_element", "4.0.0")
    def isSelfClosing(self) -> bool:
        ": :meta private:"
        return self.is_empty_element

    @property
    def string(self) -> Optional[str]:
        """Convenience property to get the single string within this
        `Tag`, assuming there is just one.

        :return: If this `Tag` has a single child that's a
         `NavigableString`, the return value is that string. If this
         element has one child `Tag`, the return value is that child's
         `Tag.string`, recursively. If this `Tag` has no children,
         or has more than one child, the return value is ``None``.

         If this property is unexpectedly returning ``None`` for you,
         it's probably because your `Tag` has more than one thing
         inside it.
        """
        if len(self.contents) != 1:
            return None
        child = self.contents[0]
        if isinstance(child, NavigableString):
            return child
        elif isinstance(child, Tag):
            return child.string
        return None

    @string.setter
    def string(self, string: str) -> None:
        """Replace the `Tag.contents` of this `Tag` with a single string."""
        self.clear()
        if isinstance(string, NavigableString):
            new_class = string.__class__
        else:
            new_class = NavigableString
        self.append(new_class(string))

    #: :meta private:
    MAIN_CONTENT_STRING_TYPES = {NavigableString, CData}

    def _all_strings(
        self, strip: bool = False, types: _OneOrMoreStringTypes = PageElement.default
    ) -> Iterator[str]:
        """Yield all strings of certain classes, possibly stripping them.

        :param strip: If True, all strings will be stripped before being
            yielded.

        :param types: A tuple of NavigableString subclasses. Any strings of
            a subclass not found in this list will be ignored. By
            default, the subclasses considered are the ones found in
            self.interesting_string_types. If that's not specified,
            only NavigableString and CData objects will be
            considered. That means no comments, processing
            instructions, etc.
        """
        if types is self.default:
            if self.interesting_string_types is None:
                types = self.MAIN_CONTENT_STRING_TYPES
            else:
                types = self.interesting_string_types

        for descendant in self.descendants:
            if not isinstance(descendant, NavigableString):
                continue
            descendant_type = type(descendant)
            if isinstance(types, type):
                if descendant_type is not types:
                    # We're not interested in strings of this type.
                    continue
            elif types is not None and descendant_type not in types:
                # We're not interested in strings of this type.
                continue
            if strip:
                stripped = descendant.strip()
                if len(stripped) == 0:
                    continue
                yield stripped
            else:
                yield descendant

    strings = property(_all_strings)

    def insert(self, position: int, *new_children: _InsertableElement) -> List[PageElement]:
        """Insert one or more new PageElements as a child of this `Tag`.

        This works similarly to :py:meth:`list.insert`, except you can insert
        multiple elements at once.

        :param position: The numeric position that should be occupied
           in this Tag's `Tag.children` by the first new `PageElement`.

        :param new_children: The PageElements to insert.

        :return The newly inserted PageElements.
        """
        inserted: List[PageElement] = []
        for new_child in new_children:
            inserted.extend(self._insert(position, new_child))
            position += 1
        return inserted

    def _insert(self, position: int, new_child: _InsertableElement) -> List[PageElement]:
        if new_child is None:
            raise ValueError("Cannot insert None into a tag.")
        if new_child is self:
            raise ValueError("Cannot insert a tag into itself.")
        if isinstance(new_child, str) and not isinstance(new_child, NavigableString):
            new_child = NavigableString(new_child)

        from bs4 import BeautifulSoup
        if isinstance(new_child, BeautifulSoup):
            # We don't want to end up with a situation where one BeautifulSoup
            # object contains another. Insert the BeautifulSoup's children and
            # return them.
            return self.insert(position, *list(new_child.contents))
        position = min(position, len(self.contents))
        if hasattr(new_child, "parent") and new_child.parent is not None:
            # We're 'inserting' an element that's already one
            # of this object's children.
            if new_child.parent is self:
                current_index = self.index(new_child)
                if current_index < position:
                    # We're moving this element further down the list
                    # of this object's children. That means that when
                    # we extract this element, our target index will
                    # jump down one.
                    position -= 1
                elif current_index == position:
                    # We're 'inserting' an element into its current location.
                    # This is a no-op.
                    return [new_child]
            new_child.extract()

        new_child.parent = self
        previous_child = None
        if position == 0:
            new_child.previous_sibling = None
            new_child.previous_element = self
        else:
            previous_child = self.contents[position - 1]
            new_child.previous_sibling = previous_child
            new_child.previous_sibling.next_sibling = new_child
            new_child.previous_element = previous_child._last_descendant(False)
        if new_child.previous_element is not None:
            new_child.previous_element.next_element = new_child

        new_childs_last_element = new_child._last_descendant(
            is_initialized=False, accept_self=True
        )
        # new_childs_last_element can't be None because we passed
        # accept_self=True into _last_descendant. Worst case,
        # new_childs_last_element will be new_child itself. Making
        # this cast removes several mypy complaints later on as we
        # manipulate new_childs_last_element.
        new_childs_last_element = cast(PageElement, new_childs_last_element)

        if position >= len(self.contents):
            new_child.next_sibling = None

            parent: Optional[Tag] = self
            parents_next_sibling = None
            while parents_next_sibling is None and parent is not None:
                parents_next_sibling = parent.next_sibling
                parent = parent.parent
                if parents_next_sibling is not None:
                    # We found the element that comes next in the document.
                    break
            if parents_next_sibling is not None:
                new_childs_last_element.next_element = parents_next_sibling
            else:
                # The last element of this tag is the last element in
                # the document.
                new_childs_last_element.next_element = None
        else:
            next_child = self.contents[position]
            new_child.next_sibling = next_child
            if new_child.next_sibling is not None:
                new_child.next_sibling.previous_sibling = new_child
            new_childs_last_element.next_element = next_child

        if new_childs_last_element.next_element is not None:
            new_childs_last_element.next_element.previous_element = (
                new_childs_last_element
            )
        self.contents.insert(position, new_child)

        return [new_child]

    def unwrap(self) -> Self:
        """Replace this `PageElement` with its contents.

        :return: This object, no longer part of the tree.
        """
        my_parent = self.parent
        if my_parent is None:
            raise ValueError(
                "Cannot replace an element with its contents when that "
                "element is not part of a tree."
            )
        my_index = my_parent.index(self)
        self.extract(_self_index=my_index)
        for child in reversed(self.contents[:]):
            my_parent.insert(my_index, child)
        return self

    replace_with_children = unwrap

    @_deprecated("unwrap", "4.0.0")
    def replaceWithChildren(self) -> _OneElement:
        ": :meta private:"
        return self.unwrap()

    def append(self, tag: _InsertableElement) -> PageElement:
        """
        Appends the given `PageElement` to the contents of this `Tag`.

        :param tag: A PageElement.

        :return The newly appended PageElement.
        """
        return self.insert(len(self.contents), tag)[0]

    def extend(self, tags: Union[Iterable[_InsertableElement], Tag]) -> List[PageElement]:
        """Appends one or more objects to the contents of this
        `Tag`.

        :param tags: If a list of `PageElement` objects is provided,
            they will be appended to this tag's contents, one at a time.
            If a single `Tag` is provided, its `Tag.contents` will be
            used to extend this object's `Tag.contents`.

        :return The list of PageElements that were appended.
        """
        tag_list: Iterable[_InsertableElement]

        if isinstance(tags, Tag):
            tag_list = list(tags.contents)
        elif isinstance(tags, (PageElement, str)):
            # The caller should really be using append() instead,
            # but we can make it work.
            warnings.warn(
                "A single non-Tag item was passed into Tag.extend. Use Tag.append instead.",
                UserWarning,
                stacklevel=2,
            )
            if isinstance(tags, str) and not isinstance(tags, PageElement):
                tags = NavigableString(tags)
            tag_list = [tags]
        elif isinstance(tags, Iterable):
            # Moving items around the tree may change their position in
            # the original list. Make a list that won't change.
            tag_list = list(tags)

        results: List[PageElement] = []
        for tag in tag_list:
            results.append(self.append(tag))

        return results

    def clear(self, decompose: bool = False) -> None:
        """Destroy all children of this `Tag` by calling
           `PageElement.extract` on them.

        :param decompose: If this is True, `PageElement.decompose` (a
            more destructive method) will be called instead of
            `PageElement.extract`.
        """
        for element in self.contents[:]:
            if decompose:
                element.decompose()
            else:
                element.extract()

    def smooth(self) -> None:
        """Smooth out the children of this `Tag` by consolidating consecutive
        strings.

        If you perform a lot of operations that modify the tree,
        calling this method afterwards can make pretty-printed output
        look more natural.
        """
        # Mark the first position of every pair of children that need
        # to be consolidated.  Do this rather than making a copy of
        # self.contents, since in most cases very few strings will be
        # affected.
        marked = []
        for i, a in enumerate(self.contents):
            if isinstance(a, Tag):
                # Recursively smooth children.
                a.smooth()
            if i == len(self.contents) - 1:
                # This is the last item in .contents, and it's not a
                # tag. There's no chance it needs any work.
                continue
            b = self.contents[i + 1]
            if (
                isinstance(a, NavigableString)
                and isinstance(b, NavigableString)
                and not isinstance(a, PreformattedString)
                and not isinstance(b, PreformattedString)
            ):
                marked.append(i)

        # Go over the marked positions in reverse order, so that
        # removing items from .contents won't affect the remaining
        # positions.
        for i in reversed(marked):
            a = cast(NavigableString, self.contents[i])
            b = cast(NavigableString, self.contents[i + 1])
            b.extract()
            n = NavigableString(a + b)
            a.replace_with(n)

    def index(self, element: PageElement) -> int:
        """Find the index of a child of this `Tag` (by identity, not value).

        Doing this by identity avoids issues when a `Tag` contains two
        children that have string equality.

        :param element: Look for this `PageElement` in this object's contents.
        """
        for i, child in enumerate(self.contents):
            if child is element:
                return i
        raise ValueError("Tag.index: element not in tag")

    def get(
        self, key: str, default: Optional[_AttributeValue] = None
    ) -> Optional[_AttributeValue]:
        """Returns the value of the 'key' attribute for the tag, or
        the value given for 'default' if it doesn't have that
        attribute.

        :param key: The attribute to look for.
        :param default: Use this value if the attribute is not present
            on this `Tag`.
        """
        return self.attrs.get(key, default)

    def get_attribute_list(
        self, key: str, default: Optional[AttributeValueList] = None
    ) -> AttributeValueList:
        """The same as get(), but always returns a (possibly empty) list.

        :param key: The attribute to look for.
        :param default: Use this value if the attribute is not present
            on this `Tag`.
        :return: A list of strings, usually empty or containing only a single
            value.
        """
        list_value: AttributeValueList
        value = self.get(key, default)
        if value is None:
            list_value = self.attribute_value_list_class()
        elif isinstance(value, list):
            list_value = value
        else:
            if not isinstance(value, str):
                value = cast(str, value)
            list_value = self.attribute_value_list_class([value])
        return list_value

    def has_attr(self, key: str) -> bool:
        """Does this `Tag` have an attribute with the given name?"""
        return key in self.attrs

    def __hash__(self) -> int:
        return str(self).__hash__()

    def __getitem__(self, key: str) -> _AttributeValue:
        """tag[key] returns the value of the 'key' attribute for the Tag,
        and throws an exception if it's not there."""
        return self.attrs[key]

    def __iter__(self) -> Iterator[PageElement]:
        "Iterating over a Tag iterates over its contents."
        return iter(self.contents)

    def __len__(self) -> int:
        "The length of a Tag is the length of its list of contents."
        return len(self.contents)

    def __contains__(self, x: Any) -> bool:
        return x in self.contents

    def __bool__(self) -> bool:
        "A tag is non-None even if it has no contents."
        return True

    def __setitem__(self, key: str, value: _AttributeValue) -> None:
        """Setting tag[key] sets the value of the 'key' attribute for the
        tag."""
        self.attrs[key] = value

    def __delitem__(self, key: str) -> None:
        "Deleting tag[key] deletes all 'key' attributes for the tag."
        self.attrs.pop(key, None)

    @overload
    def __call__( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        recursive: bool = True,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def __call__(
        self,
        name: None = None,
        attrs: None = None,
        recursive: bool = True,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def __call__(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        recursive: bool = True,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Calling a Tag like a function is the same as calling its
        find_all() method. Eg. tag('a') returns a list of all the A tags
        found within this tag."""
        if string is not None and (name is not None or attrs is not None or kwargs):
            # TODO: Using the @overload decorator to express the three ways you
            # could get into this path is way too much code for a rarely(?) used
            # feature.
            return cast(ResultSet[Tag], self.find_all(name, attrs, recursive, string, limit, _stacklevel, **kwargs)) #type: ignore

        if string is None:
            # If string is None, we're searching for tags.
            tags:ResultSet[Tag] = self.find_all(
                name, attrs, recursive, None, limit, _stacklevel, **kwargs
            )
            return tags

        # Otherwise, we're searching for strings.
        strings:ResultSet[NavigableString] = self.find_all(
            None, None, recursive, string, limit, _stacklevel, **kwargs
        )
        return strings

    def __getattr__(self, subtag: str) -> Optional[Tag]:
        """Calling tag.subtag is the same as calling tag.find(name="subtag")"""
        # print("Getattr %s.%s" % (self.__class__, tag))
        result: _AtMostOneElement
        if len(subtag) > 3 and subtag.endswith("Tag"):
            # BS3: soup.aTag -> "soup.find("a")
            tag_name = subtag[:-3]
            warnings.warn(
                '.%(name)sTag is deprecated, use .find("%(name)s") instead. If you really were looking for a tag called %(name)sTag, use .find("%(name)sTag")'
                % dict(name=tag_name),
                DeprecationWarning,
                stacklevel=2,
            )
            result = self.find(tag_name)
        # We special case contents to avoid recursion.
        elif not subtag.startswith("__") and not subtag == "contents":
            result = self.find(subtag)
        else:
            raise AttributeError(
                "'%s' object has no attribute '%s'" % (self.__class__, subtag)
            )
        return result

    def __eq__(self, other: Any) -> bool:
        """Returns true iff this Tag has the same name, the same attributes,
        and the same contents (recursively) as `other`."""
        if self is other:
            return True
        if not isinstance(other, Tag):
            return False
        if (
            not hasattr(other, "name")
            or not hasattr(other, "attrs")
            or not hasattr(other, "contents")
            or self.name != other.name
            or self.attrs != other.attrs
            or len(self) != len(other)
        ):
            return False
        for i, my_child in enumerate(self.contents):
            if my_child != other.contents[i]:
                return False
        return True

    def __ne__(self, other: Any) -> bool:
        """Returns true iff this Tag is not identical to `other`,
        as defined in __eq__."""
        return not self == other

    def __repr__(self) -> str:
        """Renders this `Tag` as a string."""
        return self.decode()

    __str__ = __unicode__ = __repr__

    def encode(
        self,
        encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        indent_level: Optional[int] = None,
        formatter: _FormatterOrName = "minimal",
        errors: str = "xmlcharrefreplace",
    ) -> bytes:
        """Render this `Tag` and its contents as a bytestring.

        :param encoding: The encoding to use when converting to
           a bytestring. This may also affect the text of the document,
           specifically any encoding declarations within the document.
        :param indent_level: Each line of the rendering will be
           indented this many levels. (The ``formatter`` decides what a
           'level' means, in terms of spaces or other characters
           output.) This is used internally in recursive calls while
           pretty-printing.
        :param formatter: Either a `Formatter` object, or a string naming one of
            the standard formatters.
        :param errors: An error handling strategy such as
            'xmlcharrefreplace'. This value is passed along into
            :py:meth:`str.encode` and its value should be one of the `error
            handling constants defined by Python's codecs module
            <https://docs.python.org/3/library/codecs.html#error-handlers>`_.
        """
        # Turn the data structure into Unicode, then encode the
        # Unicode.
        u = self.decode(indent_level, encoding, formatter)
        return u.encode(encoding, errors)

    def decode(
        self,
        indent_level: Optional[int] = None,
        eventual_encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        formatter: _FormatterOrName = "minimal",
        iterator: Optional[Iterator[PageElement]] = None,
    ) -> str:
        """Render this `Tag` and its contents as a Unicode string.

        :param indent_level: Each line of the rendering will be
           indented this many levels. (The ``formatter`` decides what a
           'level' means, in terms of spaces or other characters
           output.) This is used internally in recursive calls while
           pretty-printing.
        :param encoding: The encoding you intend to use when
           converting the string to a bytestring. decode() is *not*
           responsible for performing that encoding. This information
           is needed so that a real encoding can be substituted in if
           the document contains an encoding declaration (e.g. in a
           <meta> tag).
        :param formatter: Either a `Formatter` object, or a string
            naming one of the standard formatters.
        :param iterator: The iterator to use when navigating over the
            parse tree. This is only used by `Tag.decode_contents` and
            you probably won't need to use it.
        """
        pieces = []
        # First off, turn a non-Formatter `formatter` into a Formatter
        # object. This will stop the lookup from happening over and
        # over again.
        if not isinstance(formatter, Formatter):
            formatter = self.formatter_for_name(formatter)

        if indent_level is True:
            indent_level = 0

        # The currently active tag that put us into string literal
        # mode. Until this element is closed, children will be treated
        # as string literals and not pretty-printed. String literal
        # mode is turned on immediately after this tag begins, and
        # turned off immediately before it's closed. This means there
        # will be whitespace before and after the tag itself.
        string_literal_tag = None

        for event, element in self._event_stream(iterator):
            if event in (Tag.START_ELEMENT_EVENT, Tag.EMPTY_ELEMENT_EVENT):
                element = cast(Tag, element)
                piece = element._format_tag(eventual_encoding, formatter, opening=True)
            elif event is Tag.END_ELEMENT_EVENT:
                element = cast(Tag, element)
                piece = element._format_tag(eventual_encoding, formatter, opening=False)
                if indent_level is not None:
                    indent_level -= 1
            else:
                element = cast(NavigableString, element)
                piece = element.output_ready(formatter)

            # Now we need to apply the 'prettiness' -- extra
            # whitespace before and/or after this tag. This can get
            # complicated because certain tags, like <pre> and
            # <script>, can't be prettified, since adding whitespace would
            # change the meaning of the content.

            # The default behavior is to add whitespace before and
            # after an element when string literal mode is off, and to
            # leave things as they are when string literal mode is on.
            if string_literal_tag:
                indent_before = indent_after = False
            else:
                indent_before = indent_after = True

            # The only time the behavior is more complex than that is
            # when we encounter an opening or closing tag that might
            # put us into or out of string literal mode.
            if (
                event is Tag.START_ELEMENT_EVENT
                and not string_literal_tag
                and not cast(Tag, element)._should_pretty_print()
            ):
                # We are about to enter string literal mode. Add
                # whitespace before this tag, but not after. We
                # will stay in string literal mode until this tag
                # is closed.
                indent_before = True
                indent_after = False
                string_literal_tag = element
            elif event is Tag.END_ELEMENT_EVENT and element is string_literal_tag:
                # We are about to exit string literal mode by closing
                # the tag that sent us into that mode. Add whitespace
                # after this tag, but not before.
                indent_before = False
                indent_after = True
                string_literal_tag = None

            # Now we know whether to add whitespace before and/or
            # after this element.
            if indent_level is not None:
                if indent_before or indent_after:
                    if isinstance(element, NavigableString):
                        piece = piece.strip()
                    if piece:
                        piece = self._indent_string(
                            piece, indent_level, formatter, indent_before, indent_after
                        )
                if event == Tag.START_ELEMENT_EVENT:
                    indent_level += 1
            pieces.append(piece)
        return "".join(pieces)

    class _TreeTraversalEvent(object):
        """An internal class representing an event in the process
        of traversing a parse tree.

        :meta private:
        """

    # Stand-ins for the different events yielded by _event_stream
    START_ELEMENT_EVENT = _TreeTraversalEvent()  #: :meta private:
    END_ELEMENT_EVENT = _TreeTraversalEvent()  #: :meta private:
    EMPTY_ELEMENT_EVENT = _TreeTraversalEvent()  #: :meta private:
    STRING_ELEMENT_EVENT = _TreeTraversalEvent()  #: :meta private:

    def _event_stream(
        self, iterator: Optional[Iterator[PageElement]] = None
    ) -> Iterator[Tuple[_TreeTraversalEvent, PageElement]]:
        """Yield a sequence of events that can be used to reconstruct the DOM
        for this element.

        This lets us recreate the nested structure of this element
        (e.g. when formatting it as a string) without using recursive
        method calls.

        This is similar in concept to the SAX API, but it's a simpler
        interface designed for internal use. The events are different
        from SAX and the arguments associated with the events are Tags
        and other Beautiful Soup objects.

        :param iterator: An alternate iterator to use when traversing
         the tree.
        """
        tag_stack: List[Tag] = []

        iterator = iterator or self.self_and_descendants

        for c in iterator:
            # If the parent of the element we're about to yield is not
            # the tag currently on the stack, it means that the tag on
            # the stack closed before this element appeared.
            while tag_stack and c.parent != tag_stack[-1]:
                now_closed_tag = tag_stack.pop()
                yield Tag.END_ELEMENT_EVENT, now_closed_tag

            if isinstance(c, Tag):
                if c.is_empty_element:
                    yield Tag.EMPTY_ELEMENT_EVENT, c
                else:
                    yield Tag.START_ELEMENT_EVENT, c
                    tag_stack.append(c)
                    continue
            else:
                yield Tag.STRING_ELEMENT_EVENT, c

        while tag_stack:
            now_closed_tag = tag_stack.pop()
            yield Tag.END_ELEMENT_EVENT, now_closed_tag

    def _indent_string(
        self,
        s: str,
        indent_level: int,
        formatter: Formatter,
        indent_before: bool,
        indent_after: bool,
    ) -> str:
        """Add indentation whitespace before and/or after a string.

        :param s: The string to amend with whitespace.
        :param indent_level: The indentation level; affects how much
           whitespace goes before the string.
        :param indent_before: Whether or not to add whitespace
           before the string.
        :param indent_after: Whether or not to add whitespace
           (a newline) after the string.
        """
        space_before = ""
        if indent_before and indent_level:
            space_before = formatter.indent * indent_level

        space_after = ""
        if indent_after:
            space_after = "\n"

        return space_before + s + space_after

    def _format_tag(
        self, eventual_encoding: str, formatter: Formatter, opening: bool
    ) -> str:
        if self.hidden:
            # A hidden tag is invisible, although its contents
            # are visible.
            return ""

        # A tag starts with the < character (see below).

        # Then the / character, if this is a closing tag.
        closing_slash = ""
        if not opening:
            closing_slash = "/"

        # Then an optional namespace prefix.
        prefix = ""
        if self.prefix:
            prefix = self.prefix + ":"

        # Then a list of attribute values, if this is an opening tag.
        attribute_string = ""
        if opening:
            attributes = formatter.attributes(self)
            attrs = []
            for key, val in attributes:
                if val is None:
                    decoded = key
                else:
                    if isinstance(val, list) or isinstance(val, tuple):
                        val = " ".join(val)
                    elif not isinstance(val, str):
                        val = str(val)
                    elif (
                        isinstance(val, AttributeValueWithCharsetSubstitution)
                        and eventual_encoding is not None
                    ):
                        val = val.substitute_encoding(eventual_encoding)

                    text = formatter.attribute_value(val)
                    decoded = str(key) + "=" + formatter.quoted_attribute_value(text)
                attrs.append(decoded)
            if attrs:
                attribute_string = " " + " ".join(attrs)

        # Then an optional closing slash (for a void element in an
        # XML document).
        void_element_closing_slash = ""
        if self.is_empty_element:
            void_element_closing_slash = formatter.void_element_close_prefix or ""

        # Put it all together.
        return (
            "<"
            + closing_slash
            + prefix
            + self.name
            + attribute_string
            + void_element_closing_slash
            + ">"
        )

    def _should_pretty_print(self, indent_level: int = 1) -> bool:
        """Should this tag be pretty-printed?

        Most of them should, but some (such as <pre> in HTML
        documents) should not.
        """
        return indent_level is not None and (
            not self.preserve_whitespace_tags
            or self.name not in self.preserve_whitespace_tags
        )

    @overload
    def prettify(
        self,
        encoding: None = None,
        formatter: _FormatterOrName = "minimal",
    ) -> str:
        ...

    @overload
    def prettify(
        self,
        encoding: _Encoding,
        formatter: _FormatterOrName = "minimal",
    ) -> bytes:
        ...

    def prettify(
        self,
        encoding: Optional[_Encoding] = None,
        formatter: _FormatterOrName = "minimal",
    ) -> Union[str, bytes]:
        """Pretty-print this `Tag` as a string or bytestring.

        :param encoding: The encoding of the bytestring, or None if you want Unicode.
        :param formatter: A Formatter object, or a string naming one of
            the standard formatters.
        :return: A string (if no ``encoding`` is provided) or a bytestring
            (otherwise).
        """
        if encoding is None:
            return self.decode(indent_level=0, formatter=formatter)
        else:
            return self.encode(encoding=encoding, indent_level=0, formatter=formatter)

    def decode_contents(
        self,
        indent_level: Optional[int] = None,
        eventual_encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        formatter: _FormatterOrName = "minimal",
    ) -> str:
        """Renders the contents of this tag as a Unicode string.

        :param indent_level: Each line of the rendering will be
           indented this many levels. (The formatter decides what a
           'level' means in terms of spaces or other characters
           output.) Used internally in recursive calls while
           pretty-printing.

        :param eventual_encoding: The tag is destined to be
           encoded into this encoding. decode_contents() is *not*
           responsible for performing that encoding. This information
           is needed so that a real encoding can be substituted in if
           the document contains an encoding declaration (e.g. in a
           <meta> tag).

        :param formatter: A `Formatter` object, or a string naming one of
            the standard Formatters.
        """
        return self.decode(
            indent_level, eventual_encoding, formatter, iterator=self.descendants
        )

    def encode_contents(
        self,
        indent_level: Optional[int] = None,
        encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        formatter: _FormatterOrName = "minimal",
    ) -> bytes:
        """Renders the contents of this PageElement as a bytestring.

        :param indent_level: Each line of the rendering will be
           indented this many levels. (The ``formatter`` decides what a
           'level' means, in terms of spaces or other characters
           output.) This is used internally in recursive calls while
           pretty-printing.
        :param formatter: Either a `Formatter` object, or a string naming one of
            the standard formatters.
        :param encoding: The bytestring will be in this encoding.
        """
        contents = self.decode_contents(indent_level, encoding, formatter)
        return contents.encode(encoding)

    @_deprecated("encode_contents", "4.0.0")
    def renderContents(
        self,
        encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        prettyPrint: bool = False,
        indentLevel: Optional[int] = 0,
    ) -> bytes:
        """Deprecated method for BS3 compatibility.

        :meta private:
        """
        if not prettyPrint:
            indentLevel = None
        return self.encode_contents(indent_level=indentLevel, encoding=encoding)

    # Soup methods

    @overload
    def find(
            self,
            name: _FindMethodName = None,
            attrs: Optional[_StrainableAttributes] = None,
            recursive: bool = True,
            string: None=None,
            **kwargs: _StrainableAttribute,
    ) -> _AtMostOneTag:
        ...

    @overload
    def find(
            self,
            name: None=None,
            attrs: None=None,
            recursive: bool = True,
            string: _StrainableString="",
    ) -> _AtMostOneNavigableString:
        ...

    def find(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        recursive: bool = True,
        string: Optional[_StrainableString] = None,
        **kwargs: _StrainableAttribute,
    ) -> Union[_AtMostOneTag,_AtMostOneNavigableString,_AtMostOneElement]:
        """Look in the children of this PageElement and find the first
        PageElement that matches the given criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param recursive: If this is True, find() will perform a
            recursive search of this Tag's children. Otherwise,
            only the direct children will be considered.
        :param string: A filter on the `Tag.string` attribute.
        :kwargs: Additional filters on attribute values.
        """
        if string is not None and (name is not None or attrs is not None or kwargs):
            # TODO: Using the @overload decorator to express the three ways you
            # could get into this path is way too much code for a rarely(?) used
            # feature.
            elements = self.find_all(name, attrs, recursive, string, 1, _stacklevel=3, **kwargs) # type:ignore
            if elements:
                return cast(Tag, elements[0])
        elif string is None:
            tags = self.find_all(name, attrs, recursive, None, 1, _stacklevel=3, **kwargs)
            if tags:
                return cast(Tag, tags[0])
        else:
            strings = self.find_all(None, None, recursive, string, 1, _stacklevel=3, **kwargs)
            if strings:
                return cast(NavigableString, strings[0])
        return None

    findChild = _deprecated_function_alias("findChild", "find", "3.0.0")

    @overload
    def find_all( # pyright: ignore [reportOverlappingOverload]
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        recursive: bool = True,
        string: None = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeTags:
        ...

    @overload
    def find_all(
        self,
        name: None = None,
        attrs: None = None,
        recursive: bool = True,
        string: _StrainableString = "",
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> _SomeNavigableStrings:
        ...

    def find_all(
        self,
        name: _FindMethodName = None,
        attrs: Optional[_StrainableAttributes] = None,
        recursive: bool = True,
        string: Optional[_StrainableString] = None,
        limit: Optional[int] = None,
        _stacklevel: int = 2,
        **kwargs: _StrainableAttribute,
    ) -> Union[_SomeTags,_SomeNavigableStrings,_QueryResults]:
        """Look in the children of this `PageElement` and find all
        `PageElement` objects that match the given criteria.

        All find_* methods take a common set of arguments. See the online
        documentation for detailed explanations.

        :param name: A filter on tag name.
        :param attrs: Additional filters on attribute values.
        :param recursive: If this is True, find_all() will perform a
            recursive search of this PageElement's children. Otherwise,
            only the direct children will be considered.
        :param limit: Stop looking after finding this many results.
        :param _stacklevel: Used internally to improve warning messages.
        :kwargs: Additional filters on attribute values.
        """
        generator = self.descendants
        if not recursive:
            generator = self.children
        _stacklevel += 1

        if string is not None and (name is not None or attrs is not None or kwargs):
            # TODO: Using the @overload decorator to express the three ways you
            # could get into this path is way too much code for a rarely(?) used
            # feature.
            return cast(ResultSet[Tag],
                        self._find_all(name, attrs, string, limit, generator,
                                       _stacklevel=_stacklevel, **kwargs)
                        )

        if string is None:
            # If string is None, we're searching for tags.
            return cast(ResultSet[Tag], self._find_all(
                name, attrs, None, limit, generator, _stacklevel=_stacklevel, **kwargs
            ))

        # Otherwise, we're searching for strings.
        return cast(ResultSet[NavigableString], self._find_all(
            None, None, string, limit, generator, _stacklevel=_stacklevel, **kwargs
        ))

    findAll = _deprecated_function_alias("findAll", "find_all", "4.0.0")
    findChildren = _deprecated_function_alias("findChildren", "find_all", "3.0.0")

    # Generator methods
    @property
    def children(self) -> Iterator[PageElement]:
        """Iterate over all direct children of this `PageElement`."""
        return (x for x in self.contents)

    @property
    def self_and_descendants(self) -> Iterator[PageElement]:
        """Iterate over this `Tag` and its children in a
        breadth-first sequence.
        """
        return self._self_and(self.descendants)

    @property
    def descendants(self) -> Iterator[PageElement]:
        """Iterate over all children of this `Tag` in a
        breadth-first sequence.
        """
        if not len(self.contents):
            return
        # _last_descendant() can't return None here because
        # accept_self is True. Worst case, last_descendant will end up
        # as self.
        last_descendant = cast(PageElement, self._last_descendant(accept_self=True))
        stopNode = last_descendant.next_element
        current: _AtMostOneElement = self.contents[0]
        while current is not stopNode and current is not None:
            successor = current.next_element
            yield current
            current = successor

    # CSS selector code
    def select_one(
        self, selector: str, namespaces: Optional[Dict[str, str]] = None, **kwargs: Any
    ) -> Optional[Tag]:
        """Perform a CSS selection operation on the current element.

        :param selector: A CSS selector.

        :param namespaces: A dictionary mapping namespace prefixes
           used in the CSS selector to namespace URIs. By default,
           Beautiful Soup will use the prefixes it encountered while
           parsing the document.

        :param kwargs: Keyword arguments to be passed into Soup Sieve's
           soupsieve.select() method.
        """
        return self.css.select_one(selector, namespaces, **kwargs)

    def select(
        self,
        selector: str,
        namespaces: Optional[Dict[str, str]] = None,
        limit: int = 0,
        **kwargs: Any,
    ) -> ResultSet[Tag]:
        """Perform a CSS selection operation on the current element.

        This uses the SoupSieve library.

        :param selector: A string containing a CSS selector.

        :param namespaces: A dictionary mapping namespace prefixes
           used in the CSS selector to namespace URIs. By default,
           Beautiful Soup will use the prefixes it encountered while
           parsing the document.

        :param limit: After finding this number of results, stop looking.

        :param kwargs: Keyword arguments to be passed into SoupSieve's
           soupsieve.select() method.
        """
        return self.css.select(selector, namespaces, limit, **kwargs)

    @property
    def css(self) -> CSS:
        """Return an interface to the CSS selector API."""
        return CSS(self)

    # Old names for backwards compatibility
    @_deprecated("children", "4.0.0")
    def childGenerator(self) -> Iterator[PageElement]:
        """Deprecated generator.

        :meta private:
        """
        return self.children

    @_deprecated("descendants", "4.0.0")
    def recursiveChildGenerator(self) -> Iterator[PageElement]:
        """Deprecated generator.

        :meta private:
        """
        return self.descendants

    @_deprecated("has_attr", "4.0.0")
    def has_key(self, key: str) -> bool:
        """Deprecated method. This was kind of misleading because has_key()
        (attributes) was different from __in__ (contents).

        has_key() is gone in Python 3, anyway.

        :meta private:
        """
        return self.has_attr(key)


_PageElementT = TypeVar("_PageElementT", bound=PageElement)

class ResultSet(List[_PageElementT], Generic[_PageElementT]):
    """A ResultSet is a list of `PageElement` objects, gathered as the result
    of matching an :py:class:`ElementFilter` against a parse tree. Basically, a list of
    search results.
    """

    source: Optional[ElementFilter]

    def __init__(
        self, source: Optional[ElementFilter], result: Iterable[_PageElementT] = ()
    ) -> None:
        super(ResultSet, self).__init__(result)
        self.source = source

    def __getattr__(self, key: str) -> None:
        """Raise a helpful exception to explain a common code fix."""
        raise AttributeError(
            f"""ResultSet object has no attribute "{key}". You're probably treating a list of elements like a single element. Did you call find_all() when you meant to call find()?"""
        )

# Now that all the classes used by SoupStrainer have been defined,
# import SoupStrainer itself into this module to preserve the
# backwards compatibility of anyone who imports
# bs4.element.SoupStrainer.
from bs4.filter import SoupStrainer # noqa: E402

from __future__ import annotations
from typing import Callable, Dict, Iterable, Optional, Set, Tuple, TYPE_CHECKING, Union
from typing_extensions import TypeAlias
from bs4.dammit import EntitySubstitution

if TYPE_CHECKING:
    from bs4._typing import _AttributeValue


class Formatter(EntitySubstitution):
    """Describes a strategy to use when outputting a parse tree to a string.

    Some parts of this strategy come from the distinction between
    HTML4, HTML5, and XML. Others are configurable by the user.

    Formatters are passed in as the `formatter` argument to methods
    like `bs4.element.Tag.encode`. Most people won't need to
    think about formatters, and most people who need to think about
    them can pass in one of these predefined strings as `formatter`
    rather than making a new Formatter object:

    For HTML documents:
     * 'html' - HTML entity substitution for generic HTML documents. (default)
     * 'html5' - HTML entity substitution for HTML5 documents, as
                 well as some optimizations in the way tags are rendered.
     * 'html5-4.12.0' - The version of the 'html5' formatter used prior to
                        Beautiful Soup 4.13.0.
     * 'minimal' - Only make the substitutions necessary to guarantee
                   valid HTML.
     * None - Do not perform any substitution. This will be faster
              but may result in invalid markup.

    For XML documents:
     * 'html' - Entity substitution for XHTML documents.
     * 'minimal' - Only make the substitutions necessary to guarantee
                   valid XML. (default)
     * None - Do not perform any substitution. This will be faster
              but may result in invalid markup.

    """

    #: Constant name denoting HTML markup
    HTML: str = "html"

    #: Constant name denoting XML markup
    XML: str = "xml"

    #: Default values for the various constructor options when the
    #: markup language is HTML.
    HTML_DEFAULTS: Dict[str, Set[str]] = dict(
        cdata_containing_tags=set(["script", "style"]),
    )

    language: Optional[str]  #: :meta private:
    entity_substitution: Optional[_EntitySubstitutionFunction]  #: :meta private:
    void_element_close_prefix: str  #: :meta private:
    cdata_containing_tags: Set[str]  #: :meta private:
    indent: str  #: :meta private:

    #: If this is set to true by the constructor, then attributes whose
    #: values are sent to the empty string will be treated as HTML
    #: boolean attributes. (Attributes whose value is None are always
    #: rendered this way.)
    empty_attributes_are_booleans: bool

    def _default(
        self, language: str, value: Optional[Set[str]], kwarg: str
    ) -> Set[str]:
        if value is not None:
            return value
        if language == self.XML:
            # When XML is the markup language in use, all of the
            # defaults are the empty list.
            return set()

        # Otherwise, it depends on what's in HTML_DEFAULTS.
        return self.HTML_DEFAULTS[kwarg]

    def __init__(
        self,
        language: Optional[str] = None,
        entity_substitution: Optional[_EntitySubstitutionFunction] = None,
        void_element_close_prefix: str = "/",
        cdata_containing_tags: Optional[Set[str]] = None,
        empty_attributes_are_booleans: bool = False,
        indent: Union[int,str] = 1,
    ):
        r"""Constructor.

        :param language: This should be `Formatter.XML` if you are formatting
           XML markup and `Formatter.HTML` if you are formatting HTML markup.

        :param entity_substitution: A function to call to replace special
           characters with XML/HTML entities. For examples, see
           bs4.dammit.EntitySubstitution.substitute_html and substitute_xml.
        :param void_element_close_prefix: By default, void elements
           are represented as <tag/> (XML rules) rather than <tag>
           (HTML rules). To get <tag>, pass in the empty string.
        :param cdata_containing_tags: The set of tags that are defined
           as containing CDATA in this dialect. For example, in HTML,
           <script> and <style> tags are defined as containing CDATA,
           and their contents should not be formatted.
        :param empty_attributes_are_booleans: If this is set to true,
          then attributes whose values are sent to the empty string
          will be treated as `HTML boolean
          attributes<https://dev.w3.org/html5/spec-LC/common-microsyntaxes.html#boolean-attributes>`_. (Attributes
          whose value is None are always rendered this way.)
        :param indent: If indent is a non-negative integer or string,
            then the contents of elements will be indented
            appropriately when pretty-printing. An indent level of 0,
            negative, or "" will only insert newlines. Using a
            positive integer indent indents that many spaces per
            level. If indent is a string (such as "\t"), that string
            is used to indent each level. The default behavior is to
            indent one space per level.

        """
        self.language = language or self.HTML
        self.entity_substitution = entity_substitution
        self.void_element_close_prefix = void_element_close_prefix
        self.cdata_containing_tags = self._default(
            self.language, cdata_containing_tags, "cdata_containing_tags"
        )
        self.empty_attributes_are_booleans = empty_attributes_are_booleans
        if indent is None:
            indent = 0
        indent_str: str
        if isinstance(indent, int):
            if indent < 0:
                indent = 0
            indent_str = " " * indent
        elif isinstance(indent, str):
            indent_str = indent
        else:
            indent_str = " "
        self.indent = indent_str

    def substitute(self, ns: str) -> str:
        """Process a string that needs to undergo entity substitution.
        This may be a string encountered in an attribute value or as
        text.

        :param ns: A string.
        :return: The same string but with certain characters replaced by named
           or numeric entities.
        """
        if not self.entity_substitution:
            return ns
        from .element import NavigableString

        if (
            isinstance(ns, NavigableString)
            and ns.parent is not None
            and ns.parent.name in self.cdata_containing_tags
        ):
            # Do nothing.
            return ns
        # Substitute.
        return self.entity_substitution(ns)

    def attribute_value(self, value: str) -> str:
        """Process the value of an attribute.

        :param ns: A string.
        :return: A string with certain characters replaced by named
           or numeric entities.
        """
        return self.substitute(value)

    def attributes(
        self, tag: bs4.element.Tag # type:ignore
    ) -> Iterable[Tuple[str, Optional[_AttributeValue]]]:
        """Reorder a tag's attributes however you want.

        By default, attributes are sorted alphabetically. This makes
        behavior consistent between Python 2 and Python 3, and preserves
        backwards compatibility with older versions of Beautiful Soup.

        If `empty_attributes_are_booleans` is True, then
        attributes whose values are set to the empty string will be
        treated as boolean attributes.
        """
        if tag.attrs is None:
            return []

        items: Iterable[Tuple[str, _AttributeValue]] = list(tag.attrs.items())
        return sorted(
            (k, (None if self.empty_attributes_are_booleans and v == "" else v))
            for k, v in items
        )


class HTMLFormatter(Formatter):
    """A generic Formatter for HTML."""

    REGISTRY: Dict[Optional[str], HTMLFormatter] = {}

    def __init__(
        self,
        entity_substitution: Optional[_EntitySubstitutionFunction] = None,
        void_element_close_prefix: str = "/",
        cdata_containing_tags: Optional[Set[str]] = None,
        empty_attributes_are_booleans: bool = False,
        indent: Union[int,str] = 1,
    ):
        super(HTMLFormatter, self).__init__(
            self.HTML,
            entity_substitution,
            void_element_close_prefix,
            cdata_containing_tags,
            empty_attributes_are_booleans,
            indent=indent
        )


class XMLFormatter(Formatter):
    """A generic Formatter for XML."""

    REGISTRY: Dict[Optional[str], XMLFormatter] = {}

    def __init__(
        self,
        entity_substitution: Optional[_EntitySubstitutionFunction] = None,
        void_element_close_prefix: str = "/",
        cdata_containing_tags: Optional[Set[str]] = None,
        empty_attributes_are_booleans: bool = False,
        indent: Union[int,str] = 1,
    ):
        super(XMLFormatter, self).__init__(
            self.XML,
            entity_substitution,
            void_element_close_prefix,
            cdata_containing_tags,
            empty_attributes_are_booleans,
            indent=indent,
        )


# Set up aliases for the default formatters.
HTMLFormatter.REGISTRY["html"] = HTMLFormatter(
    entity_substitution=EntitySubstitution.substitute_html
)

HTMLFormatter.REGISTRY["html5"] = HTMLFormatter(
    entity_substitution=EntitySubstitution.substitute_html5,
    void_element_close_prefix="",
    empty_attributes_are_booleans=True,
)
HTMLFormatter.REGISTRY["html5-4.12"] = HTMLFormatter(
    entity_substitution=EntitySubstitution.substitute_html,
    void_element_close_prefix="",
    empty_attributes_are_booleans=True,
)
HTMLFormatter.REGISTRY["minimal"] = HTMLFormatter(
    entity_substitution=EntitySubstitution.substitute_xml
)
HTMLFormatter.REGISTRY[None] = HTMLFormatter(entity_substitution=None)
XMLFormatter.REGISTRY["html"] = XMLFormatter(
    entity_substitution=EntitySubstitution.substitute_html
)
XMLFormatter.REGISTRY["minimal"] = XMLFormatter(
    entity_substitution=EntitySubstitution.substitute_xml
)

XMLFormatter.REGISTRY[None] = XMLFormatter(entity_substitution=None)

# Define type aliases to improve readability.
#

#: A function to call to replace special characters with XML or HTML
#: entities.
_EntitySubstitutionFunction: TypeAlias = Callable[[str], str]

# Many of the output-centered methods take an argument that can either
# be a Formatter object or the name of a Formatter to be looked up.
_FormatterOrName = Union[Formatter, str]

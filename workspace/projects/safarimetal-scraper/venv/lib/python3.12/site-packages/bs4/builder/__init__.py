from __future__ import annotations

# Use of this source code is governed by the MIT license.
__license__ = "MIT"

from collections import defaultdict
import re
from types import ModuleType
from typing import (
    Any,
    cast,
    Dict,
    Iterable,
    List,
    Optional,
    Pattern,
    Set,
    Tuple,
    Type,
    TYPE_CHECKING,
)
import warnings
import sys
from bs4.element import (
    AttributeDict,
    AttributeValueList,
    CharsetMetaAttributeValue,
    ContentMetaAttributeValue,
    RubyParenthesisString,
    RubyTextString,
    Stylesheet,
    Script,
    TemplateString,
    nonwhitespace_re,
)

# Exceptions were moved to their own module in 4.13. Import here for
# backwards compatibility.
from bs4.exceptions import ParserRejectedMarkup

from bs4._typing import (
    _AttributeValues,
    _RawAttributeValue,
)

from bs4._warnings import XMLParsedAsHTMLWarning

if TYPE_CHECKING:
    from bs4 import BeautifulSoup
    from bs4.element import (
        NavigableString,
        Tag,
    )
    from bs4._typing import (
        _AttributeValue,
        _Encoding,
        _Encodings,
        _RawOrProcessedAttributeValues,
        _RawMarkup,
    )

__all__ = [
    "HTMLTreeBuilder",
    "SAXTreeBuilder",
    "TreeBuilder",
    "TreeBuilderRegistry",
]

# Some useful features for a TreeBuilder to have.
FAST = "fast"
PERMISSIVE = "permissive"
STRICT = "strict"
XML = "xml"
HTML = "html"
HTML_5 = "html5"

__all__ = [
    "TreeBuilderRegistry",
    "TreeBuilder",
    "HTMLTreeBuilder",
    "DetectsXMLParsedAsHTML",

    "ParserRejectedMarkup", # backwards compatibility only as of 4.13.0
]

class TreeBuilderRegistry(object):
    """A way of looking up TreeBuilder subclasses by their name or by desired
    features.
    """

    builders_for_feature: Dict[str, List[Type[TreeBuilder]]]
    builders: List[Type[TreeBuilder]]

    def __init__(self) -> None:
        self.builders_for_feature = defaultdict(list)
        self.builders = []

    def register(self, treebuilder_class: type[TreeBuilder]) -> None:
        """Register a treebuilder based on its advertised features.

        :param treebuilder_class: A subclass of `TreeBuilder`. its
           `TreeBuilder.features` attribute should list its features.
        """
        for feature in treebuilder_class.features:
            self.builders_for_feature[feature].insert(0, treebuilder_class)
        self.builders.insert(0, treebuilder_class)

    def lookup(self, *features: str) -> Optional[Type[TreeBuilder]]:
        """Look up a TreeBuilder subclass with the desired features.

        :param features: A list of features to look for. If none are
            provided, the most recently registered TreeBuilder subclass
            will be used.
        :return: A TreeBuilder subclass, or None if there's no
            registered subclass with all the requested features.
        """
        if len(self.builders) == 0:
            # There are no builders at all.
            return None

        if len(features) == 0:
            # They didn't ask for any features. Give them the most
            # recently registered builder.
            return self.builders[0]

        # Go down the list of features in order, and eliminate any builders
        # that don't match every feature.
        feature_list = list(features)
        feature_list.reverse()
        candidates = None
        candidate_set = None
        while len(feature_list) > 0:
            feature = feature_list.pop()
            we_have_the_feature = self.builders_for_feature.get(feature, [])
            if len(we_have_the_feature) > 0:
                if candidates is None:
                    candidates = we_have_the_feature
                    candidate_set = set(candidates)
                elif candidate_set is not None:
                    # Eliminate any candidates that don't have this feature.
                    candidate_set = candidate_set.intersection(set(we_have_the_feature))

        # The only valid candidates are the ones in candidate_set.
        # Go through the original list of candidates and pick the first one
        # that's in candidate_set.
        if candidate_set is None or candidates is None:
            return None
        for candidate in candidates:
            if candidate in candidate_set:
                return candidate
        return None


#: The `BeautifulSoup` constructor will take a list of features
#: and use it to look up `TreeBuilder` classes in this registry.
builder_registry: TreeBuilderRegistry = TreeBuilderRegistry()


class TreeBuilder(object):
    """Turn a textual document into a Beautiful Soup object tree.

    This is an abstract superclass which smooths out the behavior of
    different parser libraries into a single, unified interface.

    :param multi_valued_attributes: If this is set to None, the
     TreeBuilder will not turn any values for attributes like
     'class' into lists. Setting this to a dictionary will
     customize this behavior; look at :py:attr:`bs4.builder.HTMLTreeBuilder.DEFAULT_CDATA_LIST_ATTRIBUTES`
     for an example.

     Internally, these are called "CDATA list attributes", but that
     probably doesn't make sense to an end-user, so the argument name
     is ``multi_valued_attributes``.

    :param preserve_whitespace_tags: A set of tags to treat
     the way <pre> tags are treated in HTML. Tags in this set
     are immune from pretty-printing; their contents will always be
     output as-is.

    :param string_containers: A dictionary mapping tag names to
     the classes that should be instantiated to contain the textual
     contents of those tags. The default is to use NavigableString
     for every tag, no matter what the name. You can override the
     default by changing :py:attr:`DEFAULT_STRING_CONTAINERS`.

    :param store_line_numbers: If the parser keeps track of the line
     numbers and positions of the original markup, that information
     will, by default, be stored in each corresponding
     :py:class:`bs4.element.Tag` object. You can turn this off by
     passing store_line_numbers=False; then Tag.sourcepos and
     Tag.sourceline will always be None. If the parser you're using
     doesn't keep track of this information, then store_line_numbers
     is irrelevant.

    :param attribute_dict_class: The value of a multi-valued attribute
      (such as HTML's 'class') willl be stored in an instance of this
      class.  The default is Beautiful Soup's built-in
      `AttributeValueList`, which is a normal Python list, and you
      will probably never need to change it.
    """

    USE_DEFAULT: Any = object()  #: :meta private:

    def __init__(
        self,
        multi_valued_attributes: Dict[str, Set[str]] = USE_DEFAULT,
        preserve_whitespace_tags: Set[str] = USE_DEFAULT,
        store_line_numbers: bool = USE_DEFAULT,
        string_containers: Dict[str, Type[NavigableString]] = USE_DEFAULT,
        empty_element_tags: Set[str] = USE_DEFAULT,
        attribute_dict_class: Type[AttributeDict] = AttributeDict,
        attribute_value_list_class: Type[AttributeValueList] = AttributeValueList,
    ):
        self.soup = None
        if multi_valued_attributes is self.USE_DEFAULT:
            multi_valued_attributes = self.DEFAULT_CDATA_LIST_ATTRIBUTES
        self.cdata_list_attributes = multi_valued_attributes
        if preserve_whitespace_tags is self.USE_DEFAULT:
            preserve_whitespace_tags = self.DEFAULT_PRESERVE_WHITESPACE_TAGS
        self.preserve_whitespace_tags = preserve_whitespace_tags
        if empty_element_tags is self.USE_DEFAULT:
            self.empty_element_tags = self.DEFAULT_EMPTY_ELEMENT_TAGS
        else:
            self.empty_element_tags = empty_element_tags
        # TODO: store_line_numbers is probably irrelevant now that
        # the behavior of sourceline and sourcepos has been made consistent
        # everywhere.
        if store_line_numbers == self.USE_DEFAULT:
            store_line_numbers = self.TRACKS_LINE_NUMBERS
        self.store_line_numbers = store_line_numbers
        if string_containers == self.USE_DEFAULT:
            string_containers = self.DEFAULT_STRING_CONTAINERS
        self.string_containers = string_containers
        self.attribute_dict_class = attribute_dict_class
        self.attribute_value_list_class = attribute_value_list_class

    NAME: str = "[Unknown tree builder]"
    ALTERNATE_NAMES: Iterable[str] = []
    features: Iterable[str] = []

    is_xml: bool = False
    picklable: bool = False

    soup: Optional[BeautifulSoup]  #: :meta private:

    #: A tag will be considered an empty-element
    #: tag when and only when it has no contents.
    empty_element_tags: Optional[Set[str]] = None  #: :meta private:
    cdata_list_attributes: Dict[str, Set[str]]  #: :meta private:
    preserve_whitespace_tags: Set[str]  #: :meta private:
    string_containers: Dict[str, Type[NavigableString]]  #: :meta private:
    tracks_line_numbers: bool  #: :meta private:

    #: A value for these tag/attribute combinations is a space- or
    #: comma-separated list of CDATA, rather than a single CDATA.
    DEFAULT_CDATA_LIST_ATTRIBUTES: Dict[str, Set[str]] = defaultdict(set)

    #: Whitespace should be preserved inside these tags.
    DEFAULT_PRESERVE_WHITESPACE_TAGS: Set[str] = set()

    #: The textual contents of tags with these names should be
    #: instantiated with some class other than `bs4.element.NavigableString`.
    DEFAULT_STRING_CONTAINERS: Dict[str, Type[bs4.element.NavigableString]] = {} # type:ignore

    #: By default, tags are treated as empty-element tags if they have
    #: no contents--that is, using XML rules. HTMLTreeBuilder
    #: defines a different set of DEFAULT_EMPTY_ELEMENT_TAGS based on the
    #: HTML 4 and HTML5 standards.
    DEFAULT_EMPTY_ELEMENT_TAGS: Optional[Set[str]] = None

    #: Most parsers don't keep track of line numbers.
    TRACKS_LINE_NUMBERS: bool = False

    def initialize_soup(self, soup: BeautifulSoup) -> None:
        """The BeautifulSoup object has been initialized and is now
        being associated with the TreeBuilder.

        :param soup: A BeautifulSoup object.
        """
        self.soup = soup

    def reset(self) -> None:
        """Do any work necessary to reset the underlying parser
        for a new document.

        By default, this does nothing.
        """
        pass

    def can_be_empty_element(self, tag_name: str) -> bool:
        """Might a tag with this name be an empty-element tag?

        The final markup may or may not actually present this tag as
        self-closing.

        For instance: an HTMLBuilder does not consider a <p> tag to be
        an empty-element tag (it's not in
        HTMLBuilder.empty_element_tags). This means an empty <p> tag
        will be presented as "<p></p>", not "<p/>" or "<p>".

        The default implementation has no opinion about which tags are
        empty-element tags, so a tag will be presented as an
        empty-element tag if and only if it has no children.
        "<foo></foo>" will become "<foo/>", and "<foo>bar</foo>" will
        be left alone.

        :param tag_name: The name of a markup tag.
        """
        if self.empty_element_tags is None:
            return True
        return tag_name in self.empty_element_tags

    def feed(self, markup: _RawMarkup) -> None:
        """Run incoming markup through some parsing process."""
        raise NotImplementedError()

    def prepare_markup(
        self,
        markup: _RawMarkup,
        user_specified_encoding: Optional[_Encoding] = None,
        document_declared_encoding: Optional[_Encoding] = None,
        exclude_encodings: Optional[_Encodings] = None,
    ) -> Iterable[Tuple[_RawMarkup, Optional[_Encoding], Optional[_Encoding], bool]]:
        """Run any preliminary steps necessary to make incoming markup
        acceptable to the parser.

        :param markup: The markup that's about to be parsed.
        :param user_specified_encoding: The user asked to try this encoding
           to convert the markup into a Unicode string.
        :param document_declared_encoding: The markup itself claims to be
            in this encoding. NOTE: This argument is not used by the
            calling code and can probably be removed.
        :param exclude_encodings: The user asked *not* to try any of
            these encodings.

        :yield: A series of 4-tuples: (markup, encoding, declared encoding,
            has undergone character replacement)

            Each 4-tuple represents a strategy that the parser can try
            to convert the document to Unicode and parse it. Each
            strategy will be tried in turn.

         By default, the only strategy is to parse the markup
         as-is. See `LXMLTreeBuilderForXML` and
         `HTMLParserTreeBuilder` for implementations that take into
         account the quirks of particular parsers.

        :meta private:

        """
        yield markup, None, None, False

    def test_fragment_to_document(self, fragment: str) -> str:
        """Wrap an HTML fragment to make it look like a document.

        Different parsers do this differently. For instance, lxml
        introduces an empty <head> tag, and html5lib
        doesn't. Abstracting this away lets us write simple tests
        which run HTML fragments through the parser and compare the
        results against other HTML fragments.

        This method should not be used outside of unit tests.

        :param fragment: A fragment of HTML.
        :return: A full HTML document.
        :meta private:
        """
        return fragment

    def set_up_substitutions(self, tag: Tag) -> bool:
        """Set up any substitutions that will need to be performed on
        a `Tag` when it's output as a string.

        By default, this does nothing. See `HTMLTreeBuilder` for a
        case where this is used.

        :return: Whether or not a substitution was performed.
        :meta private:
        """
        return False

    def _replace_cdata_list_attribute_values(
        self, tag_name: str, attrs: _RawOrProcessedAttributeValues
    ) -> _AttributeValues:
        """When an attribute value is associated with a tag that can
        have multiple values for that attribute, convert the string
        value to a list of strings.

        Basically, replaces class="foo bar" with class=["foo", "bar"]

        NOTE: This method modifies its input in place.

        :param tag_name: The name of a tag.
        :param attrs: A dictionary containing the tag's attributes.
           Any appropriate attribute values will be modified in place.
        :return: The modified dictionary that was originally passed in.
        """

        # First, cast the attrs dict to _AttributeValues. This might
        # not be accurate yet, but it will be by the time this method
        # returns.
        modified_attrs = cast(_AttributeValues, attrs)
        if not modified_attrs or not self.cdata_list_attributes:
            # Nothing to do.
            return modified_attrs

        # There is at least a possibility that we need to modify one of
        # the attribute values.
        universal: Set[str] = self.cdata_list_attributes.get("*", set())
        tag_specific = self.cdata_list_attributes.get(tag_name.lower(), None)
        for attr in list(modified_attrs.keys()):
            modified_value: _AttributeValue
            if attr in universal or (tag_specific and attr in tag_specific):
                # We have a "class"-type attribute whose string
                # value is a whitespace-separated list of
                # values. Split it into a list.
                original_value: _AttributeValue = modified_attrs[attr]
                if isinstance(original_value, _RawAttributeValue):
                    # This is a _RawAttributeValue (a string) that
                    # needs to be split and converted to a
                    # AttributeValueList so it can be an
                    # _AttributeValue.
                    modified_value = self.attribute_value_list_class(
                        nonwhitespace_re.findall(original_value)
                    )
                else:
                    # html5lib calls setAttributes twice for the
                    # same tag when rearranging the parse tree. On
                    # the second call the attribute value here is
                    # already a list. This can also happen when a
                    # Tag object is cloned. If this happens, leave
                    # the value alone rather than trying to split
                    # it again.
                    modified_value = original_value
                modified_attrs[attr] = modified_value
        return modified_attrs


class SAXTreeBuilder(TreeBuilder):
    """A Beautiful Soup treebuilder that listens for SAX events.

    This is not currently used for anything, and it will be removed
    soon. It was a good idea, but it wasn't properly integrated into the
    rest of Beautiful Soup, so there have been long stretches where it
    hasn't worked properly.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        warnings.warn(
            "The SAXTreeBuilder class was deprecated in 4.13.0 and will be removed soon thereafter. It is completely untested and probably doesn't work; do not use it.",
            DeprecationWarning,
            stacklevel=2,
        )
        super(SAXTreeBuilder, self).__init__(*args, **kwargs)

    def feed(self, markup: _RawMarkup) -> None:
        raise NotImplementedError()

    def close(self) -> None:
        pass

    def startElement(self, name: str, attrs: Dict[str, str]) -> None:
        attrs = AttributeDict((key[1], value) for key, value in list(attrs.items()))
        # print("Start %s, %r" % (name, attrs))
        assert self.soup is not None
        self.soup.handle_starttag(name, None, None, attrs)

    def endElement(self, name: str) -> None:
        # print("End %s" % name)
        assert self.soup is not None
        self.soup.handle_endtag(name)

    def startElementNS(
        self, nsTuple: Tuple[str, str], nodeName: str, attrs: Dict[str, str]
    ) -> None:
        # Throw away (ns, nodeName) for now.
        self.startElement(nodeName, attrs)

    def endElementNS(self, nsTuple: Tuple[str, str], nodeName: str) -> None:
        # Throw away (ns, nodeName) for now.
        self.endElement(nodeName)
        # handler.endElementNS((ns, node.nodeName), node.nodeName)

    def startPrefixMapping(self, prefix: str, nodeValue: str) -> None:
        # Ignore the prefix for now.
        pass

    def endPrefixMapping(self, prefix: str) -> None:
        # Ignore the prefix for now.
        # handler.endPrefixMapping(prefix)
        pass

    def characters(self, content: str) -> None:
        assert self.soup is not None
        self.soup.handle_data(content)

    def startDocument(self) -> None:
        pass

    def endDocument(self) -> None:
        pass


class HTMLTreeBuilder(TreeBuilder):
    """This TreeBuilder knows facts about HTML, such as which tags are treated
    specially by the HTML standard.
    """

    #: Some HTML tags are defined as having no contents. Beautiful Soup
    #: treats these specially.
    DEFAULT_EMPTY_ELEMENT_TAGS: Optional[Set[str]] = set(
        [
            # These are from HTML5.
            "area",
            "base",
            "br",
            "col",
            "embed",
            "hr",
            "img",
            "input",
            "keygen",
            "link",
            "menuitem",
            "meta",
            "param",
            "source",
            "track",
            "wbr",
            # These are from earlier versions of HTML and are removed in HTML5.
            "basefont",
            "bgsound",
            "command",
            "frame",
            "image",
            "isindex",
            "nextid",
            "spacer",
        ]
    )

    #: The HTML standard defines these tags as block-level elements. Beautiful
    #: Soup does not treat these elements differently from other elements,
    #: but it may do so eventually, and this information is available if
    #: you need to use it.
    DEFAULT_BLOCK_ELEMENTS: Set[str] = set(
        [
            "address",
            "article",
            "aside",
            "blockquote",
            "canvas",
            "dd",
            "div",
            "dl",
            "dt",
            "fieldset",
            "figcaption",
            "figure",
            "footer",
            "form",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "header",
            "hr",
            "li",
            "main",
            "nav",
            "noscript",
            "ol",
            "output",
            "p",
            "pre",
            "section",
            "table",
            "tfoot",
            "ul",
            "video",
        ]
    )

    #: These HTML tags need special treatment so they can be
    #: represented by a string class other than `bs4.element.NavigableString`.
    #:
    #: For some of these tags, it's because the HTML standard defines
    #: an unusual content model for them. I made this list by going
    #: through the HTML spec
    #: (https://html.spec.whatwg.org/#metadata-content) and looking for
    #: "metadata content" elements that can contain strings.
    #:
    #: The Ruby tags (<rt> and <rp>) are here despite being normal
    #: "phrasing content" tags, because the content they contain is
    #: qualitatively different from other text in the document, and it
    #: can be useful to be able to distinguish it.
    #:
    #: TODO: Arguably <noscript> could go here but it seems
    #: qualitatively different from the other tags.
    DEFAULT_STRING_CONTAINERS: Dict[str, Type[bs4.element.NavigableString]] = { # type:ignore
        "rt": RubyTextString,
        "rp": RubyParenthesisString,
        "style": Stylesheet,
        "script": Script,
        "template": TemplateString,
    }

    #: The HTML standard defines these attributes as containing a
    #: space-separated list of values, not a single value. That is,
    #: class="foo bar" means that the 'class' attribute has two values,
    #: 'foo' and 'bar', not the single value 'foo bar'.  When we
    #: encounter one of these attributes, we will parse its value into
    #: a list of values if possible. Upon output, the list will be
    #: converted back into a string.
    DEFAULT_CDATA_LIST_ATTRIBUTES: Dict[str, Set[str]] = {
        "*": {"class", "accesskey", "dropzone"},
        "a": {"rel", "rev"},
        "link": {"rel", "rev"},
        "td": {"headers"},
        "th": {"headers"},
        "form": {"accept-charset"},
        "object": {"archive"},
        # These are HTML5 specific, as are *.accesskey and *.dropzone above.
        "area": {"rel"},
        "icon": {"sizes"},
        "iframe": {"sandbox"},
        "output": {"for"},
    }

    #: By default, whitespace inside these HTML tags will be
    #: preserved rather than being collapsed.
    DEFAULT_PRESERVE_WHITESPACE_TAGS: set[str] = set(["pre", "textarea"])

    def set_up_substitutions(self, tag: Tag) -> bool:
        """Replace the declared encoding in a <meta> tag with a placeholder,
        to be substituted when the tag is output to a string.

        An HTML document may come in to Beautiful Soup as one
        encoding, but exit in a different encoding, and the <meta> tag
        needs to be changed to reflect this.

        :return: Whether or not a substitution was performed.

        :meta private:
        """
        # We are only interested in <meta> tags
        if tag.name != "meta":
            return False

        # TODO: This cast will fail in the (very unlikely) scenario
        # that the programmer who instantiates the TreeBuilder
        # specifies meta['content'] or meta['charset'] as
        # cdata_list_attributes.
        content: Optional[str] = cast(Optional[str], tag.get("content"))
        charset: Optional[str] = cast(Optional[str], tag.get("charset"))

        # But we can accommodate meta['http-equiv'] being made a
        # cdata_list_attribute (again, very unlikely) without much
        # trouble.
        http_equiv: List[str] = tag.get_attribute_list("http-equiv")

        # We are interested in <meta> tags that say what encoding the
        # document was originally in. This means HTML 5-style <meta>
        # tags that provide the "charset" attribute. It also means
        # HTML 4-style <meta> tags that provide the "content"
        # attribute and have "http-equiv" set to "content-type".
        #
        # In both cases we will replace the value of the appropriate
        # attribute with a standin object that can take on any
        # encoding.
        substituted = False
        if charset is not None:
            # HTML 5 style:
            # <meta charset="utf8">
            tag["charset"] = CharsetMetaAttributeValue(charset)
            substituted = True

        elif content is not None and any(
            x.lower() == "content-type" for x in http_equiv
        ):
            # HTML 4 style:
            # <meta http-equiv="content-type" content="text/html; charset=utf8">
            tag["content"] = ContentMetaAttributeValue(content)
            substituted = True

        return substituted


class DetectsXMLParsedAsHTML(object):
    """A mixin class for any class (a TreeBuilder, or some class used by a
    TreeBuilder) that's in a position to detect whether an XML
    document is being incorrectly parsed as HTML, and issue an
    appropriate warning.

    This requires being able to observe an incoming processing
    instruction that might be an XML declaration, and also able to
    observe tags as they're opened. If you can't do that for a given
    `TreeBuilder`, there's a less reliable implementation based on
    examining the raw markup.
    """

    #: Regular expression for seeing if string markup has an <html> tag.
    LOOKS_LIKE_HTML: Pattern[str] = re.compile("<[^ +]html", re.I)

    #: Regular expression for seeing if byte markup has an <html> tag.
    LOOKS_LIKE_HTML_B: Pattern[bytes] = re.compile(b"<[^ +]html", re.I)

    #: The start of an XML document string.
    XML_PREFIX: str = "<?xml"

    #: The start of an XML document bytestring.
    XML_PREFIX_B: bytes = b"<?xml"

    # This is typed as str, not `ProcessingInstruction`, because this
    # check may be run before any Beautiful Soup objects are created.
    _first_processing_instruction: Optional[str]  #: :meta private:
    _root_tag_name: Optional[str]  #: :meta private:

    @classmethod
    def warn_if_markup_looks_like_xml(
        cls, markup: Optional[_RawMarkup], stacklevel: int = 3
    ) -> bool:
        """Perform a check on some markup to see if it looks like XML
        that's not XHTML. If so, issue a warning.

        This is much less reliable than doing the check while parsing,
        but some of the tree builders can't do that.

        :param stacklevel: The stacklevel of the code calling this\
         function.

        :return: True if the markup looks like non-XHTML XML, False
         otherwise.
        """
        if markup is None:
            return False
        markup = markup[:500]
        if isinstance(markup, bytes):
            markup_b: bytes = markup
            looks_like_xml = markup_b.startswith(
                cls.XML_PREFIX_B
            ) and not cls.LOOKS_LIKE_HTML_B.search(markup)
        else:
            markup_s: str = markup
            looks_like_xml = markup_s.startswith(
                cls.XML_PREFIX
            ) and not cls.LOOKS_LIKE_HTML.search(markup)

        if looks_like_xml:
            cls._warn(stacklevel=stacklevel + 2)
            return True
        return False

    @classmethod
    def _warn(cls, stacklevel: int = 5) -> None:
        """Issue a warning about XML being parsed as HTML."""
        warnings.warn(
            XMLParsedAsHTMLWarning.MESSAGE,
            XMLParsedAsHTMLWarning,
            stacklevel=stacklevel,
        )

    def _initialize_xml_detector(self) -> None:
        """Call this method before parsing a document."""
        self._first_processing_instruction = None
        self._root_tag_name = None

    def _document_might_be_xml(self, processing_instruction: str) -> None:
        """Call this method when encountering an XML declaration, or a
        "processing instruction" that might be an XML declaration.

        This helps Beautiful Soup detect potential issues later, if
        the XML document turns out to be a non-XHTML document that's
        being parsed as XML.
        """
        if (
            self._first_processing_instruction is not None
            or self._root_tag_name is not None
        ):
            # The document has already started. Don't bother checking
            # anymore.
            return

        self._first_processing_instruction = processing_instruction

        # We won't know until we encounter the first tag whether or
        # not this is actually a problem.

    def _root_tag_encountered(self, name: str) -> None:
        """Call this when you encounter the document's root tag.

        This is where we actually check whether an XML document is
        being incorrectly parsed as HTML, and issue the warning.
        """
        if self._root_tag_name is not None:
            # This method was incorrectly called multiple times. Do
            # nothing.
            return

        self._root_tag_name = name

        if (
            name != "html"
            and self._first_processing_instruction is not None
            and self._first_processing_instruction.lower().startswith("xml ")
        ):
            # We encountered an XML declaration and then a tag other
            # than 'html'. This is a reliable indicator that a
            # non-XHTML document is being parsed as XML.
            self._warn(stacklevel=10)


def register_treebuilders_from(module: ModuleType) -> None:
    """Copy TreeBuilders from the given module into this module."""
    this_module = sys.modules[__name__]
    for name in module.__all__:
        obj = getattr(module, name)

        if issubclass(obj, TreeBuilder):
            setattr(this_module, name, obj)
            this_module.__all__.append(name)
            # Register the builder while we're at it.
            this_module.builder_registry.register(obj)


# Builders are registered in reverse order of priority, so that custom
# builder registrations will take precedence. In general, we want lxml
# to take precedence over html5lib, because it's faster. And we only
# want to use HTMLParser as a last resort.
from . import _htmlparser # noqa: E402

register_treebuilders_from(_htmlparser)
try:
    from . import _html5lib

    register_treebuilders_from(_html5lib)
except ImportError:
    # They don't have html5lib installed.
    pass
try:
    from . import _lxml

    register_treebuilders_from(_lxml)
except ImportError:
    # They don't have lxml installed.
    pass

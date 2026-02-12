# encoding: utf-8
from __future__ import annotations

# Use of this source code is governed by the MIT license.
__license__ = "MIT"

__all__ = [
    "LXMLTreeBuilderForXML",
    "LXMLTreeBuilder",
]


from typing import (
    Any,
    Dict,
    Iterable,
    List,
    Optional,
    Set,
    Tuple,
    Type,
    TYPE_CHECKING,
    Union,
)

from io import BytesIO
from io import StringIO

from typing_extensions import TypeAlias

from lxml import etree # type:ignore
from bs4.element import (
    AttributeDict,
    XMLAttributeDict,
    Comment,
    Doctype,
    NamespacedAttribute,
    ProcessingInstruction,
    XMLProcessingInstruction,
)
from bs4.builder import (
    DetectsXMLParsedAsHTML,
    FAST,
    HTML,
    HTMLTreeBuilder,
    PERMISSIVE,
    TreeBuilder,
    XML,
)
from bs4.dammit import EncodingDetector
from bs4.exceptions import ParserRejectedMarkup

if TYPE_CHECKING:
    from bs4._typing import (
        _Encoding,
        _Encodings,
        _NamespacePrefix,
        _NamespaceURL,
        _NamespaceMapping,
        _InvertedNamespaceMapping,
        _RawMarkup,
    )
    from bs4 import BeautifulSoup

LXML: str = "lxml"


def _invert(d: dict[Any, Any]) -> dict[Any, Any]:
    "Invert a dictionary."
    return dict((v, k) for k, v in list(d.items()))


_LXMLParser: TypeAlias = Union[etree.XMLParser, etree.HTMLParser]
_ParserOrParserClass: TypeAlias = Union[
    _LXMLParser, Type[etree.XMLParser], Type[etree.HTMLParser]
]


class LXMLTreeBuilderForXML(TreeBuilder):
    DEFAULT_PARSER_CLASS: Type[etree.XMLParser] = etree.XMLParser

    is_xml: bool = True

    #: Set this to true (probably by passing huge_tree=True into the :
    #: BeautifulSoup constructor) to enable the lxml feature "disable security
    #: restrictions and support very deep trees and very long text
    #: content".
    huge_tree: bool

    processing_instruction_class: Type[ProcessingInstruction]

    NAME: str = "lxml-xml"
    ALTERNATE_NAMES: Iterable[str] = ["xml"]

    # Well, it's permissive by XML parser standards.
    features: Iterable[str] = [NAME, LXML, XML, FAST, PERMISSIVE]

    CHUNK_SIZE: int = 512

    # This namespace mapping is specified in the XML Namespace
    # standard.
    DEFAULT_NSMAPS: _NamespaceMapping = dict(xml="http://www.w3.org/XML/1998/namespace")

    DEFAULT_NSMAPS_INVERTED: _InvertedNamespaceMapping = _invert(DEFAULT_NSMAPS)

    nsmaps: List[Optional[_InvertedNamespaceMapping]]
    empty_element_tags: Optional[Set[str]]
    parser: Any
    _default_parser: Optional[etree.XMLParser]

    # NOTE: If we parsed Element objects and looked at .sourceline,
    # we'd be able to see the line numbers from the original document.
    # But instead we build an XMLParser or HTMLParser object to serve
    # as the target of parse messages, and those messages don't include
    # line numbers.
    # See: https://bugs.launchpad.net/lxml/+bug/1846906

    def initialize_soup(self, soup: BeautifulSoup) -> None:
        """Let the BeautifulSoup object know about the standard namespace
        mapping.

        :param soup: A `BeautifulSoup`.
        """
        # Beyond this point, self.soup is set, so we can assume (and
        # assert) it's not None whenever necessary.
        super(LXMLTreeBuilderForXML, self).initialize_soup(soup)
        self._register_namespaces(self.DEFAULT_NSMAPS)

    def _register_namespaces(self, mapping: Dict[str, str]) -> None:
        """Let the BeautifulSoup object know about namespaces encountered
        while parsing the document.

        This might be useful later on when creating CSS selectors.

        This will track (almost) all namespaces, even ones that were
        only in scope for part of the document. If two namespaces have
        the same prefix, only the first one encountered will be
        tracked. Un-prefixed namespaces are not tracked.

        :param mapping: A dictionary mapping namespace prefixes to URIs.
        """
        assert self.soup is not None
        for key, value in list(mapping.items()):
            # This is 'if key' and not 'if key is not None' because we
            # don't track un-prefixed namespaces. Soupselect will
            # treat an un-prefixed namespace as the default, which
            # causes confusion in some cases.
            if key and key not in self.soup._namespaces:
                # Let the BeautifulSoup object know about a new namespace.
                # If there are multiple namespaces defined with the same
                # prefix, the first one in the document takes precedence.
                self.soup._namespaces[key] = value

    def default_parser(self, encoding: Optional[_Encoding]) -> _ParserOrParserClass:
        """Find the default parser for the given encoding.

        :return: Either a parser object or a class, which
          will be instantiated with default arguments.
        """
        if self._default_parser is not None:
            return self._default_parser
        return self.DEFAULT_PARSER_CLASS(target=self, recover=True, huge_tree=self.huge_tree, encoding=encoding)

    def parser_for(self, encoding: Optional[_Encoding]) -> _LXMLParser:
        """Instantiate an appropriate parser for the given encoding.

        :param encoding: A string.
        :return: A parser object such as an `etree.XMLParser`.
        """
        # Use the default parser.
        parser = self.default_parser(encoding)

        if callable(parser):
            # Instantiate the parser with default arguments
            parser = parser(target=self, recover=True, huge_tree=self.huge_tree, encoding=encoding)
        return parser

    def __init__(
            self,
            parser: Optional[etree.XMLParser] = None,
            empty_element_tags: Optional[Set[str]] = None,
            huge_tree: bool = False,
            **kwargs: Any,
    ):
        # TODO: Issue a warning if parser is present but not a
        # callable, since that means there's no way to create new
        # parsers for different encodings.
        self._default_parser = parser
        self.soup = None
        self.nsmaps = [self.DEFAULT_NSMAPS_INVERTED]
        self.active_namespace_prefixes = [dict(self.DEFAULT_NSMAPS)]
        if self.is_xml:
            self.processing_instruction_class = XMLProcessingInstruction
        else:
            self.processing_instruction_class = ProcessingInstruction

        if "attribute_dict_class" not in kwargs:
            kwargs["attribute_dict_class"] = XMLAttributeDict
        self.huge_tree = huge_tree

        super(LXMLTreeBuilderForXML, self).__init__(**kwargs)

    def _getNsTag(self, tag: str) -> Tuple[Optional[str], str]:
        # Split the namespace URL out of a fully-qualified lxml tag
        # name. Copied from lxml's src/lxml/sax.py.
        if tag[0] == "{" and "}" in tag:
            namespace, name = tag[1:].split("}", 1)
            return (namespace, name)
        return (None, tag)

    def prepare_markup(
        self,
        markup: _RawMarkup,
        user_specified_encoding: Optional[_Encoding] = None,
        document_declared_encoding: Optional[_Encoding] = None,
        exclude_encodings: Optional[_Encodings] = None,
    ) -> Iterable[
        Tuple[Union[str, bytes], Optional[_Encoding], Optional[_Encoding], bool]
    ]:
        """Run any preliminary steps necessary to make incoming markup
        acceptable to the parser.

        lxml really wants to get a bytestring and convert it to
        Unicode itself. So instead of using UnicodeDammit to convert
        the bytestring to Unicode using different encodings, this
        implementation uses EncodingDetector to iterate over the
        encodings, and tell lxml to try to parse the document as each
        one in turn.

        :param markup: Some markup -- hopefully a bytestring.
        :param user_specified_encoding: The user asked to try this encoding.
        :param document_declared_encoding: The markup itself claims to be
            in this encoding.
        :param exclude_encodings: The user asked _not_ to try any of
            these encodings.

        :yield: A series of 4-tuples: (markup, encoding, declared encoding,
            has undergone character replacement)

            Each 4-tuple represents a strategy for converting the
            document to Unicode and parsing it. Each strategy will be tried
            in turn.
        """
        if not self.is_xml:
            # We're in HTML mode, so if we're given XML, that's worth
            # noting.
            DetectsXMLParsedAsHTML.warn_if_markup_looks_like_xml(markup, stacklevel=3)

        if isinstance(markup, str):
            # We were given Unicode. Maybe lxml can parse Unicode on
            # this system?

            # TODO: This is a workaround for
            # https://bugs.launchpad.net/lxml/+bug/1948551.
            # We can remove it once the upstream issue is fixed.
            if len(markup) > 0 and markup[0] == "\N{BYTE ORDER MARK}":
                markup = markup[1:]
            yield markup, None, document_declared_encoding, False

        if isinstance(markup, str):
            # No, apparently not. Convert the Unicode to UTF-8 and
            # tell lxml to parse it as UTF-8.
            yield (markup.encode("utf8"), "utf8", document_declared_encoding, False)

            # Since the document was Unicode in the first place, there
            # is no need to try any more strategies; we know this will
            # work.
            return

        known_definite_encodings: List[_Encoding] = []
        if user_specified_encoding:
            # This was provided by the end-user; treat it as a known
            # definite encoding per the algorithm laid out in the
            # HTML5 spec. (See the EncodingDetector class for
            # details.)
            known_definite_encodings.append(user_specified_encoding)

        user_encodings: List[_Encoding] = []
        if document_declared_encoding:
            # This was found in the document; treat it as a slightly
            # lower-priority user encoding.
            user_encodings.append(document_declared_encoding)

        detector = EncodingDetector(
            markup,
            known_definite_encodings=known_definite_encodings,
            user_encodings=user_encodings,
            is_html=not self.is_xml,
            exclude_encodings=exclude_encodings,
        )
        for encoding in detector.encodings:
            yield (detector.markup, encoding, document_declared_encoding, False)

    def feed(self, markup: _RawMarkup) -> None:
        io: Union[BytesIO, StringIO]
        if isinstance(markup, bytes):
            io = BytesIO(markup)
        elif isinstance(markup, str):
            io = StringIO(markup)

        # initialize_soup is called before feed, so we know this
        # is not None.
        assert self.soup is not None

        # Call feed() at least once, even if the markup is empty,
        # or the parser won't be initialized.
        data = io.read(self.CHUNK_SIZE)
        try:
            self.parser = self.parser_for(self.soup.original_encoding)
            self.parser.feed(data)
            while len(data) != 0:
                # Now call feed() on the rest of the data, chunk by chunk.
                data = io.read(self.CHUNK_SIZE)
                if len(data) != 0:
                    self.parser.feed(data)
            self.parser.close()
        except (UnicodeDecodeError, LookupError, etree.ParserError) as e:
            raise ParserRejectedMarkup(e)

    def close(self) -> None:
        self.nsmaps = [self.DEFAULT_NSMAPS_INVERTED]

    def start(
        self,
        tag: str | bytes,
        attrib: Dict[str | bytes, str | bytes],
        nsmap: _NamespaceMapping = {},
    ) -> None:
        # This is called by lxml code as a result of calling
        # BeautifulSoup.feed(), and we know self.soup is set by the time feed()
        # is called.
        assert self.soup is not None
        assert isinstance(tag, str)

        # We need to recreate the attribute dict for three
        # reasons. First, for type checking, so we can assert there
        # are no bytestrings in the keys or values. Second, because we
        # need a mutable dict--lxml might send us an immutable
        # dictproxy. Third, so we can handle namespaced attribute
        # names by converting the keys to NamespacedAttributes.
        new_attrib: Dict[Union[str, NamespacedAttribute], str] = (
            self.attribute_dict_class()
        )
        for k, v in attrib.items():
            assert isinstance(k, str)
            assert isinstance(v, str)
            new_attrib[k] = v

        nsprefix: Optional[_NamespacePrefix] = None
        namespace: Optional[_NamespaceURL] = None
        # Invert each namespace map as it comes in.
        if len(nsmap) == 0 and len(self.nsmaps) > 1:
            # There are no new namespaces for this tag, but
            # non-default namespaces are in play, so we need a
            # separate tag stack to know when they end.
            self.nsmaps.append(None)
        elif len(nsmap) > 0:
            # A new namespace mapping has come into play.

            # First, Let the BeautifulSoup object know about it.
            self._register_namespaces(nsmap)

            # Then, add it to our running list of inverted namespace
            # mappings.
            self.nsmaps.append(_invert(nsmap))

            # The currently active namespace prefixes have
            # changed. Calculate the new mapping so it can be stored
            # with all Tag objects created while these prefixes are in
            # scope.
            current_mapping = dict(self.active_namespace_prefixes[-1])
            current_mapping.update(nsmap)

            # We should not track un-prefixed namespaces as we can only hold one
            # and it will be recognized as the default namespace by soupsieve,
            # which may be confusing in some situations.
            if "" in current_mapping:
                del current_mapping[""]
            self.active_namespace_prefixes.append(current_mapping)

            # Also treat the namespace mapping as a set of attributes on the
            # tag, so we can recreate it later.
            for prefix, namespace in list(nsmap.items()):
                attribute = NamespacedAttribute(
                    "xmlns", prefix, "http://www.w3.org/2000/xmlns/"
                )
                new_attrib[attribute] = namespace

        # Namespaces are in play. Find any attributes that came in
        # from lxml with namespaces attached to their names, and
        # turn then into NamespacedAttribute objects.
        final_attrib: AttributeDict = self.attribute_dict_class()
        for attr, value in list(new_attrib.items()):
            namespace, attr = self._getNsTag(attr)
            if namespace is None:
                final_attrib[attr] = value
            else:
                nsprefix = self._prefix_for_namespace(namespace)
                attr = NamespacedAttribute(nsprefix, attr, namespace)
                final_attrib[attr] = value

        namespace, tag = self._getNsTag(tag)
        nsprefix = self._prefix_for_namespace(namespace)
        self.soup.handle_starttag(
            tag,
            namespace,
            nsprefix,
            final_attrib,
            namespaces=self.active_namespace_prefixes[-1],
        )

    def _prefix_for_namespace(
        self, namespace: Optional[_NamespaceURL]
    ) -> Optional[_NamespacePrefix]:
        """Find the currently active prefix for the given namespace."""
        if namespace is None:
            return None
        for inverted_nsmap in reversed(self.nsmaps):
            if inverted_nsmap is not None and namespace in inverted_nsmap:
                return inverted_nsmap[namespace]
        return None

    def end(self, tag: str | bytes) -> None:
        assert self.soup is not None
        assert isinstance(tag, str)
        self.soup.endData()
        namespace, tag = self._getNsTag(tag)
        nsprefix = None
        if namespace is not None:
            for inverted_nsmap in reversed(self.nsmaps):
                if inverted_nsmap is not None and namespace in inverted_nsmap:
                    nsprefix = inverted_nsmap[namespace]
                    break
        self.soup.handle_endtag(tag, nsprefix)
        if len(self.nsmaps) > 1:
            # This tag, or one of its parents, introduced a namespace
            # mapping, so pop it off the stack.
            out_of_scope_nsmap = self.nsmaps.pop()

            if out_of_scope_nsmap is not None:
                # This tag introduced a namespace mapping which is no
                # longer in scope. Recalculate the currently active
                # namespace prefixes.
                self.active_namespace_prefixes.pop()

    def pi(self, target: str, data: str) -> None:
        assert self.soup is not None
        self.soup.endData()
        data = target + " " + data
        self.soup.handle_data(data)
        self.soup.endData(self.processing_instruction_class)

    def data(self, data: str | bytes) -> None:
        assert self.soup is not None
        assert isinstance(data, str)
        self.soup.handle_data(data)

    def doctype(self, name: str, pubid: str, system: str) -> None:
        assert self.soup is not None
        self.soup.endData()
        doctype_string = Doctype._string_for_name_and_ids(name, pubid, system)
        self.soup.handle_data(doctype_string)
        self.soup.endData(containerClass=Doctype)

    def comment(self, text: str | bytes) -> None:
        "Handle comments as Comment objects."
        assert self.soup is not None
        assert isinstance(text, str)
        self.soup.endData()
        self.soup.handle_data(text)
        self.soup.endData(Comment)

    def test_fragment_to_document(self, fragment: str) -> str:
        """See `TreeBuilder`."""
        return '<?xml version="1.0" encoding="utf-8"?>\n%s' % fragment


class LXMLTreeBuilder(HTMLTreeBuilder, LXMLTreeBuilderForXML):
    NAME: str = LXML
    ALTERNATE_NAMES: Iterable[str] = ["lxml-html"]

    features: Iterable[str] = list(ALTERNATE_NAMES) + [NAME, HTML, FAST, PERMISSIVE]
    is_xml: bool = False

    def default_parser(self, encoding: Optional[_Encoding]) -> _ParserOrParserClass:
        return etree.HTMLParser

    def feed(self, markup: _RawMarkup) -> None:
        # We know self.soup is set by the time feed() is called.
        assert self.soup is not None
        encoding = self.soup.original_encoding
        try:
            self.parser = self.parser_for(encoding)
            self.parser.feed(markup)
            self.parser.close()
        except (UnicodeDecodeError, LookupError, etree.ParserError) as e:
            raise ParserRejectedMarkup(e)

    def test_fragment_to_document(self, fragment: str) -> str:
        """See `TreeBuilder`."""
        return "<html><body>%s</body></html>" % fragment

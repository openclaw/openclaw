# Use of this source code is governed by the MIT license.
__license__ = "MIT"

__all__ = [
    "HTML5TreeBuilder",
]

from typing import (
    Any,
    cast,
    Dict,
    Iterable,
    Optional,
    Sequence,
    TYPE_CHECKING,
    Tuple,
    Union,
)
from typing_extensions import TypeAlias
from bs4._typing import (
    _AttributeValue,
    _AttributeValues,
    _Encoding,
    _Encodings,
    _NamespaceURL,
    _RawMarkup,
)

import warnings
from bs4.builder import (
    DetectsXMLParsedAsHTML,
    PERMISSIVE,
    HTML,
    HTML_5,
    HTMLTreeBuilder,
)
from bs4.element import (
    NamespacedAttribute,
    PageElement,
    nonwhitespace_re,
)
import html5lib
from html5lib.constants import (
    namespaces,
)
from bs4.element import (
    Comment,
    Doctype,
    NavigableString,
    Tag,
)

if TYPE_CHECKING:
    from bs4 import BeautifulSoup

from html5lib.treebuilders import base as treebuilder_base


class HTML5TreeBuilder(HTMLTreeBuilder):
    """Use `html5lib <https://github.com/html5lib/html5lib-python>`_ to
    build a tree.

    Note that `HTML5TreeBuilder` does not support some common HTML
    `TreeBuilder` features. Some of these features could theoretically
    be implemented, but at the very least it's quite difficult,
    because html5lib moves the parse tree around as it's being built.

    Specifically:

    * This `TreeBuilder` doesn't use different subclasses of
      `NavigableString` (e.g. `Script`) based on the name of the tag
      in which the string was found.
    * You can't use a `SoupStrainer` to parse only part of a document.
    """

    NAME: str = "html5lib"

    features: Iterable[str] = [NAME, PERMISSIVE, HTML_5, HTML]

    #: html5lib can tell us which line number and position in the
    #: original file is the source of an element.
    TRACKS_LINE_NUMBERS: bool = True

    underlying_builder: "TreeBuilderForHtml5lib"  #: :meta private:
    user_specified_encoding: Optional[_Encoding]

    def prepare_markup(
        self,
        markup: _RawMarkup,
        user_specified_encoding: Optional[_Encoding] = None,
        document_declared_encoding: Optional[_Encoding] = None,
        exclude_encodings: Optional[_Encodings] = None,
    ) -> Iterable[Tuple[_RawMarkup, Optional[_Encoding], Optional[_Encoding], bool]]:
        # Store the user-specified encoding for use later on.
        self.user_specified_encoding = user_specified_encoding

        # document_declared_encoding and exclude_encodings aren't used
        # ATM because the html5lib TreeBuilder doesn't use
        # UnicodeDammit.
        for variable, name in (
            (document_declared_encoding, "document_declared_encoding"),
            (exclude_encodings, "exclude_encodings"),
        ):
            if variable:
                warnings.warn(
                    f"You provided a value for {name}, but the html5lib tree builder doesn't support {name}.",
                    stacklevel=3,
                )

        # html5lib only parses HTML, so if it's given XML that's worth
        # noting.
        DetectsXMLParsedAsHTML.warn_if_markup_looks_like_xml(markup, stacklevel=3)

        yield (markup, None, None, False)

    # These methods are defined by Beautiful Soup.
    def feed(self, markup: _RawMarkup) -> None:
        """Run some incoming markup through some parsing process,
        populating the `BeautifulSoup` object in `HTML5TreeBuilder.soup`.
        """
        if self.soup is not None and self.soup.parse_only is not None:
            warnings.warn(
                "You provided a value for parse_only, but the html5lib tree builder doesn't support parse_only. The entire document will be parsed.",
                stacklevel=4,
            )

        # self.underlying_builder is probably None now, but it'll be set
        # when html5lib calls self.create_treebuilder().
        parser = html5lib.HTMLParser(tree=self.create_treebuilder)
        assert self.underlying_builder is not None
        self.underlying_builder.parser = parser
        extra_kwargs = dict()
        if not isinstance(markup, str):
            # kwargs, specifically override_encoding, will eventually
            # be passed in to html5lib's
            # HTMLBinaryInputStream.__init__.
            extra_kwargs["override_encoding"] = self.user_specified_encoding

        doc = parser.parse(markup, **extra_kwargs) # type:ignore

        # Set the character encoding detected by the tokenizer.
        if isinstance(markup, str):
            # We need to special-case this because html5lib sets
            # charEncoding to UTF-8 if it gets Unicode input.
            doc.original_encoding = None
        else:
            original_encoding = parser.tokenizer.stream.charEncoding[0] # type:ignore
            # The encoding is an html5lib Encoding object. We want to
            # use a string for compatibility with other tree builders.
            original_encoding = original_encoding.name
            doc.original_encoding = original_encoding
        self.underlying_builder.parser = None

    def create_treebuilder(
        self, namespaceHTMLElements: bool
    ) -> "TreeBuilderForHtml5lib":
        """Called by html5lib to instantiate the kind of class it
        calls a 'TreeBuilder'.

        :param namespaceHTMLElements: Whether or not to namespace HTML elements.

        :meta private:
        """
        self.underlying_builder = TreeBuilderForHtml5lib(
            namespaceHTMLElements, self.soup, store_line_numbers=self.store_line_numbers
        )
        return self.underlying_builder

    def test_fragment_to_document(self, fragment: str) -> str:
        """See `TreeBuilder`."""
        return "<html><head></head><body>%s</body></html>" % fragment


class TreeBuilderForHtml5lib(treebuilder_base.TreeBuilder):
    soup: "BeautifulSoup"  #: :meta private:
    parser: Optional[html5lib.HTMLParser]  #: :meta private:

    def __init__(
        self,
        namespaceHTMLElements: bool,
        soup: Optional["BeautifulSoup"] = None,
        store_line_numbers: bool = True,
        **kwargs: Any,
    ):
        if soup:
            self.soup = soup
        else:
            warnings.warn(
                "The optionality of the 'soup' argument to the TreeBuilderForHtml5lib constructor is deprecated as of Beautiful Soup 4.13.0: 'soup' is now required. If you can't pass in a BeautifulSoup object here, or you get this warning and it seems mysterious to you, please contact the Beautiful Soup developer team for possible un-deprecation.",
                DeprecationWarning,
                stacklevel=2,
            )
            from bs4 import BeautifulSoup

            # TODO: Why is the parser 'html.parser' here? Using
            # html5lib doesn't cause an infinite loop and is more
            # accurate. Best to get rid of this entire section, I think.
            self.soup = BeautifulSoup(
                "", "html.parser", store_line_numbers=store_line_numbers, **kwargs
            )
        # TODO: What are **kwargs exactly? Should they be passed in
        # here in addition to/instead of being passed to the BeautifulSoup
        # constructor?
        super(TreeBuilderForHtml5lib, self).__init__(namespaceHTMLElements)

        # This will be set later to a real html5lib HTMLParser object,
        # which we can use to track the current line number.
        self.parser = None
        self.store_line_numbers = store_line_numbers

    def documentClass(self) -> "Element":
        self.soup.reset()
        return Element(self.soup, self.soup, None)

    def insertDoctype(self, token: Dict[str, Any]) -> None:
        name: str = cast(str, token["name"])
        publicId: Optional[str] = cast(Optional[str], token["publicId"])
        systemId: Optional[str] = cast(Optional[str], token["systemId"])

        doctype = Doctype.for_name_and_ids(name, publicId, systemId)
        self.soup.object_was_parsed(doctype)

    def elementClass(self, name: str, namespace: str) -> "Element":
        sourceline: Optional[int] = None
        sourcepos: Optional[int] = None
        if self.parser is not None and self.store_line_numbers:
            # This represents the point immediately after the end of the
            # tag. We don't know when the tag started, but we do know
            # where it ended -- the character just before this one.
            sourceline, sourcepos = self.parser.tokenizer.stream.position() # type:ignore
            assert sourcepos is not None
            sourcepos = sourcepos - 1
        tag = self.soup.new_tag(
            name, namespace, sourceline=sourceline, sourcepos=sourcepos
        )

        return Element(tag, self.soup, namespace)

    def commentClass(self, data: str) -> "TextNode":
        return TextNode(Comment(data), self.soup)

    def fragmentClass(self) -> "Element":
        """This is only used by html5lib HTMLParser.parseFragment(),
        which is never used by Beautiful Soup, only by the html5lib
        unit tests. Since we don't currently hook into those tests,
        the implementation is left blank.
        """
        raise NotImplementedError()

    def getFragment(self) -> "Element":
        """This is only used by the html5lib unit tests. Since we
        don't currently hook into those tests, the implementation is
        left blank.
        """
        raise NotImplementedError()

    def appendChild(self, node: "Element") -> None:
        # TODO: This code is not covered by the BS4 tests, and
        # apparently not triggered by the html5lib test suite either.
        # But it doesn't seem test-specific and there are calls to it
        # (or a method with the same name) all over html5lib, so I'm
        # leaving the implementation in place rather than replacing it
        # with NotImplementedError()
        self.soup.append(node.element)

    def getDocument(self) -> "BeautifulSoup":
        return self.soup

    def testSerializer(self, node: "Element") -> None:
        """This is only used by the html5lib unit tests. Since we
        don't currently hook into those tests, the implementation is
        left blank.
        """
        raise NotImplementedError()


class AttrList(object):
    """Represents a Tag's attributes in a way compatible with html5lib."""

    element: Tag
    attrs: _AttributeValues

    def __init__(self, element: Tag):
        self.element = element
        self.attrs = dict(self.element.attrs)

    def __iter__(self) -> Iterable[Tuple[str, _AttributeValue]]:
        return list(self.attrs.items()).__iter__()

    def __setitem__(self, name: str, value: _AttributeValue) -> None:
        # If this attribute is a multi-valued attribute for this element,
        # turn its value into a list.
        list_attr = self.element.cdata_list_attributes or {}
        if name in list_attr.get("*", []) or (
            self.element.name in list_attr
            and name in list_attr.get(self.element.name, [])
        ):
            # A node that is being cloned may have already undergone
            # this procedure. Check for this and skip it.
            if not isinstance(value, list):
                assert isinstance(value, str)
                value = self.element.attribute_value_list_class(
                    nonwhitespace_re.findall(value)
                )
        self.element[name] = value

    def items(self) -> Iterable[Tuple[str, _AttributeValue]]:
        return list(self.attrs.items())

    def keys(self) -> Iterable[str]:
        return list(self.attrs.keys())

    def __len__(self) -> int:
        return len(self.attrs)

    def __getitem__(self, name: str) -> _AttributeValue:
        return self.attrs[name]

    def __contains__(self, name: str) -> bool:
        return name in list(self.attrs.keys())


class BeautifulSoupNode(treebuilder_base.Node):
    # A node can correspond to _either_ a Tag _or_ a NavigableString.
    tag: Optional[Tag]
    string: Optional[NavigableString]
    soup: "BeautifulSoup"
    namespace: Optional[_NamespaceURL]

    @property
    def element(self) -> PageElement:
        assert self.tag is not None or self.string is not None
        if self.tag is not None:
            return self.tag
        else:
            assert self.string is not None
            return self.string

    @property
    def nodeType(self) -> int:
        """Return the html5lib constant corresponding to the type of
        the underlying DOM object.

        NOTE: This property is only accessed by the html5lib test
        suite, not by Beautiful Soup proper.
        """
        raise NotImplementedError()

    # TODO-TYPING: typeshed stubs are incorrect about this;
    # cloneNode returns a new Node, not None.
    def cloneNode(self) -> treebuilder_base.Node: # type:ignore
        raise NotImplementedError()


class Element(BeautifulSoupNode):
    namespace: Optional[_NamespaceURL]

    def __init__(
        self, element: Tag, soup: "BeautifulSoup", namespace: Optional[_NamespaceURL]
    ):
        self.tag = element
        self.string = None
        self.soup = soup
        self.namespace = namespace
        treebuilder_base.Node.__init__(self, element.name)

    def appendChild(self, node: "BeautifulSoupNode") -> None:
        string_child: Optional[NavigableString] = None
        child: PageElement
        if type(node.string) is NavigableString:
            # We check for NavigableString *only* because we want to avoid
            # joining PreformattedStrings, such as Comments, with nearby strings.
            string_child = child = node.string
        else:
            child = node.element
        node.parent = self

        if (
            child is not None
            and child.parent is not None
            and not isinstance(child, str)
        ):
            node.element.extract()

        if (
            string_child is not None
            and self.tag is not None and self.tag.contents
            and type(self.tag.contents[-1]) is NavigableString
        ):
            # We are appending a string onto another string.
            # TODO This has O(n^2) performance, for input like
            # "a</a>a</a>a</a>..."
            old_element = self.tag.contents[-1]
            new_element = self.soup.new_string(old_element + string_child)
            old_element.replace_with(new_element)
            self.soup._most_recent_element = new_element
        else:
            if isinstance(node, str):
                # Create a brand new NavigableString from this string.
                child = self.soup.new_string(node)

            # Tell Beautiful Soup to act as if it parsed this element
            # immediately after the parent's last descendant. (Or
            # immediately after the parent, if it has no children.)
            if self.tag is not None and self.tag.contents:
                most_recent_element = self.tag._last_descendant(False)
            elif self.element.next_element is not None:
                # Something from further ahead in the parse tree is
                # being inserted into this earlier element. This is
                # very annoying because it means an expensive search
                # for the last element in the tree.
                most_recent_element = self.soup._last_descendant()
            else:
                most_recent_element = self.element

            self.soup.object_was_parsed(
                child, parent=self.tag, most_recent_element=most_recent_element
            )

    def getAttributes(self) -> AttrList:
        assert self.tag is not None
        return AttrList(self.tag)

    # An HTML5lib attribute name may either be a single string,
    # or a tuple (namespace, name).
    _Html5libAttributeName: TypeAlias = Union[str, Tuple[str, str]]
    # Now we can define the type this method accepts as a dictionary
    # mapping those attribute names to single string values.
    _Html5libAttributes: TypeAlias = Dict[_Html5libAttributeName, str]

    def setAttributes(self, attributes: Optional[_Html5libAttributes]) -> None:
        assert self.tag is not None
        if attributes is not None and len(attributes) > 0:
            # Replace any namespaced attributes with
            # NamespacedAttribute objects.
            for name, value in list(attributes.items()):
                if isinstance(name, tuple):
                    new_name = NamespacedAttribute(*name)
                    del attributes[name]
                    attributes[new_name] = value

            # We can now cast attributes to the type of Dict
            # used by Beautiful Soup.
            normalized_attributes = cast(_AttributeValues, attributes)

            # Values for tags like 'class' came in as single strings;
            # replace them with lists of strings as appropriate.
            self.soup.builder._replace_cdata_list_attribute_values(
                self.name, normalized_attributes
            )

            # Then set the attributes on the Tag associated with this
            # BeautifulSoupNode.
            for name, value_or_values in list(normalized_attributes.items()):
                self.tag[name] = value_or_values

            # The attributes may contain variables that need substitution.
            # Call set_up_substitutions manually.
            #
            # The Tag constructor called this method when the Tag was created,
            # but we just set/changed the attributes, so call it again.
            self.soup.builder.set_up_substitutions(self.tag)

    attributes = property(getAttributes, setAttributes)

    def insertText(
        self, data: str, insertBefore: Optional["BeautifulSoupNode"] = None
    ) -> None:
        text = TextNode(self.soup.new_string(data), self.soup)
        if insertBefore:
            self.insertBefore(text, insertBefore)
        else:
            self.appendChild(text)

    def insertBefore(
        self, node: "BeautifulSoupNode", refNode: "BeautifulSoupNode"
    ) -> None:
        assert self.tag is not None
        index = self.tag.index(refNode.element)
        if (
            type(node.element) is NavigableString
            and self.tag.contents
            and type(self.tag.contents[index - 1]) is NavigableString
        ):
            # (See comments in appendChild)
            old_node = self.tag.contents[index - 1]
            assert type(old_node) is NavigableString
            new_str = self.soup.new_string(old_node + node.element)
            old_node.replace_with(new_str)
        else:
            self.tag.insert(index, node.element)
            node.parent = self

    def removeChild(self, node: "Element") -> None:
        node.element.extract()

    def reparentChildren(self, newParent: "Element") -> None:
        """Move all of this tag's children into another tag."""
        # print("MOVE", self.element.contents)
        # print("FROM", self.element)
        # print("TO", new_parent.element)

        element = self.tag
        assert element is not None
        new_parent_element = newParent.tag
        assert new_parent_element is not None
        # Determine what this tag's next_element will be once all the children
        # are removed.
        final_next_element = element.next_sibling

        new_parents_last_descendant = new_parent_element._last_descendant(False, False)
        if len(new_parent_element.contents) > 0:
            # The new parent already contains children. We will be
            # appending this tag's children to the end.

            # We can make this assertion since we know new_parent has
            # children.
            assert new_parents_last_descendant is not None
            new_parents_last_child = new_parent_element.contents[-1]
            new_parents_last_descendant_next_element = (
                new_parents_last_descendant.next_element
            )
        else:
            # The new parent contains no children.
            new_parents_last_child = None
            new_parents_last_descendant_next_element = new_parent_element.next_element

        to_append = element.contents
        if len(to_append) > 0:
            # Set the first child's previous_element and previous_sibling
            # to elements within the new parent
            first_child = to_append[0]
            if new_parents_last_descendant is not None:
                first_child.previous_element = new_parents_last_descendant
            else:
                first_child.previous_element = new_parent_element
            first_child.previous_sibling = new_parents_last_child
            if new_parents_last_descendant is not None:
                new_parents_last_descendant.next_element = first_child
            else:
                new_parent_element.next_element = first_child
            if new_parents_last_child is not None:
                new_parents_last_child.next_sibling = first_child

            # Find the very last element being moved. It is now the
            # parent's last descendant. It has no .next_sibling and
            # its .next_element is whatever the previous last
            # descendant had.
            last_childs_last_descendant = to_append[-1]._last_descendant(
                is_initialized=False, accept_self=True
            )

            # Since we passed accept_self=True into _last_descendant,
            # there's no possibility that the result is None.
            assert last_childs_last_descendant is not None
            last_childs_last_descendant.next_element = (
                new_parents_last_descendant_next_element
            )
            if new_parents_last_descendant_next_element is not None:
                # TODO-COVERAGE: This code has no test coverage and
                # I'm not sure how to get html5lib to go through this
                # path, but it's just the other side of the previous
                # line.
                new_parents_last_descendant_next_element.previous_element = (
                    last_childs_last_descendant
                )
            last_childs_last_descendant.next_sibling = None

        for child in to_append:
            child.parent = new_parent_element
            new_parent_element.contents.append(child)

        # Now that this element has no children, change its .next_element.
        element.contents = []
        element.next_element = final_next_element

        # print("DONE WITH MOVE")
        # print("FROM", self.element)
        # print("TO", new_parent_element)

    # TODO-TYPING: typeshed stubs are incorrect about this;
    # hasContent returns a boolean, not None.
    def hasContent(self) -> bool: # type:ignore
        return self.tag is None or len(self.tag.contents) > 0

    # TODO-TYPING: typeshed stubs are incorrect about this;
    # cloneNode returns a new Node, not None.
    def cloneNode(self) -> treebuilder_base.Node: # type:ignore
        assert self.tag is not None
        tag = self.soup.new_tag(self.tag.name, self.namespace)
        node = Element(tag, self.soup, self.namespace)
        for key, value in self.attributes:
            node.attributes[key] = value
        return node

    def getNameTuple(self) -> Tuple[Optional[_NamespaceURL], str]:
        if self.namespace is None:
            return namespaces["html"], self.name
        else:
            return self.namespace, self.name

    nameTuple = property(getNameTuple)


class TextNode(BeautifulSoupNode):

    def __init__(self, element: NavigableString, soup: "BeautifulSoup"):
        treebuilder_base.Node.__init__(self, None)
        self.tag = None
        self.string = element
        self.soup = soup

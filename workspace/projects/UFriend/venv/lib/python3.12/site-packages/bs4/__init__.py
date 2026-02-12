"""Beautiful Soup Elixir and Tonic - "The Screen-Scraper's Friend".

http://www.crummy.com/software/BeautifulSoup/

Beautiful Soup uses a pluggable XML or HTML parser to parse a
(possibly invalid) document into a tree representation. Beautiful Soup
provides methods and Pythonic idioms that make it easy to navigate,
search, and modify the parse tree.

Beautiful Soup works with Python 3.7 and up. It works better if lxml
and/or html5lib is installed, but they are not required.

For more than you ever wanted to know about Beautiful Soup, see the
documentation: http://www.crummy.com/software/BeautifulSoup/bs4/doc/
"""

__author__ = "Leonard Richardson (leonardr@segfault.org)"
__version__ = "4.14.3"
__copyright__ = "Copyright (c) 2004-2025 Leonard Richardson"
# Use of this source code is governed by the MIT license.
__license__ = "MIT"

__all__ = [
    "AttributeResemblesVariableWarning",
    "BeautifulSoup",
    "Comment",
    "Declaration",
    "ProcessingInstruction",
    "ResultSet",
    "CSS",
    "Script",
    "Stylesheet",
    "Tag",
    "TemplateString",
    "ElementFilter",
    "UnicodeDammit",
    "CData",
    "Doctype",

    # Exceptions
    "FeatureNotFound",
    "ParserRejectedMarkup",
    "StopParsing",

    # Warnings
    "AttributeResemblesVariableWarning",
    "GuessedAtParserWarning",
    "MarkupResemblesLocatorWarning",
    "UnusualUsageWarning",
    "XMLParsedAsHTMLWarning",
]

from collections import Counter
import io
import sys
import warnings

# The very first thing we do is give a useful error if someone is
# running this code under Python 2.
if sys.version_info.major < 3:
    raise ImportError(
        "You are trying to use a Python 3-specific version of Beautiful Soup under Python 2. This will not work. The final version of Beautiful Soup to support Python 2 was 4.9.3."
    )

from .builder import (
    builder_registry,
    TreeBuilder,
)
from .builder._htmlparser import HTMLParserTreeBuilder
from .dammit import UnicodeDammit
from .css import CSS
from ._deprecation import (
    _deprecated,
)
from .element import (
    CData,
    Comment,
    DEFAULT_OUTPUT_ENCODING,
    Declaration,
    Doctype,
    NavigableString,
    PageElement,
    ProcessingInstruction,
    PYTHON_SPECIFIC_ENCODINGS,
    ResultSet,
    Script,
    Stylesheet,
    Tag,
    TemplateString,
)
from .formatter import Formatter
from .filter import (
    ElementFilter,
    SoupStrainer,
)
from typing import (
    Any,
    cast,
    Counter as CounterType,
    Dict,
    Iterator,
    List,
    Sequence,
    Sized,
    Optional,
    Type,
    Union,
)

from bs4._typing import (
    _Encoding,
    _Encodings,
    _IncomingMarkup,
    _InsertableElement,
    _RawAttributeValue,
    _RawAttributeValues,
    _RawMarkup,
)

# Import all warnings and exceptions into the main package.
from bs4.exceptions import (
    FeatureNotFound,
    ParserRejectedMarkup,
    StopParsing,
)
from bs4._warnings import (
    AttributeResemblesVariableWarning,
    GuessedAtParserWarning,
    MarkupResemblesLocatorWarning,
    UnusualUsageWarning,
    XMLParsedAsHTMLWarning,
)


class BeautifulSoup(Tag):
    """A data structure representing a parsed HTML or XML document.

    Most of the methods you'll call on a BeautifulSoup object are inherited from
    PageElement or Tag.

    Internally, this class defines the basic interface called by the
    tree builders when converting an HTML/XML document into a data
    structure. The interface abstracts away the differences between
    parsers. To write a new tree builder, you'll need to understand
    these methods as a whole.

    These methods will be called by the BeautifulSoup constructor:
      * reset()
      * feed(markup)

    The tree builder may call these methods from its feed() implementation:
      * handle_starttag(name, attrs) # See note about return value
      * handle_endtag(name)
      * handle_data(data) # Appends to the current data node
      * endData(containerClass) # Ends the current data node

    No matter how complicated the underlying parser is, you should be
    able to build a tree using 'start tag' events, 'end tag' events,
    'data' events, and "done with data" events.

    If you encounter an empty-element tag (aka a self-closing tag,
    like HTML's <br> tag), call handle_starttag and then
    handle_endtag.
    """

    #: Since `BeautifulSoup` subclasses `Tag`, it's possible to treat it as
    #: a `Tag` with a `Tag.name`. Hoever, this name makes it clear the
    #: `BeautifulSoup` object isn't a real markup tag.
    ROOT_TAG_NAME: str = "[document]"

    #: If the end-user gives no indication which tree builder they
    #: want, look for one with these features.
    DEFAULT_BUILDER_FEATURES: Sequence[str] = ["html", "fast"]

    #: A string containing all ASCII whitespace characters, used in
    #: during parsing to detect data chunks that seem 'empty'.
    ASCII_SPACES: str = "\x20\x0a\x09\x0c\x0d"

    # FUTURE PYTHON:
    element_classes: Dict[Type[PageElement], Type[PageElement]]  #: :meta private:
    builder: TreeBuilder  #: :meta private:
    is_xml: bool
    known_xml: Optional[bool]
    parse_only: Optional[SoupStrainer]  #: :meta private:

    # These members are only used while parsing markup.
    markup: Optional[_RawMarkup]  #: :meta private:
    current_data: List[str]  #: :meta private:
    currentTag: Optional[Tag]  #: :meta private:
    tagStack: List[Tag]  #: :meta private:
    open_tag_counter: CounterType[str]  #: :meta private:
    preserve_whitespace_tag_stack: List[Tag]  #: :meta private:
    string_container_stack: List[Tag]  #: :meta private:
    _most_recent_element: Optional[PageElement]  #: :meta private:

    #: Beautiful Soup's best guess as to the character encoding of the
    #: original document.
    original_encoding: Optional[_Encoding]

    #: The character encoding, if any, that was explicitly defined
    #: in the original document. This may or may not match
    #: `BeautifulSoup.original_encoding`.
    declared_html_encoding: Optional[_Encoding]

    #: This is True if the markup that was parsed contains
    #: U+FFFD REPLACEMENT_CHARACTER characters which were not present
    #: in the original markup. These mark character sequences that
    #: could not be represented in Unicode.
    contains_replacement_characters: bool

    def __init__(
        self,
        markup: _IncomingMarkup = "",
        features: Optional[Union[str, Sequence[str]]] = None,
        builder: Optional[Union[TreeBuilder, Type[TreeBuilder]]] = None,
        parse_only: Optional[SoupStrainer] = None,
        from_encoding: Optional[_Encoding] = None,
        exclude_encodings: Optional[_Encodings] = None,
        element_classes: Optional[Dict[Type[PageElement], Type[PageElement]]] = None,
        **kwargs: Any,
    ):
        """Constructor.

        :param markup: A string or a file-like object representing
         markup to be parsed.

        :param features: Desirable features of the parser to be
         used. This may be the name of a specific parser ("lxml",
         "lxml-xml", "html.parser", or "html5lib") or it may be the
         type of markup to be used ("html", "html5", "xml"). It's
         recommended that you name a specific parser, so that
         Beautiful Soup gives you the same results across platforms
         and virtual environments.

        :param builder: A TreeBuilder subclass to instantiate (or
         instance to use) instead of looking one up based on
         `features`. You only need to use this if you've implemented a
         custom TreeBuilder.

        :param parse_only: A SoupStrainer. Only parts of the document
         matching the SoupStrainer will be considered. This is useful
         when parsing part of a document that would otherwise be too
         large to fit into memory.

        :param from_encoding: A string indicating the encoding of the
         document to be parsed. Pass this in if Beautiful Soup is
         guessing wrongly about the document's encoding.

        :param exclude_encodings: A list of strings indicating
         encodings known to be wrong. Pass this in if you don't know
         the document's encoding but you know Beautiful Soup's guess is
         wrong.

        :param element_classes: A dictionary mapping BeautifulSoup
         classes like Tag and NavigableString, to other classes you'd
         like to be instantiated instead as the parse tree is
         built. This is useful for subclassing Tag or NavigableString
         to modify default behavior.

        :param kwargs: For backwards compatibility purposes, the
         constructor accepts certain keyword arguments used in
         Beautiful Soup 3. None of these arguments do anything in
         Beautiful Soup 4; they will result in a warning and then be
         ignored.

         Apart from this, any keyword arguments passed into the
         BeautifulSoup constructor are propagated to the TreeBuilder
         constructor. This makes it possible to configure a
         TreeBuilder by passing in arguments, not just by saying which
         one to use.
        """
        if "convertEntities" in kwargs:
            del kwargs["convertEntities"]
            warnings.warn(
                "BS4 does not respect the convertEntities argument to the "
                "BeautifulSoup constructor. Entities are always converted "
                "to Unicode characters."
            )

        if "markupMassage" in kwargs:
            del kwargs["markupMassage"]
            warnings.warn(
                "BS4 does not respect the markupMassage argument to the "
                "BeautifulSoup constructor. The tree builder is responsible "
                "for any necessary markup massage."
            )

        if "smartQuotesTo" in kwargs:
            del kwargs["smartQuotesTo"]
            warnings.warn(
                "BS4 does not respect the smartQuotesTo argument to the "
                "BeautifulSoup constructor. Smart quotes are always converted "
                "to Unicode characters."
            )

        if "selfClosingTags" in kwargs:
            del kwargs["selfClosingTags"]
            warnings.warn(
                "Beautiful Soup 4 does not respect the selfClosingTags argument to the "
                "BeautifulSoup constructor. The tree builder is responsible "
                "for understanding self-closing tags."
            )

        if "isHTML" in kwargs:
            del kwargs["isHTML"]
            warnings.warn(
                "Beautiful Soup 4 does not respect the isHTML argument to the "
                "BeautifulSoup constructor. Suggest you use "
                "features='lxml' for HTML and features='lxml-xml' for "
                "XML."
            )

        def deprecated_argument(old_name: str, new_name: str) -> Optional[Any]:
            if old_name in kwargs:
                warnings.warn(
                    'The "%s" argument to the BeautifulSoup constructor '
                    'was renamed to "%s" in Beautiful Soup 4.0.0'
                    % (old_name, new_name),
                    DeprecationWarning,
                    stacklevel=3,
                )
                return kwargs.pop(old_name)
            return None

        parse_only = parse_only or deprecated_argument("parseOnlyThese", "parse_only")
        if parse_only is not None:
            # Issue a warning if we can tell in advance that
            # parse_only will exclude the entire tree.
            if parse_only.excludes_everything:
                warnings.warn(
                    f"The given value for parse_only will exclude everything: {parse_only}",
                    UserWarning,
                    stacklevel=3,
                )

        from_encoding = from_encoding or deprecated_argument(
            "fromEncoding", "from_encoding"
        )

        if from_encoding and isinstance(markup, str):
            warnings.warn(
                "You provided Unicode markup but also provided a value for from_encoding. Your from_encoding will be ignored."
            )
            from_encoding = None

        self.element_classes = element_classes or dict()

        # We need this information to track whether or not the builder
        # was specified well enough that we can omit the 'you need to
        # specify a parser' warning.
        original_builder = builder
        original_features = features

        builder_class: Optional[Type[TreeBuilder]] = None
        if isinstance(builder, type):
            # A builder class was passed in; it needs to be instantiated.
            builder_class = builder
            builder = None
        elif builder is None:
            if isinstance(features, str):
                features = [features]
            if features is None or len(features) == 0:
                features = self.DEFAULT_BUILDER_FEATURES
            possible_builder_class = builder_registry.lookup(*features)
            if possible_builder_class is None:
                raise FeatureNotFound(
                    "Couldn't find a tree builder with the features you "
                    "requested: %s. Do you need to install a parser library?"
                    % ",".join(features)
                )
            builder_class = possible_builder_class

        # At this point either we have a TreeBuilder instance in
        # builder, or we have a builder_class that we can instantiate
        # with the remaining **kwargs.
        if builder is None:
            assert builder_class is not None
            builder = builder_class(**kwargs)
            if (
                not original_builder
                and not (
                    original_features == builder.NAME
                    or (
                        isinstance(original_features, str)
                        and original_features in builder.ALTERNATE_NAMES
                    )
                )
                and markup
            ):
                # The user did not tell us which TreeBuilder to use,
                # and we had to guess. Issue a warning.
                if builder.is_xml:
                    markup_type = "XML"
                else:
                    markup_type = "HTML"

                # This code adapted from warnings.py so that we get the same line
                # of code as our warnings.warn() call gets, even if the answer is wrong
                # (as it may be in a multithreading situation).
                caller = None
                try:
                    caller = sys._getframe(1)
                except ValueError:
                    pass
                if caller:
                    globals = caller.f_globals
                    line_number = caller.f_lineno
                else:
                    globals = sys.__dict__
                    line_number = 1
                filename = globals.get("__file__")
                if filename:
                    fnl = filename.lower()
                    if fnl.endswith((".pyc", ".pyo")):
                        filename = filename[:-1]
                if filename:
                    # If there is no filename at all, the user is most likely in a REPL,
                    # and the warning is not necessary.
                    values = dict(
                        filename=filename,
                        line_number=line_number,
                        parser=builder.NAME,
                        markup_type=markup_type,
                    )
                    warnings.warn(
                        GuessedAtParserWarning.MESSAGE % values,
                        GuessedAtParserWarning,
                        stacklevel=2,
                    )
        else:
            if kwargs:
                warnings.warn(
                    "Keyword arguments to the BeautifulSoup constructor will be ignored. These would normally be passed into the TreeBuilder constructor, but a TreeBuilder instance was passed in as `builder`."
                )

        self.builder = builder
        self.is_xml = builder.is_xml
        self.known_xml = self.is_xml
        self._namespaces = dict()
        self.parse_only = parse_only

        if hasattr(markup, "read"):  # It's a file-type object.
            markup = cast(io.IOBase, markup).read()
        elif not isinstance(markup, (bytes, str)) and not hasattr(markup, "__len__"):
            raise TypeError(
                f"Incoming markup is of an invalid type: {markup!r}. Markup must be a string, a bytestring, or an open filehandle."
            )
        elif isinstance(markup, Sized) and len(markup) <= 256 and (
            (isinstance(markup, bytes) and b"<" not in markup and b"\n" not in markup)
            or (isinstance(markup, str) and "<" not in markup and "\n" not in markup)
        ):
            # Issue warnings for a couple beginner problems
            # involving passing non-markup to Beautiful Soup.
            # Beautiful Soup will still parse the input as markup,
            # since that is sometimes the intended behavior.
            if not self._markup_is_url(markup):
                self._markup_resembles_filename(markup)

        # At this point we know markup is a string or bytestring.  If
        # it was a file-type object, we've read from it.
        markup = cast(_RawMarkup, markup)

        rejections = []
        success = False
        for (
            self.markup,
            self.original_encoding,
            self.declared_html_encoding,
            self.contains_replacement_characters,
        ) in self.builder.prepare_markup(
            markup, from_encoding, exclude_encodings=exclude_encodings
        ):
            self.reset()
            self.builder.initialize_soup(self)
            try:
                self._feed()
                success = True
                break
            except ParserRejectedMarkup as e:
                rejections.append(e)
                pass

        if not success:
            other_exceptions = [str(e) for e in rejections]
            raise ParserRejectedMarkup(
                "The markup you provided was rejected by the parser. Trying a different parser or a different encoding may help.\n\nOriginal exception(s) from parser:\n "
                + "\n ".join(other_exceptions)
            )

        # Clear out the markup and remove the builder's circular
        # reference to this object.
        self.markup = None
        self.builder.soup = None

    def copy_self(self) -> "BeautifulSoup":
        """Create a new BeautifulSoup object with the same TreeBuilder,
        but not associated with any markup.

        This is the first step of the deepcopy process.
        """
        clone = type(self)("", None, self.builder)

        # Keep track of the encoding of the original document,
        # since we won't be parsing it again.
        clone.original_encoding = self.original_encoding
        return clone

    def __getstate__(self) -> Dict[str, Any]:
        # Frequently a tree builder can't be pickled.
        d = dict(self.__dict__)
        if "builder" in d and d["builder"] is not None and not self.builder.picklable:
            d["builder"] = type(self.builder)
        # Store the contents as a Unicode string.
        d["contents"] = []
        d["markup"] = self.decode()

        # If _most_recent_element is present, it's a Tag object left
        # over from initial parse. It might not be picklable and we
        # don't need it.
        if "_most_recent_element" in d:
            del d["_most_recent_element"]
        return d

    def __setstate__(self, state: Dict[str, Any]) -> None:
        # If necessary, restore the TreeBuilder by looking it up.
        self.__dict__ = state
        if isinstance(self.builder, type):
            self.builder = self.builder()
        elif not self.builder:
            # We don't know which builder was used to build this
            # parse tree, so use a default we know is always available.
            self.builder = HTMLParserTreeBuilder()
        self.builder.soup = self
        self.reset()
        self._feed()

    @classmethod
    @_deprecated(
        replaced_by="nothing (private method, will be removed)", version="4.13.0"
    )
    def _decode_markup(cls, markup: _RawMarkup) -> str:
        """Ensure `markup` is Unicode so it's safe to send into warnings.warn.

        warnings.warn had this problem back in 2010 but fortunately
        not anymore. This has not been used for a long time; I just
        noticed that fact while working on 4.13.0.
        """
        if isinstance(markup, bytes):
            decoded = markup.decode("utf-8", "replace")
        else:
            decoded = markup
        return decoded

    @classmethod
    def _markup_is_url(cls, markup: _RawMarkup) -> bool:
        """Error-handling method to raise a warning if incoming markup looks
        like a URL.

        :param markup: A string of markup.
        :return: Whether or not the markup resembled a URL
            closely enough to justify issuing a warning.
        """
        problem: bool = False
        if isinstance(markup, bytes):
            problem = (
                any(markup.startswith(prefix) for prefix in (b"http:", b"https:"))
                and b" " not in markup
            )
        elif isinstance(markup, str):
            problem = (
                any(markup.startswith(prefix) for prefix in ("http:", "https:"))
                and " " not in markup
            )
        else:
            return False

        if not problem:
            return False
        warnings.warn(
            MarkupResemblesLocatorWarning.URL_MESSAGE % dict(what="URL"),
            MarkupResemblesLocatorWarning,
            stacklevel=3,
        )
        return True

    @classmethod
    def _markup_resembles_filename(cls, markup: _RawMarkup) -> bool:
        """Error-handling method to issue a warning if incoming markup
        resembles a filename.

        :param markup: A string of markup.
        :return: Whether or not the markup resembled a filename
            closely enough to justify issuing a warning.
        """
        markup_b: bytes

        # We're only checking ASCII characters, so rather than write
        # the same tests twice, convert Unicode to a bytestring and
        # operate on the bytestring.
        if isinstance(markup, str):
            markup_b = markup.encode("utf8")
        else:
            markup_b = markup

        # Step 1: does it end with a common textual file extension?
        filelike = False
        lower = markup_b.lower()
        extensions = [b".html", b".htm", b".xml", b".xhtml", b".txt"]
        if any(lower.endswith(ext) for ext in extensions):
            filelike = True
        if not filelike:
            return False

        # Step 2: it _might_ be a file, but there are a few things
        # we can look for that aren't very common in filenames.

        # Characters that have special meaning to Unix shells. (< was
        # excluded before this method was called.)
        #
        # Many of these are also reserved characters that cannot
        # appear in Windows filenames.
        for byte in markup_b:
            if byte in b"?*#&;>$|":
                return False

        # Two consecutive forward slashes (as seen in a URL) or two
        # consecutive spaces (as seen in fixed-width data).
        #
        # (Paths to Windows network shares contain consecutive
        #  backslashes, so checking that doesn't seem as helpful.)
        if b"//" in markup_b:
            return False
        if b"  " in markup_b:
            return False

        # A colon in any position other than position 1 (e.g. after a
        # Windows drive letter).
        if markup_b.startswith(b":"):
            return False
        colon_i = markup_b.rfind(b":")
        if colon_i not in (-1, 1):
            return False

        # Step 3: If it survived all of those checks, it's similar
        # enough to a file to justify issuing a warning.
        warnings.warn(
            MarkupResemblesLocatorWarning.FILENAME_MESSAGE % dict(what="filename"),
            MarkupResemblesLocatorWarning,
            stacklevel=3,
        )
        return True

    def _feed(self) -> None:
        """Internal method that parses previously set markup, creating a large
        number of Tag and NavigableString objects.
        """
        # Convert the document to Unicode.
        self.builder.reset()

        if self.markup is not None:
            self.builder.feed(self.markup)
        # Close out any unfinished strings and close all the open tags.
        self.endData()
        while (
            self.currentTag is not None and self.currentTag.name != self.ROOT_TAG_NAME
        ):
            self.popTag()

    def reset(self) -> None:
        """Reset this object to a state as though it had never parsed any
        markup.
        """
        Tag.__init__(self, self, self.builder, self.ROOT_TAG_NAME)
        self.hidden = True
        self.builder.reset()
        self.current_data = []
        self.currentTag = None
        self.tagStack = []
        self.open_tag_counter = Counter()
        self.preserve_whitespace_tag_stack = []
        self.string_container_stack = []
        self._most_recent_element = None
        self.pushTag(self)

    def new_tag(
        self,
        name: str,
        namespace: Optional[str] = None,
        nsprefix: Optional[str] = None,
        attrs: Optional[_RawAttributeValues] = None,
        sourceline: Optional[int] = None,
        sourcepos: Optional[int] = None,
        string: Optional[str] = None,
        **kwattrs: _RawAttributeValue,
    ) -> Tag:
        """Create a new Tag associated with this BeautifulSoup object.

        :param name: The name of the new Tag.
        :param namespace: The URI of the new Tag's XML namespace, if any.
        :param prefix: The prefix for the new Tag's XML namespace, if any.
        :param attrs: A dictionary of this Tag's attribute values; can
            be used instead of ``kwattrs`` for attributes like 'class'
            that are reserved words in Python.
        :param sourceline: The line number where this tag was
            (purportedly) found in its source document.
        :param sourcepos: The character position within ``sourceline`` where this
            tag was (purportedly) found.
        :param string: String content for the new Tag, if any.
        :param kwattrs: Keyword arguments for the new Tag's attribute values.

        """
        attr_container = self.builder.attribute_dict_class(**kwattrs)
        if attrs is not None:
            attr_container.update(attrs)
        tag_class = self.element_classes.get(Tag, Tag)

        # Assume that this is either Tag or a subclass of Tag. If not,
        # the user brought type-unsafety upon themselves.
        tag_class = cast(Type[Tag], tag_class)
        tag = tag_class(
            None,
            self.builder,
            name,
            namespace,
            nsprefix,
            attr_container,
            sourceline=sourceline,
            sourcepos=sourcepos,
        )

        if string is not None:
            tag.string = string
        return tag

    def string_container(
        self, base_class: Optional[Type[NavigableString]] = None
    ) -> Type[NavigableString]:
        """Find the class that should be instantiated to hold a given kind of
        string.

        This may be a built-in Beautiful Soup class or a custom class passed
        in to the BeautifulSoup constructor.
        """
        container = base_class or NavigableString

        # The user may want us to use some other class (hopefully a
        # custom subclass) instead of the one we'd use normally.
        container = cast(
            Type[NavigableString], self.element_classes.get(container, container)
        )

        # On top of that, we may be inside a tag that needs a special
        # container class.
        if self.string_container_stack and container is NavigableString:
            container = self.builder.string_containers.get(
                self.string_container_stack[-1].name, container
            )
        return container

    def new_string(
        self, s: str, subclass: Optional[Type[NavigableString]] = None
    ) -> NavigableString:
        """Create a new `NavigableString` associated with this `BeautifulSoup`
        object.

        :param s: The string content of the `NavigableString`
        :param subclass: The subclass of `NavigableString`, if any, to
               use. If a document is being processed, an appropriate
               subclass for the current location in the document will
               be determined automatically.
        """
        container = self.string_container(subclass)
        return container(s)

    def insert_before(self, *args: _InsertableElement) -> List[PageElement]:
        """This method is part of the PageElement API, but `BeautifulSoup` doesn't implement
        it because there is nothing before or after it in the parse tree.
        """
        raise NotImplementedError(
            "BeautifulSoup objects don't support insert_before()."
        )

    def insert_after(self, *args: _InsertableElement) -> List[PageElement]:
        """This method is part of the PageElement API, but `BeautifulSoup` doesn't implement
        it because there is nothing before or after it in the parse tree.
        """
        raise NotImplementedError("BeautifulSoup objects don't support insert_after().")

    def popTag(self) -> Optional[Tag]:
        """Internal method called by _popToTag when a tag is closed.

        :meta private:
        """
        if not self.tagStack:
            # Nothing to pop. This shouldn't happen.
            return None
        tag = self.tagStack.pop()
        if tag.name in self.open_tag_counter:
            self.open_tag_counter[tag.name] -= 1
        if (
            self.preserve_whitespace_tag_stack
            and tag == self.preserve_whitespace_tag_stack[-1]
        ):
            self.preserve_whitespace_tag_stack.pop()
        if self.string_container_stack and tag == self.string_container_stack[-1]:
            self.string_container_stack.pop()
        # print("Pop", tag.name)
        if self.tagStack:
            self.currentTag = self.tagStack[-1]
        return self.currentTag

    def pushTag(self, tag: Tag) -> None:
        """Internal method called by handle_starttag when a tag is opened.

        :meta private:
        """
        # print("Push", tag.name)
        if self.currentTag is not None:
            self.currentTag.contents.append(tag)
        self.tagStack.append(tag)
        self.currentTag = self.tagStack[-1]
        if tag.name != self.ROOT_TAG_NAME:
            self.open_tag_counter[tag.name] += 1
        if tag.name in self.builder.preserve_whitespace_tags:
            self.preserve_whitespace_tag_stack.append(tag)
        if tag.name in self.builder.string_containers:
            self.string_container_stack.append(tag)

    def endData(self, containerClass: Optional[Type[NavigableString]] = None) -> None:
        """Method called by the TreeBuilder when the end of a data segment
        occurs.

        :param containerClass: The class to use when incorporating the
        data segment into the parse tree.

        :meta private:
        """
        if self.current_data:
            current_data = "".join(self.current_data)
            # If whitespace is not preserved, and this string contains
            # nothing but ASCII spaces, replace it with a single space
            # or newline.
            if not self.preserve_whitespace_tag_stack:
                strippable = True
                for i in current_data:
                    if i not in self.ASCII_SPACES:
                        strippable = False
                        break
                if strippable:
                    if "\n" in current_data:
                        current_data = "\n"
                    else:
                        current_data = " "

            # Reset the data collector.
            self.current_data = []

            # Should we add this string to the tree at all?
            if (
                self.parse_only
                and len(self.tagStack) <= 1
                and (not self.parse_only.allow_string_creation(current_data))
            ):
                return

            containerClass = self.string_container(containerClass)
            o = containerClass(current_data)
            self.object_was_parsed(o)

    def object_was_parsed(
        self,
        o: PageElement,
        parent: Optional[Tag] = None,
        most_recent_element: Optional[PageElement] = None,
    ) -> None:
        """Method called by the TreeBuilder to integrate an object into the
        parse tree.

        :meta private:
        """
        if parent is None:
            parent = self.currentTag
        assert parent is not None
        previous_element: Optional[PageElement]
        if most_recent_element is not None:
            previous_element = most_recent_element
        else:
            previous_element = self._most_recent_element

        next_element = previous_sibling = next_sibling = None
        if isinstance(o, Tag):
            next_element = o.next_element
            next_sibling = o.next_sibling
            previous_sibling = o.previous_sibling
            if previous_element is None:
                previous_element = o.previous_element

        fix = parent.next_element is not None

        o.setup(parent, previous_element, next_element, previous_sibling, next_sibling)

        self._most_recent_element = o
        parent.contents.append(o)

        # Check if we are inserting into an already parsed node.
        if fix:
            self._linkage_fixer(parent)

    def _linkage_fixer(self, el: Tag) -> None:
        """Make sure linkage of this fragment is sound."""

        first = el.contents[0]
        child = el.contents[-1]
        descendant: PageElement = child

        if child is first and el.parent is not None:
            # Parent should be linked to first child
            el.next_element = child
            # We are no longer linked to whatever this element is
            prev_el = child.previous_element
            if prev_el is not None and prev_el is not el:
                prev_el.next_element = None
            # First child should be linked to the parent, and no previous siblings.
            child.previous_element = el
            child.previous_sibling = None

        # We have no sibling as we've been appended as the last.
        child.next_sibling = None

        # This index is a tag, dig deeper for a "last descendant"
        if isinstance(child, Tag) and child.contents:
            # _last_decendant is typed as returning Optional[PageElement],
            # but the value can't be None here, because el is a Tag
            # which we know has contents.
            descendant = cast(PageElement, child._last_descendant(False))

        # As the final step, link last descendant. It should be linked
        # to the parent's next sibling (if found), else walk up the chain
        # and find a parent with a sibling. It should have no next sibling.
        descendant.next_element = None
        descendant.next_sibling = None

        target: Optional[Tag] = el
        while True:
            if target is None:
                break
            elif target.next_sibling is not None:
                descendant.next_element = target.next_sibling
                target.next_sibling.previous_element = child
                break
            target = target.parent

    def _popToTag(
        self, name: str, nsprefix: Optional[str] = None, inclusivePop: bool = True
    ) -> Optional[Tag]:
        """Pops the tag stack up to and including the most recent
        instance of the given tag.

        If there are no open tags with the given name, nothing will be
        popped.

        :param name: Pop up to the most recent tag with this name.
        :param nsprefix: The namespace prefix that goes with `name`.
        :param inclusivePop: It this is false, pops the tag stack up
          to but *not* including the most recent instqance of the
          given tag.

        :meta private:
        """
        # print("Popping to %s" % name)
        if name == self.ROOT_TAG_NAME:
            # The BeautifulSoup object itself can never be popped.
            return None

        most_recently_popped = None

        stack_size = len(self.tagStack)
        for i in range(stack_size - 1, 0, -1):
            if not self.open_tag_counter.get(name):
                break
            t = self.tagStack[i]
            if name == t.name and nsprefix == t.prefix:
                if inclusivePop:
                    most_recently_popped = self.popTag()
                break
            most_recently_popped = self.popTag()

        return most_recently_popped

    def handle_starttag(
        self,
        name: str,
        namespace: Optional[str],
        nsprefix: Optional[str],
        attrs: _RawAttributeValues,
        sourceline: Optional[int] = None,
        sourcepos: Optional[int] = None,
        namespaces: Optional[Dict[str, str]] = None,
    ) -> Optional[Tag]:
        """Called by the tree builder when a new tag is encountered.

        :param name: Name of the tag.
        :param nsprefix: Namespace prefix for the tag.
        :param attrs: A dictionary of attribute values. Note that
           attribute values are expected to be simple strings; processing
           of multi-valued attributes such as "class" comes later.
        :param sourceline: The line number where this tag was found in its
            source document.
        :param sourcepos: The character position within `sourceline` where this
            tag was found.
        :param namespaces: A dictionary of all namespace prefix mappings
            currently in scope in the document.

        If this method returns None, the tag was rejected by an active
        `ElementFilter`. You should proceed as if the tag had not occurred
        in the document. For instance, if this was a self-closing tag,
        don't call handle_endtag.

        :meta private:
        """
        # print("Start tag %s: %s" % (name, attrs))
        self.endData()

        if (
            self.parse_only
            and len(self.tagStack) <= 1
            and not self.parse_only.allow_tag_creation(nsprefix, name, attrs)
        ):
            return None

        tag_class = self.element_classes.get(Tag, Tag)
        # Assume that this is either Tag or a subclass of Tag. If not,
        # the user brought type-unsafety upon themselves.
        tag_class = cast(Type[Tag], tag_class)
        tag = tag_class(
            self,
            self.builder,
            name,
            namespace,
            nsprefix,
            attrs,
            self.currentTag,
            self._most_recent_element,
            sourceline=sourceline,
            sourcepos=sourcepos,
            namespaces=namespaces,
        )
        if tag is None:
            return tag
        if self._most_recent_element is not None:
            self._most_recent_element.next_element = tag
        self._most_recent_element = tag
        self.pushTag(tag)
        return tag

    def handle_endtag(self, name: str, nsprefix: Optional[str] = None) -> None:
        """Called by the tree builder when an ending tag is encountered.

        :param name: Name of the tag.
        :param nsprefix: Namespace prefix for the tag.

        :meta private:
        """
        # print("End tag: " + name)
        self.endData()
        self._popToTag(name, nsprefix)

    def handle_data(self, data: str) -> None:
        """Called by the tree builder when a chunk of textual data is
        encountered.

        :meta private:
        """
        self.current_data.append(data)

    def decode(
        self,
        indent_level: Optional[int] = None,
        eventual_encoding: _Encoding = DEFAULT_OUTPUT_ENCODING,
        formatter: Union[Formatter, str] = "minimal",
        iterator: Optional[Iterator[PageElement]] = None,
        **kwargs: Any,
    ) -> str:
        """Returns a string representation of the parse tree
            as a full HTML or XML document.

        :param indent_level: Each line of the rendering will be
           indented this many levels. (The ``formatter`` decides what a
           'level' means, in terms of spaces or other characters
           output.) This is used internally in recursive calls while
           pretty-printing.
        :param eventual_encoding: The encoding of the final document.
            If this is None, the document will be a Unicode string.
        :param formatter: Either a `Formatter` object, or a string naming one of
            the standard formatters.
        :param iterator: The iterator to use when navigating over the
            parse tree. This is only used by `Tag.decode_contents` and
            you probably won't need to use it.
        """
        if self.is_xml:
            # Print the XML declaration
            encoding_part = ""
            declared_encoding: Optional[str] = eventual_encoding
            if eventual_encoding in PYTHON_SPECIFIC_ENCODINGS:
                # This is a special Python encoding; it can't actually
                # go into an XML document because it means nothing
                # outside of Python.
                declared_encoding = None
            if declared_encoding is not None:
                encoding_part = ' encoding="%s"' % declared_encoding
            prefix = '<?xml version="1.0"%s?>\n' % encoding_part
        else:
            prefix = ""

        # Prior to 4.13.0, the first argument to this method was a
        # bool called pretty_print, which gave the method a different
        # signature from its superclass implementation, Tag.decode.
        #
        # The signatures of the two methods now match, but just in
        # case someone is still passing a boolean in as the first
        # argument to this method (or a keyword argument with the old
        # name), we can handle it and put out a DeprecationWarning.
        warning: Optional[str] = None
        pretty_print: Optional[bool] = None
        if isinstance(indent_level, bool):
            if indent_level is True:
                indent_level = 0
            elif indent_level is False:
                indent_level = None
            warning = f"As of 4.13.0, the first argument to BeautifulSoup.decode has been changed from bool to int, to match Tag.decode. Pass in a value of {indent_level} instead."
        else:
            pretty_print = kwargs.pop("pretty_print", None)
            assert not kwargs
            if pretty_print is not None:
                if pretty_print is True:
                    indent_level = 0
                elif pretty_print is False:
                    indent_level = None
                warning = f"As of 4.13.0, the pretty_print argument to BeautifulSoup.decode has been removed, to match Tag.decode. Pass in a value of indent_level={indent_level} instead."

        if warning:
            warnings.warn(warning, DeprecationWarning, stacklevel=2)
        elif indent_level is False or pretty_print is False:
            indent_level = None
        return prefix + super(BeautifulSoup, self).decode(
            indent_level, eventual_encoding, formatter, iterator
        )


# Aliases to make it easier to get started quickly, e.g. 'from bs4 import _soup'
_s = BeautifulSoup
_soup = BeautifulSoup


class BeautifulStoneSoup(BeautifulSoup):
    """Deprecated interface to an XML parser."""

    def __init__(self, *args: Any, **kwargs: Any):
        kwargs["features"] = "xml"
        warnings.warn(
            "The BeautifulStoneSoup class was deprecated in version 4.0.0. Instead of using "
            'it, pass features="xml" into the BeautifulSoup constructor.',
            DeprecationWarning,
            stacklevel=2,
        )
        super(BeautifulStoneSoup, self).__init__(*args, **kwargs)


# If this file is run as a script, act as an HTML pretty-printer.
if __name__ == "__main__":
    import sys

    soup = BeautifulSoup(sys.stdin)
    print((soup.prettify()))

# -*- coding: utf-8 -*-
"""Beautiful Soup bonus library: Unicode, Dammit

This library converts a bytestream to Unicode through any means
necessary. It is heavily based on code from Mark Pilgrim's `Universal
Feed Parser <https://pypi.org/project/feedparser/>`_, now maintained
by Kurt McKee. It does not rewrite the body of an XML or HTML document
to reflect a new encoding; that's the job of `TreeBuilder`.

"""

# Use of this source code is governed by the MIT license.
__license__ = "MIT"

from html.entities import codepoint2name
from collections import defaultdict
import codecs
from html.entities import html5
import re
from logging import Logger, getLogger
from types import ModuleType
from typing import (
    Dict,
    Iterator,
    List,
    Optional,
    Pattern,
    Set,
    Tuple,
    Type,
    Union,
    cast,
)
from typing_extensions import Literal
from bs4._typing import (
    _Encoding,
    _Encodings,
)
import warnings

# Import a library to autodetect character encodings. We'll support
# any of a number of libraries that all support the same API:
#
# * cchardet
# * chardet
# * charset-normalizer
chardet_module: Optional[ModuleType] = None
try:
    #  PyPI package: cchardet
    import cchardet # type:ignore

    chardet_module = cchardet
except ImportError:
    try:
        #  Debian package: python-chardet
        #  PyPI package: chardet
        import chardet

        chardet_module = chardet
    except ImportError:
        try:
            # PyPI package: charset-normalizer
            import charset_normalizer # type:ignore

            chardet_module = charset_normalizer
        except ImportError:
            # No chardet available.
            pass


def _chardet_dammit(s: bytes) -> Optional[str]:
    """Try as hard as possible to detect the encoding of a bytestring."""
    if chardet_module is None or isinstance(s, str):
        return None
    module = chardet_module
    return module.detect(s)["encoding"]


# Build bytestring and Unicode versions of regular expressions for finding
# a declared encoding inside an XML or HTML document.
xml_encoding: str = "^\\s*<\\?.*encoding=['\"](.*?)['\"].*\\?>"  #: :meta private:
html_meta: str = (
    "<\\s*meta[^>]+charset\\s*=\\s*[\"']?([^>]*?)[ /;'\">]"  #: :meta private:
)

# TODO-TYPING: The Pattern type here could use more refinement, but it's tricky.
encoding_res: Dict[Type, Dict[str, Pattern]] = dict()
encoding_res[bytes] = {
    "html": re.compile(html_meta.encode("ascii"), re.I),
    "xml": re.compile(xml_encoding.encode("ascii"), re.I),
}
encoding_res[str] = {
    "html": re.compile(html_meta, re.I),
    "xml": re.compile(xml_encoding, re.I),
}


class EntitySubstitution(object):
    """The ability to substitute XML or HTML entities for certain characters."""

    #: A map of named HTML entities to the corresponding Unicode string.
    #:
    #: :meta hide-value:
    HTML_ENTITY_TO_CHARACTER: Dict[str, str]

    #: A map of Unicode strings to the corresponding named HTML entities;
    #: the inverse of HTML_ENTITY_TO_CHARACTER.
    #:
    #: :meta hide-value:
    CHARACTER_TO_HTML_ENTITY: Dict[str, str]

    #: A regular expression that matches any character (or, in rare
    #: cases, pair of characters) that can be replaced with a named
    #: HTML entity.
    #:
    #: :meta hide-value:
    CHARACTER_TO_HTML_ENTITY_RE: Pattern[str]

    #: A very similar regular expression to
    #: CHARACTER_TO_HTML_ENTITY_RE, but which also matches unescaped
    #: ampersands. This is used by the 'html' formatted to provide
    #: backwards-compatibility, even though the HTML5 spec allows most
    #: ampersands to go unescaped.
    #:
    #: :meta hide-value:
    CHARACTER_TO_HTML_ENTITY_WITH_AMPERSAND_RE: Pattern[str]

    @classmethod
    def _populate_class_variables(cls) -> None:
        """Initialize variables used by this class to manage the plethora of
        HTML5 named entities.

        This function sets the following class variables:

        CHARACTER_TO_HTML_ENTITY - A mapping of Unicode strings like "⦨" to
        entity names like "angmsdaa". When a single Unicode string has
        multiple entity names, we try to choose the most commonly-used
        name.

        HTML_ENTITY_TO_CHARACTER: A mapping of entity names like "angmsdaa" to
        Unicode strings like "⦨".

        CHARACTER_TO_HTML_ENTITY_RE: A regular expression matching (almost) any
        Unicode string that corresponds to an HTML5 named entity.

        CHARACTER_TO_HTML_ENTITY_WITH_AMPERSAND_RE: A very similar
        regular expression to CHARACTER_TO_HTML_ENTITY_RE, but which
        also matches unescaped ampersands. This is used by the 'html'
        formatted to provide backwards-compatibility, even though the HTML5
        spec allows most ampersands to go unescaped.
        """
        unicode_to_name = {}
        name_to_unicode = {}

        short_entities = set()
        long_entities_by_first_character = defaultdict(set)

        for name_with_semicolon, character in sorted(html5.items()):
            # "It is intentional, for legacy compatibility, that many
            # code points have multiple character reference names. For
            # example, some appear both with and without the trailing
            # semicolon, or with different capitalizations."
            # - https://html.spec.whatwg.org/multipage/named-characters.html#named-character-references
            #
            # The parsers are in charge of handling (or not) character
            # references with no trailing semicolon, so we remove the
            # semicolon whenever it appears.
            if name_with_semicolon.endswith(";"):
                name = name_with_semicolon[:-1]
            else:
                name = name_with_semicolon

            # When parsing HTML, we want to recognize any known named
            # entity and convert it to a sequence of Unicode
            # characters.
            if name not in name_to_unicode:
                name_to_unicode[name] = character

            # When _generating_ HTML, we want to recognize special
            # character sequences that _could_ be converted to named
            # entities.
            unicode_to_name[character] = name

            # We also need to build a regular expression that lets us
            # _find_ those characters in output strings so we can
            # replace them.
            #
            # This is tricky, for two reasons.

            if len(character) == 1 and ord(character) < 128 and character not in "<>":
                # First, it would be annoying to turn single ASCII
                # characters like | into named entities like
                # &verbar;. The exceptions are <>, which we _must_
                # turn into named entities to produce valid HTML.
                continue

            if len(character) > 1 and all(ord(x) < 128 for x in character):
                # We also do not want to turn _combinations_ of ASCII
                # characters like 'fj' into named entities like '&fjlig;',
                # though that's more debateable.
                continue

            # Second, some named entities have a Unicode value that's
            # a subset of the Unicode value for some _other_ named
            # entity.  As an example, \u2267' is &GreaterFullEqual;,
            # but '\u2267\u0338' is &NotGreaterFullEqual;. Our regular
            # expression needs to match the first two characters of
            # "\u2267\u0338foo", but only the first character of
            # "\u2267foo".
            #
            # In this step, we build two sets of characters that
            # _eventually_ need to go into the regular expression. But
            # we won't know exactly what the regular expression needs
            # to look like until we've gone through the entire list of
            # named entities.
            if len(character) == 1 and character != "&":
                short_entities.add(character)
            else:
                long_entities_by_first_character[character[0]].add(character)

        # Now that we've been through the entire list of entities, we
        # can create a regular expression that matches any of them.
        particles = set()
        for short in short_entities:
            long_versions = long_entities_by_first_character[short]
            if not long_versions:
                particles.add(short)
            else:
                ignore = "".join([x[1] for x in long_versions])
                # This finds, e.g. \u2267 but only if it is _not_
                # followed by \u0338.
                particles.add("%s(?![%s])" % (short, ignore))

        for long_entities in list(long_entities_by_first_character.values()):
            for long_entity in long_entities:
                particles.add(long_entity)

        re_definition = "(%s)" % "|".join(particles)

        particles.add("&")
        re_definition_with_ampersand = "(%s)" % "|".join(particles)

        # If an entity shows up in both html5 and codepoint2name, it's
        # likely that HTML5 gives it several different names, such as
        # 'rsquo' and 'rsquor'. When converting Unicode characters to
        # named entities, the codepoint2name name should take
        # precedence where possible, since that's the more easily
        # recognizable one.
        for codepoint, name in list(codepoint2name.items()):
            character = chr(codepoint)
            unicode_to_name[character] = name

        cls.CHARACTER_TO_HTML_ENTITY = unicode_to_name
        cls.HTML_ENTITY_TO_CHARACTER = name_to_unicode
        cls.CHARACTER_TO_HTML_ENTITY_RE = re.compile(re_definition)
        cls.CHARACTER_TO_HTML_ENTITY_WITH_AMPERSAND_RE = re.compile(
            re_definition_with_ampersand
        )

    #: A map of Unicode strings to the corresponding named XML entities.
    #:
    #: :meta hide-value:
    CHARACTER_TO_XML_ENTITY: Dict[str, str] = {
        "'": "apos",
        '"': "quot",
        "&": "amp",
        "<": "lt",
        ">": "gt",
    }

    # Matches any named or numeric HTML entity.
    ANY_ENTITY_RE = re.compile("&(#\\d+|#x[0-9a-fA-F]+|\\w+);", re.I)

    #: A regular expression matching an angle bracket or an ampersand that
    #: is not part of an XML or HTML entity.
    #:
    #: :meta hide-value:
    BARE_AMPERSAND_OR_BRACKET: Pattern[str] = re.compile(
        "([<>]|" "&(?!#\\d+;|#x[0-9a-fA-F]+;|\\w+;)" ")"
    )

    #: A regular expression matching an angle bracket or an ampersand.
    #:
    #: :meta hide-value:
    AMPERSAND_OR_BRACKET: Pattern[str] = re.compile("([<>&])")

    @classmethod
    def _substitute_html_entity(cls, matchobj: re.Match) -> str:
        """Used with a regular expression to substitute the
        appropriate HTML entity for a special character string."""
        original_entity = matchobj.group(0)
        entity = cls.CHARACTER_TO_HTML_ENTITY.get(original_entity)
        if entity is None:
            return "&amp;%s;" % original_entity
        return "&%s;" % entity

    @classmethod
    def _substitute_xml_entity(cls, matchobj: re.Match) -> str:
        """Used with a regular expression to substitute the
        appropriate XML entity for a special character string."""
        entity = cls.CHARACTER_TO_XML_ENTITY[matchobj.group(0)]
        return "&%s;" % entity

    @classmethod
    def _escape_entity_name(cls, matchobj: re.Match) -> str:
        return "&amp;%s;" % matchobj.group(1)

    @classmethod
    def _escape_unrecognized_entity_name(cls, matchobj: re.Match) -> str:
        possible_entity = matchobj.group(1)
        if possible_entity in cls.HTML_ENTITY_TO_CHARACTER:
            return "&%s;" % possible_entity
        return "&amp;%s;" % possible_entity

    @classmethod
    def quoted_attribute_value(cls, value: str) -> str:
        """Make a value into a quoted XML attribute, possibly escaping it.

         Most strings will be quoted using double quotes.

          Bob's Bar -> "Bob's Bar"

         If a string contains double quotes, it will be quoted using
         single quotes.

          Welcome to "my bar" -> 'Welcome to "my bar"'

         If a string contains both single and double quotes, the
         double quotes will be escaped, and the string will be quoted
         using double quotes.

          Welcome to "Bob's Bar" -> Welcome to &quot;Bob's bar&quot;

        :param value: The XML attribute value to quote
        :return: The quoted value
        """
        quote_with = '"'
        if '"' in value:
            if "'" in value:
                # The string contains both single and double
                # quotes.  Turn the double quotes into
                # entities. We quote the double quotes rather than
                # the single quotes because the entity name is
                # "&quot;" whether this is HTML or XML.  If we
                # quoted the single quotes, we'd have to decide
                # between &apos; and &squot;.
                replace_with = "&quot;"
                value = value.replace('"', replace_with)
            else:
                # There are double quotes but no single quotes.
                # We can use single quotes to quote the attribute.
                quote_with = "'"
        return quote_with + value + quote_with

    @classmethod
    def substitute_xml(cls, value: str, make_quoted_attribute: bool = False) -> str:
        """Replace special XML characters with named XML entities.

        The less-than sign will become &lt;, the greater-than sign
        will become &gt;, and any ampersands will become &amp;. If you
        want ampersands that seem to be part of an entity definition
        to be left alone, use `substitute_xml_containing_entities`
        instead.

        :param value: A string to be substituted.

        :param make_quoted_attribute: If True, then the string will be
         quoted, as befits an attribute value.

        :return: A version of ``value`` with special characters replaced
         with named entities.
        """
        # Escape angle brackets and ampersands.
        value = cls.AMPERSAND_OR_BRACKET.sub(cls._substitute_xml_entity, value)

        if make_quoted_attribute:
            value = cls.quoted_attribute_value(value)
        return value

    @classmethod
    def substitute_xml_containing_entities(
        cls, value: str, make_quoted_attribute: bool = False
    ) -> str:
        """Substitute XML entities for special XML characters.

        :param value: A string to be substituted. The less-than sign will
          become &lt;, the greater-than sign will become &gt;, and any
          ampersands that are not part of an entity defition will
          become &amp;.

        :param make_quoted_attribute: If True, then the string will be
         quoted, as befits an attribute value.
        """
        # Escape angle brackets, and ampersands that aren't part of
        # entities.
        value = cls.BARE_AMPERSAND_OR_BRACKET.sub(cls._substitute_xml_entity, value)

        if make_quoted_attribute:
            value = cls.quoted_attribute_value(value)
        return value

    @classmethod
    def substitute_html(cls, s: str) -> str:
        """Replace certain Unicode characters with named HTML entities.

        This differs from ``data.encode(encoding, 'xmlcharrefreplace')``
        in that the goal is to make the result more readable (to those
        with ASCII displays) rather than to recover from
        errors. There's absolutely nothing wrong with a UTF-8 string
        containg a LATIN SMALL LETTER E WITH ACUTE, but replacing that
        character with "&eacute;" will make it more readable to some
        people.

        :param s: The string to be modified.
        :return: The string with some Unicode characters replaced with
           HTML entities.
        """
        # Convert any appropriate characters to HTML entities.
        return cls.CHARACTER_TO_HTML_ENTITY_WITH_AMPERSAND_RE.sub(
            cls._substitute_html_entity, s
        )

    @classmethod
    def substitute_html5(cls, s: str) -> str:
        """Replace certain Unicode characters with named HTML entities
        using HTML5 rules.

        Specifically, this method is much less aggressive about
        escaping ampersands than substitute_html. Only ambiguous
        ampersands are escaped, per the HTML5 standard:

        "An ambiguous ampersand is a U+0026 AMPERSAND character (&)
        that is followed by one or more ASCII alphanumerics, followed
        by a U+003B SEMICOLON character (;), where these characters do
        not match any of the names given in the named character
        references section."

        Unlike substitute_html5_raw, this method assumes HTML entities
        were converted to Unicode characters on the way in, as
        Beautiful Soup does. By the time Beautiful Soup does its work,
        the only ambiguous ampersands that need to be escaped are the
        ones that were escaped in the original markup when mentioning
        HTML entities.

        :param s: The string to be modified.
        :return: The string with some Unicode characters replaced with
           HTML entities.
        """
        # First, escape any HTML entities found in the markup.
        s = cls.ANY_ENTITY_RE.sub(cls._escape_entity_name, s)

        # Next, convert any appropriate characters to unescaped HTML entities.
        s = cls.CHARACTER_TO_HTML_ENTITY_RE.sub(cls._substitute_html_entity, s)

        return s

    @classmethod
    def substitute_html5_raw(cls, s: str) -> str:
        """Replace certain Unicode characters with named HTML entities
        using HTML5 rules.

        substitute_html5_raw is similar to substitute_html5 but it is
        designed for standalone use (whereas substitute_html5 is
        designed for use with Beautiful Soup).

        :param s: The string to be modified.
        :return: The string with some Unicode characters replaced with
           HTML entities.
        """
        # First, escape the ampersand for anything that looks like an
        # entity but isn't in the list of recognized entities. All other
        # ampersands can be left alone.
        s = cls.ANY_ENTITY_RE.sub(cls._escape_unrecognized_entity_name, s)

        # Then, convert a range of Unicode characters to unescaped
        # HTML entities.
        s = cls.CHARACTER_TO_HTML_ENTITY_RE.sub(cls._substitute_html_entity, s)

        return s


EntitySubstitution._populate_class_variables()


class EncodingDetector:
    """This class is capable of guessing a number of possible encodings
    for a bytestring.

    Order of precedence:

    1. Encodings you specifically tell EncodingDetector to try first
       (the ``known_definite_encodings`` argument to the constructor).

    2. An encoding determined by sniffing the document's byte-order mark.

    3. Encodings you specifically tell EncodingDetector to try if
       byte-order mark sniffing fails (the ``user_encodings`` argument to the
       constructor).

    4. An encoding declared within the bytestring itself, either in an
       XML declaration (if the bytestring is to be interpreted as an XML
       document), or in a <meta> tag (if the bytestring is to be
       interpreted as an HTML document.)

    5. An encoding detected through textual analysis by chardet,
       cchardet, or a similar external library.

    6. UTF-8.

    7. Windows-1252.

    :param markup: Some markup in an unknown encoding.

    :param known_definite_encodings: When determining the encoding
        of ``markup``, these encodings will be tried first, in
        order. In HTML terms, this corresponds to the "known
        definite encoding" step defined in `section 13.2.3.1 of the HTML standard <https://html.spec.whatwg.org/multipage/parsing.html#parsing-with-a-known-character-encoding>`_.

    :param user_encodings: These encodings will be tried after the
        ``known_definite_encodings`` have been tried and failed, and
        after an attempt to sniff the encoding by looking at a
        byte order mark has failed. In HTML terms, this
        corresponds to the step "user has explicitly instructed
        the user agent to override the document's character
        encoding", defined in `section 13.2.3.2 of the HTML standard <https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding>`_.

    :param override_encodings: A **deprecated** alias for
        ``known_definite_encodings``. Any encodings here will be tried
        immediately after the encodings in
        ``known_definite_encodings``.

    :param is_html: If True, this markup is considered to be
        HTML. Otherwise it's assumed to be XML.

    :param exclude_encodings: These encodings will not be tried,
        even if they otherwise would be.

    """

    def __init__(
        self,
        markup: bytes,
        known_definite_encodings: Optional[_Encodings] = None,
        is_html: Optional[bool] = False,
        exclude_encodings: Optional[_Encodings] = None,
        user_encodings: Optional[_Encodings] = None,
        override_encodings: Optional[_Encodings] = None,
    ):
        self.known_definite_encodings = list(known_definite_encodings or [])
        if override_encodings:
            warnings.warn(
                "The 'override_encodings' argument was deprecated in 4.10.0. Use 'known_definite_encodings' instead.",
                DeprecationWarning,
                stacklevel=3,
            )
            self.known_definite_encodings += override_encodings
        self.user_encodings = user_encodings or []
        exclude_encodings = exclude_encodings or []
        self.exclude_encodings = set([x.lower() for x in exclude_encodings])
        self.chardet_encoding = None
        self.is_html = False if is_html is None else is_html
        self.declared_encoding: Optional[str] = None

        # First order of business: strip a byte-order mark.
        self.markup, self.sniffed_encoding = self.strip_byte_order_mark(markup)

    known_definite_encodings: _Encodings
    user_encodings: _Encodings
    exclude_encodings: _Encodings
    chardet_encoding: Optional[_Encoding]
    is_html: bool
    declared_encoding: Optional[_Encoding]
    markup: bytes
    sniffed_encoding: Optional[_Encoding]

    def _usable(self, encoding: Optional[_Encoding], tried: Set[_Encoding]) -> bool:
        """Should we even bother to try this encoding?

        :param encoding: Name of an encoding.
        :param tried: Encodings that have already been tried. This
            will be modified as a side effect.
        """
        if encoding is None:
            return False
        encoding = encoding.lower()
        if encoding in self.exclude_encodings:
            return False
        if encoding not in tried:
            tried.add(encoding)
            return True
        return False

    @property
    def encodings(self) -> Iterator[_Encoding]:
        """Yield a number of encodings that might work for this markup.

        :yield: A sequence of strings. Each is the name of an encoding
           that *might* work to convert a bytestring into Unicode.
        """
        tried: Set[_Encoding] = set()

        # First, try the known definite encodings
        for e in self.known_definite_encodings:
            if self._usable(e, tried):
                yield e

        # Did the document originally start with a byte-order mark
        # that indicated its encoding?
        if self.sniffed_encoding is not None and self._usable(
            self.sniffed_encoding, tried
        ):
            yield self.sniffed_encoding

        # Sniffing the byte-order mark did nothing; try the user
        # encodings.
        for e in self.user_encodings:
            if self._usable(e, tried):
                yield e

        # Look within the document for an XML or HTML encoding
        # declaration.
        if self.declared_encoding is None:
            self.declared_encoding = self.find_declared_encoding(
                self.markup, self.is_html
            )
        if self.declared_encoding is not None and self._usable(
            self.declared_encoding, tried
        ):
            yield self.declared_encoding

        # Use third-party character set detection to guess at the
        # encoding.
        if self.chardet_encoding is None:
            self.chardet_encoding = _chardet_dammit(self.markup)
        if self.chardet_encoding is not None and self._usable(
            self.chardet_encoding, tried
        ):
            yield self.chardet_encoding

        # As a last-ditch effort, try utf-8 and windows-1252.
        for e in ("utf-8", "windows-1252"):
            if self._usable(e, tried):
                yield e

    @classmethod
    def strip_byte_order_mark(cls, data: bytes) -> Tuple[bytes, Optional[_Encoding]]:
        """If a byte-order mark is present, strip it and return the encoding it implies.

        :param data: A bytestring that may or may not begin with a
           byte-order mark.

        :return: A 2-tuple (data stripped of byte-order mark, encoding implied by byte-order mark)
        """
        encoding = None
        if isinstance(data, str):
            # Unicode data cannot have a byte-order mark.
            return data, encoding
        if (
            (len(data) >= 4)
            and (data[:2] == b"\xfe\xff")
            and (data[2:4] != b"\x00\x00")
        ):
            encoding = "utf-16be"
            data = data[2:]
        elif (
            (len(data) >= 4)
            and (data[:2] == b"\xff\xfe")
            and (data[2:4] != b"\x00\x00")
        ):
            encoding = "utf-16le"
            data = data[2:]
        elif data[:3] == b"\xef\xbb\xbf":
            encoding = "utf-8"
            data = data[3:]
        elif data[:4] == b"\x00\x00\xfe\xff":
            encoding = "utf-32be"
            data = data[4:]
        elif data[:4] == b"\xff\xfe\x00\x00":
            encoding = "utf-32le"
            data = data[4:]
        return data, encoding

    @classmethod
    def find_declared_encoding(
        cls,
        markup: Union[bytes, str],
        is_html: bool = False,
        search_entire_document: bool = False,
    ) -> Optional[_Encoding]:
        """Given a document, tries to find an encoding declared within the
        text of the document itself.

        An XML encoding is declared at the beginning of the document.

        An HTML encoding is declared in a <meta> tag, hopefully near the
        beginning of the document.

        :param markup: Some markup.
        :param is_html: If True, this markup is considered to be HTML. Otherwise
            it's assumed to be XML.
        :param search_entire_document: Since an encoding is supposed
            to declared near the beginning of the document, most of
            the time it's only necessary to search a few kilobytes of
            data.  Set this to True to force this method to search the
            entire document.
        :return: The declared encoding, if one is found.
        """
        if search_entire_document:
            xml_endpos = html_endpos = len(markup)
        else:
            xml_endpos = 1024
            html_endpos = max(2048, int(len(markup) * 0.05))

        if isinstance(markup, bytes):
            res = encoding_res[bytes]
        else:
            res = encoding_res[str]

        xml_re = res["xml"]
        html_re = res["html"]
        declared_encoding: Optional[_Encoding] = None
        declared_encoding_match = xml_re.search(markup, endpos=xml_endpos)
        if not declared_encoding_match and is_html:
            declared_encoding_match = html_re.search(markup, endpos=html_endpos)
        if declared_encoding_match is not None:
            declared_encoding = declared_encoding_match.groups()[0]
        if declared_encoding:
            if isinstance(declared_encoding, bytes):
                declared_encoding = declared_encoding.decode("ascii", "replace")
            return declared_encoding.lower()
        return None


class UnicodeDammit:
    """A class for detecting the encoding of a bytestring containing an
    HTML or XML document, and decoding it to Unicode. If the source
    encoding is windows-1252, `UnicodeDammit` can also replace
    Microsoft smart quotes with their HTML or XML equivalents.

    :param markup: HTML or XML markup in an unknown encoding.

    :param known_definite_encodings: When determining the encoding
        of ``markup``, these encodings will be tried first, in
        order. In HTML terms, this corresponds to the "known
        definite encoding" step defined in `section 13.2.3.1 of the HTML standard <https://html.spec.whatwg.org/multipage/parsing.html#parsing-with-a-known-character-encoding>`_.

    :param user_encodings: These encodings will be tried after the
        ``known_definite_encodings`` have been tried and failed, and
        after an attempt to sniff the encoding by looking at a
        byte order mark has failed. In HTML terms, this
        corresponds to the step "user has explicitly instructed
        the user agent to override the document's character
        encoding", defined in `section 13.2.3.2 of the HTML standard <https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding>`_.

    :param override_encodings: A **deprecated** alias for
        ``known_definite_encodings``. Any encodings here will be tried
        immediately after the encodings in
        ``known_definite_encodings``.

    :param smart_quotes_to: By default, Microsoft smart quotes will,
       like all other characters, be converted to Unicode
       characters. Setting this to ``ascii`` will convert them to ASCII
       quotes instead.  Setting it to ``xml`` will convert them to XML
       entity references, and setting it to ``html`` will convert them
       to HTML entity references.

    :param is_html: If True, ``markup`` is treated as an HTML
       document. Otherwise it's treated as an XML document.

    :param exclude_encodings: These encodings will not be considered,
       even if the sniffing code thinks they might make sense.

    """

    def __init__(
        self,
        markup: bytes,
        known_definite_encodings: Optional[_Encodings] = [],
        smart_quotes_to: Optional[Literal["ascii", "xml", "html"]] = None,
        is_html: bool = False,
        exclude_encodings: Optional[_Encodings] = [],
        user_encodings: Optional[_Encodings] = None,
        override_encodings: Optional[_Encodings] = None,
    ):
        self.smart_quotes_to = smart_quotes_to
        self.tried_encodings = []
        self.contains_replacement_characters = False
        self.is_html = is_html
        self.log = getLogger(__name__)
        self.detector = EncodingDetector(
            markup,
            known_definite_encodings,
            is_html,
            exclude_encodings,
            user_encodings,
            override_encodings,
        )

        # Short-circuit if the data is in Unicode to begin with.
        if isinstance(markup, str):
            self.markup = markup.encode("utf8")
            self.unicode_markup = markup
            self.original_encoding = None
            return

        # The encoding detector may have stripped a byte-order mark.
        # Use the stripped markup from this point on.
        self.markup = self.detector.markup

        u = None
        for encoding in self.detector.encodings:
            markup = self.detector.markup
            u = self._convert_from(encoding)
            if u is not None:
                break

        if not u:
            # None of the encodings worked. As an absolute last resort,
            # try them again with character replacement.

            for encoding in self.detector.encodings:
                if encoding != "ascii":
                    u = self._convert_from(encoding, "replace")
                if u is not None:
                    self.log.warning(
                        "Some characters could not be decoded, and were "
                        "replaced with REPLACEMENT CHARACTER."
                    )

                    self.contains_replacement_characters = True
                    break

        # If none of that worked, we could at this point force it to
        # ASCII, but that would destroy so much data that I think
        # giving up is better.
        #
        # Note that this is extremely unlikely, probably impossible,
        # because the "replace" strategy is so powerful. Even running
        # the Python binary through Unicode, Dammit gives you Unicode,
        # albeit Unicode riddled with REPLACEMENT CHARACTER.
        if u is None:
            self.original_encoding = None
            self.unicode_markup = None
        else:
            self.unicode_markup = u

    #: The original markup, before it was converted to Unicode.
    #: This is not necessarily the same as what was passed in to the
    #: constructor, since any byte-order mark will be stripped.
    markup: bytes

    #: The Unicode version of the markup, following conversion. This
    #: is set to None if there was simply no way to convert the
    #: bytestring to Unicode (as with binary data).
    unicode_markup: Optional[str]

    #: This is True if `UnicodeDammit.unicode_markup` contains
    #: U+FFFD REPLACEMENT_CHARACTER characters which were not present
    #: in `UnicodeDammit.markup`. These mark character sequences that
    #: could not be represented in Unicode.
    contains_replacement_characters: bool

    #: Unicode, Dammit's best guess as to the original character
    #: encoding of `UnicodeDammit.markup`.
    original_encoding: Optional[_Encoding]

    #: The strategy used to handle Microsoft smart quotes.
    smart_quotes_to: Optional[str]

    #: The (encoding, error handling strategy) 2-tuples that were used to
    #: try and convert the markup to Unicode.
    tried_encodings: List[Tuple[_Encoding, str]]

    log: Logger  #: :meta private:

    def _sub_ms_char(self, match: re.Match) -> bytes:
        """Changes a MS smart quote character to an XML or HTML
        entity, or an ASCII character.

        TODO: Since this is only used to convert smart quotes, it
        could be simplified, and MS_CHARS_TO_ASCII made much less
        parochial.
        """
        orig: bytes = match.group(1)
        sub: bytes
        if self.smart_quotes_to == "ascii":
            if orig in self.MS_CHARS_TO_ASCII:
                sub = self.MS_CHARS_TO_ASCII[orig].encode()
            else:
                # Shouldn't happen; substitute the character
                # with itself.
                sub = orig
        else:
            if orig in self.MS_CHARS:
                substitutions = self.MS_CHARS[orig]
                if type(substitutions) is tuple:
                    if self.smart_quotes_to == "xml":
                        sub = b"&#x" + substitutions[1].encode() + b";"
                    else:
                        sub = b"&" + substitutions[0].encode() + b";"
                else:
                    substitutions = cast(str, substitutions)
                    sub = substitutions.encode()
            else:
                # Shouldn't happen; substitute the character
                # for itself.
                sub = orig
        return sub

    #: This dictionary maps commonly seen values for "charset" in HTML
    #: meta tags to the corresponding Python codec names. It only covers
    #: values that aren't in Python's aliases and can't be determined
    #: by the heuristics in `find_codec`.
    #:
    #: :meta hide-value:
    CHARSET_ALIASES: Dict[str, _Encoding] = {
        "macintosh": "mac-roman",
        "x-sjis": "shift-jis",
    }

    #: A list of encodings that tend to contain Microsoft smart quotes.
    #:
    #: :meta hide-value:
    ENCODINGS_WITH_SMART_QUOTES: _Encodings = [
        "windows-1252",
        "iso-8859-1",
        "iso-8859-2",
    ]

    def _convert_from(
        self, proposed: _Encoding, errors: str = "strict"
    ) -> Optional[str]:
        """Attempt to convert the markup to the proposed encoding.

        :param proposed: The name of a character encoding.
        :param errors: An error handling strategy, used when calling `str`.
        :return: The converted markup, or `None` if the proposed
           encoding/error handling strategy didn't work.
        """
        lookup_result = self.find_codec(proposed)
        if lookup_result is None or (lookup_result, errors) in self.tried_encodings:
            return None
        proposed = lookup_result
        self.tried_encodings.append((proposed, errors))
        markup = self.markup
        # Convert smart quotes to HTML if coming from an encoding
        # that might have them.
        if (
            self.smart_quotes_to is not None
            and proposed in self.ENCODINGS_WITH_SMART_QUOTES
        ):
            smart_quotes_re = b"([\x80-\x9f])"
            smart_quotes_compiled = re.compile(smart_quotes_re)
            markup = smart_quotes_compiled.sub(self._sub_ms_char, markup)

        try:
            # print("Trying to convert document to %s (errors=%s)" % (
            #    proposed, errors))
            u = self._to_unicode(markup, proposed, errors)
            self.unicode_markup = u
            self.original_encoding = proposed
        except Exception:
            # print("That didn't work!")
            # print(e)
            return None
        # print("Correct encoding: %s" % proposed)
        return self.unicode_markup

    def _to_unicode(
        self, data: bytes, encoding: _Encoding, errors: str = "strict"
    ) -> str:
        """Given a bytestring and its encoding, decodes the string into Unicode.

        :param encoding: The name of an encoding.
        :param errors: An error handling strategy, used when calling `str`.
        """
        return str(data, encoding, errors)

    @property
    def declared_html_encoding(self) -> Optional[_Encoding]:
        """If the markup is an HTML document, returns the encoding, if any,
        declared *inside* the document.
        """
        if not self.is_html:
            return None
        return self.detector.declared_encoding

    def find_codec(self, charset: _Encoding) -> Optional[str]:
        """Look up the Python codec corresponding to a given character set.

        :param charset: The name of a character set.
        :return: The name of a Python codec.
        """
        value = (
            self._codec(self.CHARSET_ALIASES.get(charset, charset))
            or (charset and self._codec(charset.replace("-", "")))
            or (charset and self._codec(charset.replace("-", "_")))
            or (charset and charset.lower())
            or charset
        )
        if value:
            return value.lower()
        return None

    def _codec(self, charset: _Encoding) -> Optional[str]:
        if not charset:
            return charset
        codec = None
        try:
            codecs.lookup(charset)
            codec = charset
        except (LookupError, ValueError):
            pass
        return codec

    #: A partial mapping of ISO-Latin-1 to HTML entities/XML numeric entities.
    #:
    #: :meta hide-value:
    MS_CHARS: Dict[bytes, Union[str, Tuple[str, str]]] = {
        b"\x80": ("euro", "20AC"),
        b"\x81": " ",
        b"\x82": ("sbquo", "201A"),
        b"\x83": ("fnof", "192"),
        b"\x84": ("bdquo", "201E"),
        b"\x85": ("hellip", "2026"),
        b"\x86": ("dagger", "2020"),
        b"\x87": ("Dagger", "2021"),
        b"\x88": ("circ", "2C6"),
        b"\x89": ("permil", "2030"),
        b"\x8a": ("Scaron", "160"),
        b"\x8b": ("lsaquo", "2039"),
        b"\x8c": ("OElig", "152"),
        b"\x8d": "?",
        b"\x8e": ("#x17D", "17D"),
        b"\x8f": "?",
        b"\x90": "?",
        b"\x91": ("lsquo", "2018"),
        b"\x92": ("rsquo", "2019"),
        b"\x93": ("ldquo", "201C"),
        b"\x94": ("rdquo", "201D"),
        b"\x95": ("bull", "2022"),
        b"\x96": ("ndash", "2013"),
        b"\x97": ("mdash", "2014"),
        b"\x98": ("tilde", "2DC"),
        b"\x99": ("trade", "2122"),
        b"\x9a": ("scaron", "161"),
        b"\x9b": ("rsaquo", "203A"),
        b"\x9c": ("oelig", "153"),
        b"\x9d": "?",
        b"\x9e": ("#x17E", "17E"),
        b"\x9f": ("Yuml", ""),
    }

    #: A parochial partial mapping of ISO-Latin-1 to ASCII. Contains
    #: horrors like stripping diacritical marks to turn á into a, but also
    #: contains non-horrors like turning “ into ".
    #:
    #: Seriously, don't use this for anything other than removing smart
    #: quotes.
    #:
    #: :meta private:
    MS_CHARS_TO_ASCII: Dict[bytes, str] = {
        b"\x80": "EUR",
        b"\x81": " ",
        b"\x82": ",",
        b"\x83": "f",
        b"\x84": ",,",
        b"\x85": "...",
        b"\x86": "+",
        b"\x87": "++",
        b"\x88": "^",
        b"\x89": "%",
        b"\x8a": "S",
        b"\x8b": "<",
        b"\x8c": "OE",
        b"\x8d": "?",
        b"\x8e": "Z",
        b"\x8f": "?",
        b"\x90": "?",
        b"\x91": "'",
        b"\x92": "'",
        b"\x93": '"',
        b"\x94": '"',
        b"\x95": "*",
        b"\x96": "-",
        b"\x97": "--",
        b"\x98": "~",
        b"\x99": "(TM)",
        b"\x9a": "s",
        b"\x9b": ">",
        b"\x9c": "oe",
        b"\x9d": "?",
        b"\x9e": "z",
        b"\x9f": "Y",
        b"\xa0": " ",
        b"\xa1": "!",
        b"\xa2": "c",
        b"\xa3": "GBP",
        b"\xa4": "$",  # This approximation is especially parochial--this is the
        # generic currency symbol.
        b"\xa5": "YEN",
        b"\xa6": "|",
        b"\xa7": "S",
        b"\xa8": "..",
        b"\xa9": "",
        b"\xaa": "(th)",
        b"\xab": "<<",
        b"\xac": "!",
        b"\xad": " ",
        b"\xae": "(R)",
        b"\xaf": "-",
        b"\xb0": "o",
        b"\xb1": "+-",
        b"\xb2": "2",
        b"\xb3": "3",
        b"\xb4": "'",
        b"\xb5": "u",
        b"\xb6": "P",
        b"\xb7": "*",
        b"\xb8": ",",
        b"\xb9": "1",
        b"\xba": "(th)",
        b"\xbb": ">>",
        b"\xbc": "1/4",
        b"\xbd": "1/2",
        b"\xbe": "3/4",
        b"\xbf": "?",
        b"\xc0": "A",
        b"\xc1": "A",
        b"\xc2": "A",
        b"\xc3": "A",
        b"\xc4": "A",
        b"\xc5": "A",
        b"\xc6": "AE",
        b"\xc7": "C",
        b"\xc8": "E",
        b"\xc9": "E",
        b"\xca": "E",
        b"\xcb": "E",
        b"\xcc": "I",
        b"\xcd": "I",
        b"\xce": "I",
        b"\xcf": "I",
        b"\xd0": "D",
        b"\xd1": "N",
        b"\xd2": "O",
        b"\xd3": "O",
        b"\xd4": "O",
        b"\xd5": "O",
        b"\xd6": "O",
        b"\xd7": "*",
        b"\xd8": "O",
        b"\xd9": "U",
        b"\xda": "U",
        b"\xdb": "U",
        b"\xdc": "U",
        b"\xdd": "Y",
        b"\xde": "b",
        b"\xdf": "B",
        b"\xe0": "a",
        b"\xe1": "a",
        b"\xe2": "a",
        b"\xe3": "a",
        b"\xe4": "a",
        b"\xe5": "a",
        b"\xe6": "ae",
        b"\xe7": "c",
        b"\xe8": "e",
        b"\xe9": "e",
        b"\xea": "e",
        b"\xeb": "e",
        b"\xec": "i",
        b"\xed": "i",
        b"\xee": "i",
        b"\xef": "i",
        b"\xf0": "o",
        b"\xf1": "n",
        b"\xf2": "o",
        b"\xf3": "o",
        b"\xf4": "o",
        b"\xf5": "o",
        b"\xf6": "o",
        b"\xf7": "/",
        b"\xf8": "o",
        b"\xf9": "u",
        b"\xfa": "u",
        b"\xfb": "u",
        b"\xfc": "u",
        b"\xfd": "y",
        b"\xfe": "b",
        b"\xff": "y",
    }

    #: A map used when removing rogue Windows-1252/ISO-8859-1
    #: characters in otherwise UTF-8 documents. Also used when a
    #: numeric character entity has been incorrectly encoded using the
    #: character's Windows-1252 encoding.
    #:
    #: Note that \\x81, \\x8d, \\x8f, \\x90, and \\x9d are undefined in
    #: Windows-1252.
    #:
    #: :meta hide-value:
    WINDOWS_1252_TO_UTF8: Dict[int, bytes] = {
        0x80: b"\xe2\x82\xac",  # €
        0x82: b"\xe2\x80\x9a",  # ‚
        0x83: b"\xc6\x92",  # ƒ
        0x84: b"\xe2\x80\x9e",  # „
        0x85: b"\xe2\x80\xa6",  # …
        0x86: b"\xe2\x80\xa0",  # †
        0x87: b"\xe2\x80\xa1",  # ‡
        0x88: b"\xcb\x86",  # ˆ
        0x89: b"\xe2\x80\xb0",  # ‰
        0x8A: b"\xc5\xa0",  # Š
        0x8B: b"\xe2\x80\xb9",  # ‹
        0x8C: b"\xc5\x92",  # Œ
        0x8E: b"\xc5\xbd",  # Ž
        0x91: b"\xe2\x80\x98",  # ‘
        0x92: b"\xe2\x80\x99",  # ’
        0x93: b"\xe2\x80\x9c",  # “
        0x94: b"\xe2\x80\x9d",  # ”
        0x95: b"\xe2\x80\xa2",  # •
        0x96: b"\xe2\x80\x93",  # –
        0x97: b"\xe2\x80\x94",  # —
        0x98: b"\xcb\x9c",  # ˜
        0x99: b"\xe2\x84\xa2",  # ™
        0x9A: b"\xc5\xa1",  # š
        0x9B: b"\xe2\x80\xba",  # ›
        0x9C: b"\xc5\x93",  # œ
        0x9E: b"\xc5\xbe",  # ž
        0x9F: b"\xc5\xb8",  # Ÿ
        0xA0: b"\xc2\xa0",  #
        0xA1: b"\xc2\xa1",  # ¡
        0xA2: b"\xc2\xa2",  # ¢
        0xA3: b"\xc2\xa3",  # £
        0xA4: b"\xc2\xa4",  # ¤
        0xA5: b"\xc2\xa5",  # ¥
        0xA6: b"\xc2\xa6",  # ¦
        0xA7: b"\xc2\xa7",  # §
        0xA8: b"\xc2\xa8",  # ¨
        0xA9: b"\xc2\xa9",  # ©
        0xAA: b"\xc2\xaa",  # ª
        0xAB: b"\xc2\xab",  # «
        0xAC: b"\xc2\xac",  # ¬
        0xAD: b"\xc2\xad",  # ­
        0xAE: b"\xc2\xae",  # ®
        0xAF: b"\xc2\xaf",  # ¯
        0xB0: b"\xc2\xb0",  # °
        0xB1: b"\xc2\xb1",  # ±
        0xB2: b"\xc2\xb2",  # ²
        0xB3: b"\xc2\xb3",  # ³
        0xB4: b"\xc2\xb4",  # ´
        0xB5: b"\xc2\xb5",  # µ
        0xB6: b"\xc2\xb6",  # ¶
        0xB7: b"\xc2\xb7",  # ·
        0xB8: b"\xc2\xb8",  # ¸
        0xB9: b"\xc2\xb9",  # ¹
        0xBA: b"\xc2\xba",  # º
        0xBB: b"\xc2\xbb",  # »
        0xBC: b"\xc2\xbc",  # ¼
        0xBD: b"\xc2\xbd",  # ½
        0xBE: b"\xc2\xbe",  # ¾
        0xBF: b"\xc2\xbf",  # ¿
        0xC0: b"\xc3\x80",  # À
        0xC1: b"\xc3\x81",  # Á
        0xC2: b"\xc3\x82",  # Â
        0xC3: b"\xc3\x83",  # Ã
        0xC4: b"\xc3\x84",  # Ä
        0xC5: b"\xc3\x85",  # Å
        0xC6: b"\xc3\x86",  # Æ
        0xC7: b"\xc3\x87",  # Ç
        0xC8: b"\xc3\x88",  # È
        0xC9: b"\xc3\x89",  # É
        0xCA: b"\xc3\x8a",  # Ê
        0xCB: b"\xc3\x8b",  # Ë
        0xCC: b"\xc3\x8c",  # Ì
        0xCD: b"\xc3\x8d",  # Í
        0xCE: b"\xc3\x8e",  # Î
        0xCF: b"\xc3\x8f",  # Ï
        0xD0: b"\xc3\x90",  # Ð
        0xD1: b"\xc3\x91",  # Ñ
        0xD2: b"\xc3\x92",  # Ò
        0xD3: b"\xc3\x93",  # Ó
        0xD4: b"\xc3\x94",  # Ô
        0xD5: b"\xc3\x95",  # Õ
        0xD6: b"\xc3\x96",  # Ö
        0xD7: b"\xc3\x97",  # ×
        0xD8: b"\xc3\x98",  # Ø
        0xD9: b"\xc3\x99",  # Ù
        0xDA: b"\xc3\x9a",  # Ú
        0xDB: b"\xc3\x9b",  # Û
        0xDC: b"\xc3\x9c",  # Ü
        0xDD: b"\xc3\x9d",  # Ý
        0xDE: b"\xc3\x9e",  # Þ
        0xDF: b"\xc3\x9f",  # ß
        0xE0: b"\xc3\xa0",  # à
        0xE1: b"\xa1",  # á
        0xE2: b"\xc3\xa2",  # â
        0xE3: b"\xc3\xa3",  # ã
        0xE4: b"\xc3\xa4",  # ä
        0xE5: b"\xc3\xa5",  # å
        0xE6: b"\xc3\xa6",  # æ
        0xE7: b"\xc3\xa7",  # ç
        0xE8: b"\xc3\xa8",  # è
        0xE9: b"\xc3\xa9",  # é
        0xEA: b"\xc3\xaa",  # ê
        0xEB: b"\xc3\xab",  # ë
        0xEC: b"\xc3\xac",  # ì
        0xED: b"\xc3\xad",  # í
        0xEE: b"\xc3\xae",  # î
        0xEF: b"\xc3\xaf",  # ï
        0xF0: b"\xc3\xb0",  # ð
        0xF1: b"\xc3\xb1",  # ñ
        0xF2: b"\xc3\xb2",  # ò
        0xF3: b"\xc3\xb3",  # ó
        0xF4: b"\xc3\xb4",  # ô
        0xF5: b"\xc3\xb5",  # õ
        0xF6: b"\xc3\xb6",  # ö
        0xF7: b"\xc3\xb7",  # ÷
        0xF8: b"\xc3\xb8",  # ø
        0xF9: b"\xc3\xb9",  # ù
        0xFA: b"\xc3\xba",  # ú
        0xFB: b"\xc3\xbb",  # û
        0xFC: b"\xc3\xbc",  # ü
        0xFD: b"\xc3\xbd",  # ý
        0xFE: b"\xc3\xbe",  # þ
        0xFF: b"\xc3\xbf",  # ÿ
    }

    #: :meta private
    # Note that this isn't all Unicode noncharacters, just the noncontiguous ones that need to be listed.
    #
    # "A noncharacter is a code point that is in the range
    # U+FDD0 to U+FDEF, inclusive, or U+FFFE, U+FFFF, U+1FFFE,
    # U+1FFFF, U+2FFFE, U+2FFFF, U+3FFFE, U+3FFFF, U+4FFFE,
    # U+4FFFF, U+5FFFE, U+5FFFF, U+6FFFE, U+6FFFF, U+7FFFE,
    # U+7FFFF, U+8FFFE, U+8FFFF, U+9FFFE, U+9FFFF, U+AFFFE,
    # U+AFFFF, U+BFFFE, U+BFFFF, U+CFFFE, U+CFFFF, U+DFFFE,
    # U+DFFFF, U+EFFFE, U+EFFFF, U+FFFFE, U+FFFFF, U+10FFFE,
    # or U+10FFFF."
    ENUMERATED_NONCHARACTERS: Set[int] = set([0xfffe, 0xffff,
                                              0x1fffe, 0x1ffff,
                                              0x2fffe, 0x2ffff,
                                              0x3fffe, 0x3ffff,
                                              0x4fffe, 0x4ffff,
                                              0x5fffe, 0x5ffff,
                                              0x6fffe, 0x6ffff,
                                              0x7fffe, 0x7ffff,
                                              0x8fffe, 0x8ffff,
                                              0x9fffe, 0x9ffff,
                                              0xafffe, 0xaffff,
                                              0xbfffe, 0xbffff,
                                              0xcfffe, 0xcffff,
                                              0xdfffe, 0xdffff,
                                              0xefffe, 0xeffff,
                                              0xffffe, 0xfffff,
                                              0x10fffe, 0x10ffff])

    #: :meta private:
    MULTIBYTE_MARKERS_AND_SIZES: List[Tuple[int, int, int]] = [
        (0xC2, 0xDF, 2),  # 2-byte characters start with a byte C2-DF
        (0xE0, 0xEF, 3),  # 3-byte characters start with E0-EF
        (0xF0, 0xF4, 4),  # 4-byte characters start with F0-F4
    ]

    #: :meta private:
    FIRST_MULTIBYTE_MARKER: int = MULTIBYTE_MARKERS_AND_SIZES[0][0]

    #: :meta private:
    LAST_MULTIBYTE_MARKER: int = MULTIBYTE_MARKERS_AND_SIZES[-1][1]

    @classmethod
    def numeric_character_reference(cls, numeric:int) -> Tuple[str, bool]:
        """This (mostly) implements the algorithm described in "Numeric character
        reference end state" from the HTML spec:
        https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state

        The algorithm is designed to convert numeric character references like "&#9731;"
        to Unicode characters like "☃".

        :return: A 2-tuple (character, replaced). `character` is the Unicode
        character corresponding to the numeric reference and `replaced` is
        whether or not an unresolvable character was replaced with REPLACEMENT
        CHARACTER.
        """
        replacement = "\ufffd"

        if numeric == 0x00:
            # "If the number is 0x00, then this is a
            # null-character-reference parse error. Set the character
            # reference code to 0xFFFD."
            return replacement, True

        if numeric > 0x10ffff:
            # "If the number is greater than 0x10FFFF, then this is a
            # character-reference-outside-unicode-range parse
            # error. Set the character reference code to 0xFFFD."
            return replacement, True

        if numeric >= 0xd800 and numeric <= 0xdfff:
            # "If the number is a surrogate, then this is a
            # surrogate-character-reference parse error. Set the
            # character reference code to 0xFFFD."
            return replacement, True

        if (numeric >= 0xfdd0 and numeric <= 0xfdef) or numeric in cls.ENUMERATED_NONCHARACTERS:
            # "If the number is a noncharacter, then this is a
            # noncharacter-character-reference parse error."
            #
            # "The parser resolves such character references as-is."
            #
            # I'm not sure what "as-is" means but I think it means that we act
            # like there was no error condition.
            return chr(numeric), False

        # "If the number is 0x0D, or a control that's not ASCII whitespace,
        # then this is a control-character-reference parse error."
        #
        # "A control is a C0 control or a code point in the range
        # U+007F DELETE to U+009F APPLICATION PROGRAM COMMAND,
        # inclusive."
        #
        # "A C0 control is a code point in the range U+0000 NULL to U+001F INFORMATION SEPARATOR ONE, inclusive."
        #
        # "The parser resolves such character references as-is except C1 control references that are replaced."

        # First, let's replace the control references that can be replaced.
        if numeric >= 0x80 and numeric <= 0x9f and numeric in cls.WINDOWS_1252_TO_UTF8:
            # "If the number is one of the numbers in the first column of the
            # following table, then find the row with that number in the first
            # column, and set the character reference code to the number in the
            # second column of that row."
            #
            # This is an attempt to catch characters that were encoded to numeric
            # entities using their Windows-1252 encodings rather than their UTF-8
            # encodings.
            return cls.WINDOWS_1252_TO_UTF8[numeric].decode("utf8"), False

        # Now all that's left are references that should be resolved as-is. This
        # is also the default path for non-weird character references.
        try:
            return chr(numeric), False
        except (ValueError, OverflowError):
            # This shouldn't happen, since these cases should have been handled
            # above, but if it does, return REPLACEMENT CHARACTER
            return replacement, True

    @classmethod
    def detwingle(
        cls,
        in_bytes: bytes,
        main_encoding: _Encoding = "utf8",
        embedded_encoding: _Encoding = "windows-1252",
    ) -> bytes:
        """Fix characters from one encoding embedded in some other encoding.

        Currently the only situation supported is Windows-1252 (or its
        subset ISO-8859-1), embedded in UTF-8.

        :param in_bytes: A bytestring that you suspect contains
            characters from multiple encodings. Note that this *must*
            be a bytestring. If you've already converted the document
            to Unicode, you're too late.
        :param main_encoding: The primary encoding of ``in_bytes``.
        :param embedded_encoding: The encoding that was used to embed characters
            in the main document.
        :return: A bytestring similar to ``in_bytes``, in which
          ``embedded_encoding`` characters have been converted to
          their ``main_encoding`` equivalents.
        """
        if embedded_encoding.replace("_", "-").lower() not in (
            "windows-1252",
            "windows_1252",
        ):
            raise NotImplementedError(
                "Windows-1252 and ISO-8859-1 are the only currently supported "
                "embedded encodings."
            )

        if main_encoding.lower() not in ("utf8", "utf-8"):
            raise NotImplementedError(
                "UTF-8 is the only currently supported main encoding."
            )

        byte_chunks = []

        chunk_start = 0
        pos = 0
        while pos < len(in_bytes):
            byte = in_bytes[pos]
            if byte >= cls.FIRST_MULTIBYTE_MARKER and byte <= cls.LAST_MULTIBYTE_MARKER:
                # This is the start of a UTF-8 multibyte character. Skip
                # to the end.
                for start, end, size in cls.MULTIBYTE_MARKERS_AND_SIZES:
                    if byte >= start and byte <= end:
                        pos += size
                        break
            elif byte >= 0x80 and byte in cls.WINDOWS_1252_TO_UTF8:
                # We found a Windows-1252 character!
                # Save the string up to this point as a chunk.
                byte_chunks.append(in_bytes[chunk_start:pos])

                # Now translate the Windows-1252 character into UTF-8
                # and add it as another, one-byte chunk.
                byte_chunks.append(cls.WINDOWS_1252_TO_UTF8[byte])
                pos += 1
                chunk_start = pos
            else:
                # Go on to the next character.
                pos += 1
        if chunk_start == 0:
            # The string is unchanged.
            return in_bytes
        else:
            # Store the final chunk.
            byte_chunks.append(in_bytes[chunk_start:])
        return b"".join(byte_chunks)

"""Diagnostic functions, mainly for use when doing tech support."""

# Use of this source code is governed by the MIT license.
__license__ = "MIT"

import cProfile
from io import BytesIO
from html.parser import HTMLParser
import bs4
from bs4 import BeautifulSoup, __version__
from bs4.builder import builder_registry
from typing import (
    Any,
    IO,
    List,
    Optional,
    Tuple,
    TYPE_CHECKING,
)

if TYPE_CHECKING:
    from bs4._typing import _IncomingMarkup

import pstats
import random
import tempfile
import time
import traceback
import sys


def diagnose(data: "_IncomingMarkup") -> None:
    """Diagnostic suite for isolating common problems.

    :param data: Some markup that needs to be explained.
    :return: None; diagnostics are printed to standard output.
    """
    print(("Diagnostic running on Beautiful Soup %s" % __version__))
    print(("Python version %s" % sys.version))

    basic_parsers = ["html.parser", "html5lib", "lxml"]
    for name in basic_parsers:
        for builder in builder_registry.builders:
            if name in builder.features:
                break
        else:
            basic_parsers.remove(name)
            print(
                ("I noticed that %s is not installed. Installing it may help." % name)
            )

    if "lxml" in basic_parsers:
        basic_parsers.append("lxml-xml")
        try:
            from lxml import etree # type:ignore

            print(("Found lxml version %s" % ".".join(map(str, etree.LXML_VERSION))))
        except ImportError:
            print("lxml is not installed or couldn't be imported.")

    if "html5lib" in basic_parsers:
        try:
            import html5lib

            print(("Found html5lib version %s" % html5lib.__version__))
        except ImportError:
            print("html5lib is not installed or couldn't be imported.")

    if hasattr(data, "read"):
        data = data.read()

    for parser in basic_parsers:
        print(("Trying to parse your markup with %s" % parser))
        success = False
        try:
            soup = BeautifulSoup(data, features=parser)
            success = True
        except Exception:
            print(("%s could not parse the markup." % parser))
            traceback.print_exc()
        if success:
            print(("Here's what %s did with the markup:" % parser))
            print((soup.prettify()))

        print(("-" * 80))


def lxml_trace(data: "_IncomingMarkup", html: bool = True, **kwargs: Any) -> None:
    """Print out the lxml events that occur during parsing.

    This lets you see how lxml parses a document when no Beautiful
    Soup code is running. You can use this to determine whether
    an lxml-specific problem is in Beautiful Soup's lxml tree builders
    or in lxml itself.

    :param data: Some markup.
    :param html: If True, markup will be parsed with lxml's HTML parser.
       if False, lxml's XML parser will be used.
    """
    from lxml import etree

    recover = kwargs.pop("recover", True)
    if isinstance(data, str):
        data = data.encode("utf8")
    if not isinstance(data, IO):
        reader = BytesIO(data)
    for event, element in etree.iterparse(reader, html=html, recover=recover, **kwargs):
        print(("%s, %4s, %s" % (event, element.tag, element.text)))


class AnnouncingParser(HTMLParser):
    """Subclass of HTMLParser that announces parse events, without doing
    anything else.

    You can use this to get a picture of how html.parser sees a given
    document. The easiest way to do this is to call `htmlparser_trace`.
    """

    def _p(self, s: str) -> None:
        print(s)

    def handle_starttag(
        self,
        name: str,
        attrs: List[Tuple[str, Optional[str]]],
        handle_empty_element: bool = True,
    ) -> None:
        self._p(f"{name} {attrs} START")

    def handle_endtag(self, name: str, check_already_closed: bool = True) -> None:
        self._p("%s END" % name)

    def handle_data(self, data: str) -> None:
        self._p("%s DATA" % data)

    def handle_charref(self, name: str) -> None:
        self._p("%s CHARREF" % name)

    def handle_entityref(self, name: str) -> None:
        self._p("%s ENTITYREF" % name)

    def handle_comment(self, data: str) -> None:
        self._p("%s COMMENT" % data)

    def handle_decl(self, data: str) -> None:
        self._p("%s DECL" % data)

    def unknown_decl(self, data: str) -> None:
        self._p("%s UNKNOWN-DECL" % data)

    def handle_pi(self, data: str) -> None:
        self._p("%s PI" % data)


def htmlparser_trace(data: str) -> None:
    """Print out the HTMLParser events that occur during parsing.

    This lets you see how HTMLParser parses a document when no
    Beautiful Soup code is running.

    :param data: Some markup.
    """
    parser = AnnouncingParser()
    parser.feed(data)


_vowels: str = "aeiou"
_consonants: str = "bcdfghjklmnpqrstvwxyz"


def rword(length: int = 5) -> str:
    """Generate a random word-like string.

    :meta private:
    """
    s = ""
    for i in range(length):
        if i % 2 == 0:
            t = _consonants
        else:
            t = _vowels
        s += random.choice(t)
    return s


def rsentence(length: int = 4) -> str:
    """Generate a random sentence-like string.

    :meta private:
    """
    return " ".join(rword(random.randint(4, 9)) for i in range(length))


def rdoc(num_elements: int = 1000) -> str:
    """Randomly generate an invalid HTML document.

    :meta private:
    """
    tag_names = ["p", "div", "span", "i", "b", "script", "table"]
    elements = []
    for i in range(num_elements):
        choice = random.randint(0, 3)
        if choice == 0:
            # New tag.
            tag_name = random.choice(tag_names)
            elements.append("<%s>" % tag_name)
        elif choice == 1:
            elements.append(rsentence(random.randint(1, 4)))
        elif choice == 2:
            # Close a tag.
            tag_name = random.choice(tag_names)
            elements.append("</%s>" % tag_name)
    return "<html>" + "\n".join(elements) + "</html>"


def benchmark_parsers(num_elements: int = 100000) -> None:
    """Very basic head-to-head performance benchmark."""
    print(("Comparative parser benchmark on Beautiful Soup %s" % __version__))
    data = rdoc(num_elements)
    print(("Generated a large invalid HTML document (%d bytes)." % len(data)))

    for parser_name in ["lxml", ["lxml", "html"], "html5lib", "html.parser"]:
        success = False
        try:
            a = time.time()
            BeautifulSoup(data, parser_name)
            b = time.time()
            success = True
        except Exception:
            print(("%s could not parse the markup." % parser_name))
            traceback.print_exc()
        if success:
            print(("BS4+%s parsed the markup in %.2fs." % (parser_name, b - a)))

    from lxml import etree

    a = time.time()
    etree.HTML(data)
    b = time.time()
    print(("Raw lxml parsed the markup in %.2fs." % (b - a)))

    import html5lib

    parser = html5lib.HTMLParser()
    a = time.time()
    parser.parse(data)
    b = time.time()
    print(("Raw html5lib parsed the markup in %.2fs." % (b - a)))


def profile(num_elements: int = 100000, parser: str = "lxml") -> None:
    """Use Python's profiler on a randomly generated document."""
    filehandle = tempfile.NamedTemporaryFile()
    filename = filehandle.name

    data = rdoc(num_elements)
    vars = dict(bs4=bs4, data=data, parser=parser)
    cProfile.runctx("bs4.BeautifulSoup(data, parser)", vars, vars, filename)

    stats = pstats.Stats(filename)
    # stats.strip_dirs()
    stats.sort_stats("cumulative")
    stats.print_stats("_html5lib|bs4", 50)


# If this file is run as a script, standard input is diagnosed.
if __name__ == "__main__":
    diagnose(sys.stdin.read())

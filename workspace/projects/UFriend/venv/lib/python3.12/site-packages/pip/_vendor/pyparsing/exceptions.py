# exceptions.py

import re
import sys
import typing

from .util import (
    col,
    line,
    lineno,
    _collapse_string_to_ranges,
    replaced_by_pep8,
)
from .unicode import pyparsing_unicode as ppu


class ExceptionWordUnicode(ppu.Latin1, ppu.LatinA, ppu.LatinB, ppu.Greek, ppu.Cyrillic):
    pass


_extract_alphanums = _collapse_string_to_ranges(ExceptionWordUnicode.alphanums)
_exception_word_extractor = re.compile("([" + _extract_alphanums + "]{1,16})|.")


class ParseBaseException(Exception):
    """base exception class for all parsing runtime exceptions"""

    loc: int
    msg: str
    pstr: str
    parser_element: typing.Any  # "ParserElement"
    args: typing.Tuple[str, int, typing.Optional[str]]

    __slots__ = (
        "loc",
        "msg",
        "pstr",
        "parser_element",
        "args",
    )

    # Performance tuning: we construct a *lot* of these, so keep this
    # constructor as small and fast as possible
    def __init__(
        self,
        pstr: str,
        loc: int = 0,
        msg: typing.Optional[str] = None,
        elem=None,
    ):
        self.loc = loc
        if msg is None:
            self.msg = pstr
            self.pstr = ""
        else:
            self.msg = msg
            self.pstr = pstr
        self.parser_element = elem
        self.args = (pstr, loc, msg)

    @staticmethod
    def explain_exception(exc, depth=16):
        """
        Method to take an exception and translate the Python internal traceback into a list
        of the pyparsing expressions that caused the exception to be raised.

        Parameters:

        - exc - exception raised during parsing (need not be a ParseException, in support
          of Python exceptions that might be raised in a parse action)
        - depth (default=16) - number of levels back in the stack trace to list expression
          and function names; if None, the full stack trace names will be listed; if 0, only
          the failing input line, marker, and exception string will be shown

        Returns a multi-line string listing the ParserElements and/or function names in the
        exception's stack trace.
        """
        import inspect
        from .core import ParserElement

        if depth is None:
            depth = sys.getrecursionlimit()
        ret = []
        if isinstance(exc, ParseBaseException):
            ret.append(exc.line)
            ret.append(" " * (exc.column - 1) + "^")
        ret.append(f"{type(exc).__name__}: {exc}")

        if depth > 0:
            callers = inspect.getinnerframes(exc.__traceback__, context=depth)
            seen = set()
            for i, ff in enumerate(callers[-depth:]):
                frm = ff[0]

                f_self = frm.f_locals.get("self", None)
                if isinstance(f_self, ParserElement):
                    if not frm.f_code.co_name.startswith(
                        ("parseImpl", "_parseNoCache")
                    ):
                        continue
                    if id(f_self) in seen:
                        continue
                    seen.add(id(f_self))

                    self_type = type(f_self)
                    ret.append(
                        f"{self_type.__module__}.{self_type.__name__} - {f_self}"
                    )

                elif f_self is not None:
                    self_type = type(f_self)
                    ret.append(f"{self_type.__module__}.{self_type.__name__}")

                else:
                    code = frm.f_code
                    if code.co_name in ("wrapper", "<module>"):
                        continue

                    ret.append(code.co_name)

                depth -= 1
                if not depth:
                    break

        return "\n".join(ret)

    @classmethod
    def _from_exception(cls, pe):
        """
        internal factory method to simplify creating one type of ParseException
        from another - avoids having __init__ signature conflicts among subclasses
        """
        return cls(pe.pstr, pe.loc, pe.msg, pe.parser_element)

    @property
    def line(self) -> str:
        """
        Return the line of text where the exception occurred.
        """
        return line(self.loc, self.pstr)

    @property
    def lineno(self) -> int:
        """
        Return the 1-based line number of text where the exception occurred.
        """
        return lineno(self.loc, self.pstr)

    @property
    def col(self) -> int:
        """
        Return the 1-based column on the line of text where the exception occurred.
        """
        return col(self.loc, self.pstr)

    @property
    def column(self) -> int:
        """
        Return the 1-based column on the line of text where the exception occurred.
        """
        return col(self.loc, self.pstr)

    # pre-PEP8 compatibility
    @property
    def parserElement(self):
        return self.parser_element

    @parserElement.setter
    def parserElement(self, elem):
        self.parser_element = elem

    def __str__(self) -> str:
        if self.pstr:
            if self.loc >= len(self.pstr):
                foundstr = ", found end of text"
            else:
                # pull out next word at error location
                found_match = _exception_word_extractor.match(self.pstr, self.loc)
                if found_match is not None:
                    found = found_match.group(0)
                else:
                    found = self.pstr[self.loc : self.loc + 1]
                foundstr = (", found %r" % found).replace(r"\\", "\\")
        else:
            foundstr = ""
        return f"{self.msg}{foundstr}  (at char {self.loc}), (line:{self.lineno}, col:{self.column})"

    def __repr__(self):
        return str(self)

    def mark_input_line(
        self, marker_string: typing.Optional[str] = None, *, markerString: str = ">!<"
    ) -> str:
        """
        Extracts the exception line from the input string, and marks
        the location of the exception with a special symbol.
        """
        markerString = marker_string if marker_string is not None else markerString
        line_str = self.line
        line_column = self.column - 1
        if markerString:
            line_str = "".join(
                (line_str[:line_column], markerString, line_str[line_column:])
            )
        return line_str.strip()

    def explain(self, depth=16) -> str:
        """
        Method to translate the Python internal traceback into a list
        of the pyparsing expressions that caused the exception to be raised.

        Parameters:

        - depth (default=16) - number of levels back in the stack trace to list expression
          and function names; if None, the full stack trace names will be listed; if 0, only
          the failing input line, marker, and exception string will be shown

        Returns a multi-line string listing the ParserElements and/or function names in the
        exception's stack trace.

        Example::

            expr = pp.Word(pp.nums) * 3
            try:
                expr.parse_string("123 456 A789")
            except pp.ParseException as pe:
                print(pe.explain(depth=0))

        prints::

            123 456 A789
                    ^
            ParseException: Expected W:(0-9), found 'A'  (at char 8), (line:1, col:9)

        Note: the diagnostic output will include string representations of the expressions
        that failed to parse. These representations will be more helpful if you use `set_name` to
        give identifiable names to your expressions. Otherwise they will use the default string
        forms, which may be cryptic to read.

        Note: pyparsing's default truncation of exception tracebacks may also truncate the
        stack of expressions that are displayed in the ``explain`` output. To get the full listing
        of parser expressions, you may have to set ``ParserElement.verbose_stacktrace = True``
        """
        return self.explain_exception(self, depth)

    # fmt: off
    @replaced_by_pep8(mark_input_line)
    def markInputline(self): ...
    # fmt: on


class ParseException(ParseBaseException):
    """
    Exception thrown when a parse expression doesn't match the input string

    Example::

        try:
            Word(nums).set_name("integer").parse_string("ABC")
        except ParseException as pe:
            print(pe)
            print("column: {}".format(pe.column))

    prints::

       Expected integer (at char 0), (line:1, col:1)
        column: 1

    """


class ParseFatalException(ParseBaseException):
    """
    User-throwable exception thrown when inconsistent parse content
    is found; stops all parsing immediately
    """


class ParseSyntaxException(ParseFatalException):
    """
    Just like :class:`ParseFatalException`, but thrown internally
    when an :class:`ErrorStop<And._ErrorStop>` ('-' operator) indicates
    that parsing is to stop immediately because an unbacktrackable
    syntax error has been found.
    """


class RecursiveGrammarException(Exception):
    """
    Exception thrown by :class:`ParserElement.validate` if the
    grammar could be left-recursive; parser may need to enable
    left recursion using :class:`ParserElement.enable_left_recursion<ParserElement.enable_left_recursion>`
    """

    def __init__(self, parseElementList):
        self.parseElementTrace = parseElementList

    def __str__(self) -> str:
        return f"RecursiveGrammarException: {self.parseElementTrace}"

#
# core.py
#

from collections import deque
import os
import typing
from typing import (
    Any,
    Callable,
    Generator,
    List,
    NamedTuple,
    Sequence,
    Set,
    TextIO,
    Tuple,
    Union,
    cast,
)
from abc import ABC, abstractmethod
from enum import Enum
import string
import copy
import warnings
import re
import sys
from collections.abc import Iterable
import traceback
import types
from operator import itemgetter
from functools import wraps
from threading import RLock
from pathlib import Path

from .util import (
    _FifoCache,
    _UnboundedCache,
    __config_flags,
    _collapse_string_to_ranges,
    _escape_regex_range_chars,
    _bslash,
    _flatten,
    LRUMemo as _LRUMemo,
    UnboundedMemo as _UnboundedMemo,
    replaced_by_pep8,
)
from .exceptions import *
from .actions import *
from .results import ParseResults, _ParseResultsWithOffset
from .unicode import pyparsing_unicode

_MAX_INT = sys.maxsize
str_type: Tuple[type, ...] = (str, bytes)

#
# Copyright (c) 2003-2022  Paul T. McGuire
#
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
# MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
# IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
# CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
# TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
# SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#


if sys.version_info >= (3, 8):
    from functools import cached_property
else:

    class cached_property:
        def __init__(self, func):
            self._func = func

        def __get__(self, instance, owner=None):
            ret = instance.__dict__[self._func.__name__] = self._func(instance)
            return ret


class __compat__(__config_flags):
    """
    A cross-version compatibility configuration for pyparsing features that will be
    released in a future version. By setting values in this configuration to True,
    those features can be enabled in prior versions for compatibility development
    and testing.

    - ``collect_all_And_tokens`` - flag to enable fix for Issue #63 that fixes erroneous grouping
      of results names when an :class:`And` expression is nested within an :class:`Or` or :class:`MatchFirst`;
      maintained for compatibility, but setting to ``False`` no longer restores pre-2.3.1
      behavior
    """

    _type_desc = "compatibility"

    collect_all_And_tokens = True

    _all_names = [__ for __ in locals() if not __.startswith("_")]
    _fixed_names = """
        collect_all_And_tokens
        """.split()


class __diag__(__config_flags):
    _type_desc = "diagnostic"

    warn_multiple_tokens_in_named_alternation = False
    warn_ungrouped_named_tokens_in_collection = False
    warn_name_set_on_empty_Forward = False
    warn_on_parse_using_empty_Forward = False
    warn_on_assignment_to_Forward = False
    warn_on_multiple_string_args_to_oneof = False
    warn_on_match_first_with_lshift_operator = False
    enable_debug_on_named_expressions = False

    _all_names = [__ for __ in locals() if not __.startswith("_")]
    _warning_names = [name for name in _all_names if name.startswith("warn")]
    _debug_names = [name for name in _all_names if name.startswith("enable_debug")]

    @classmethod
    def enable_all_warnings(cls) -> None:
        for name in cls._warning_names:
            cls.enable(name)


class Diagnostics(Enum):
    """
    Diagnostic configuration (all default to disabled)

    - ``warn_multiple_tokens_in_named_alternation`` - flag to enable warnings when a results
      name is defined on a :class:`MatchFirst` or :class:`Or` expression with one or more :class:`And` subexpressions
    - ``warn_ungrouped_named_tokens_in_collection`` - flag to enable warnings when a results
      name is defined on a containing expression with ungrouped subexpressions that also
      have results names
    - ``warn_name_set_on_empty_Forward`` - flag to enable warnings when a :class:`Forward` is defined
      with a results name, but has no contents defined
    - ``warn_on_parse_using_empty_Forward`` - flag to enable warnings when a :class:`Forward` is
      defined in a grammar but has never had an expression attached to it
    - ``warn_on_assignment_to_Forward`` - flag to enable warnings when a :class:`Forward` is defined
      but is overwritten by assigning using ``'='`` instead of ``'<<='`` or ``'<<'``
    - ``warn_on_multiple_string_args_to_oneof`` - flag to enable warnings when :class:`one_of` is
      incorrectly called with multiple str arguments
    - ``enable_debug_on_named_expressions`` - flag to auto-enable debug on all subsequent
      calls to :class:`ParserElement.set_name`

    Diagnostics are enabled/disabled by calling :class:`enable_diag` and :class:`disable_diag`.
    All warnings can be enabled by calling :class:`enable_all_warnings`.
    """

    warn_multiple_tokens_in_named_alternation = 0
    warn_ungrouped_named_tokens_in_collection = 1
    warn_name_set_on_empty_Forward = 2
    warn_on_parse_using_empty_Forward = 3
    warn_on_assignment_to_Forward = 4
    warn_on_multiple_string_args_to_oneof = 5
    warn_on_match_first_with_lshift_operator = 6
    enable_debug_on_named_expressions = 7


def enable_diag(diag_enum: Diagnostics) -> None:
    """
    Enable a global pyparsing diagnostic flag (see :class:`Diagnostics`).
    """
    __diag__.enable(diag_enum.name)


def disable_diag(diag_enum: Diagnostics) -> None:
    """
    Disable a global pyparsing diagnostic flag (see :class:`Diagnostics`).
    """
    __diag__.disable(diag_enum.name)


def enable_all_warnings() -> None:
    """
    Enable all global pyparsing diagnostic warnings (see :class:`Diagnostics`).
    """
    __diag__.enable_all_warnings()


# hide abstract class
del __config_flags


def _should_enable_warnings(
    cmd_line_warn_options: typing.Iterable[str], warn_env_var: typing.Optional[str]
) -> bool:
    enable = bool(warn_env_var)
    for warn_opt in cmd_line_warn_options:
        w_action, w_message, w_category, w_module, w_line = (warn_opt + "::::").split(
            ":"
        )[:5]
        if not w_action.lower().startswith("i") and (
            not (w_message or w_category or w_module) or w_module == "pyparsing"
        ):
            enable = True
        elif w_action.lower().startswith("i") and w_module in ("pyparsing", ""):
            enable = False
    return enable


if _should_enable_warnings(
    sys.warnoptions, os.environ.get("PYPARSINGENABLEALLWARNINGS")
):
    enable_all_warnings()


# build list of single arg builtins, that can be used as parse actions
_single_arg_builtins = {
    sum,
    len,
    sorted,
    reversed,
    list,
    tuple,
    set,
    any,
    all,
    min,
    max,
}

_generatorType = types.GeneratorType
ParseImplReturnType = Tuple[int, Any]
PostParseReturnType = Union[ParseResults, Sequence[ParseResults]]
ParseAction = Union[
    Callable[[], Any],
    Callable[[ParseResults], Any],
    Callable[[int, ParseResults], Any],
    Callable[[str, int, ParseResults], Any],
]
ParseCondition = Union[
    Callable[[], bool],
    Callable[[ParseResults], bool],
    Callable[[int, ParseResults], bool],
    Callable[[str, int, ParseResults], bool],
]
ParseFailAction = Callable[[str, int, "ParserElement", Exception], None]
DebugStartAction = Callable[[str, int, "ParserElement", bool], None]
DebugSuccessAction = Callable[
    [str, int, int, "ParserElement", ParseResults, bool], None
]
DebugExceptionAction = Callable[[str, int, "ParserElement", Exception, bool], None]


alphas = string.ascii_uppercase + string.ascii_lowercase
identchars = pyparsing_unicode.Latin1.identchars
identbodychars = pyparsing_unicode.Latin1.identbodychars
nums = "0123456789"
hexnums = nums + "ABCDEFabcdef"
alphanums = alphas + nums
printables = "".join([c for c in string.printable if c not in string.whitespace])

_trim_arity_call_line: traceback.StackSummary = None  # type: ignore[assignment]


def _trim_arity(func, max_limit=3):
    """decorator to trim function calls to match the arity of the target"""
    global _trim_arity_call_line

    if func in _single_arg_builtins:
        return lambda s, l, t: func(t)

    limit = 0
    found_arity = False

    # synthesize what would be returned by traceback.extract_stack at the call to
    # user's parse action 'func', so that we don't incur call penalty at parse time

    # fmt: off
    LINE_DIFF = 7
    # IF ANY CODE CHANGES, EVEN JUST COMMENTS OR BLANK LINES, BETWEEN THE NEXT LINE AND
    # THE CALL TO FUNC INSIDE WRAPPER, LINE_DIFF MUST BE MODIFIED!!!!
    _trim_arity_call_line = (_trim_arity_call_line or traceback.extract_stack(limit=2)[-1])
    pa_call_line_synth = (_trim_arity_call_line[0], _trim_arity_call_line[1] + LINE_DIFF)

    def wrapper(*args):
        nonlocal found_arity, limit
        while 1:
            try:
                ret = func(*args[limit:])
                found_arity = True
                return ret
            except TypeError as te:
                # re-raise TypeErrors if they did not come from our arity testing
                if found_arity:
                    raise
                else:
                    tb = te.__traceback__
                    frames = traceback.extract_tb(tb, limit=2)
                    frame_summary = frames[-1]
                    trim_arity_type_error = (
                        [frame_summary[:2]][-1][:2] == pa_call_line_synth
                    )
                    del tb

                    if trim_arity_type_error:
                        if limit < max_limit:
                            limit += 1
                            continue

                    raise
    # fmt: on

    # copy func name to wrapper for sensible debug output
    # (can't use functools.wraps, since that messes with function signature)
    func_name = getattr(func, "__name__", getattr(func, "__class__").__name__)
    wrapper.__name__ = func_name
    wrapper.__doc__ = func.__doc__

    return wrapper


def condition_as_parse_action(
    fn: ParseCondition, message: typing.Optional[str] = None, fatal: bool = False
) -> ParseAction:
    """
    Function to convert a simple predicate function that returns ``True`` or ``False``
    into a parse action. Can be used in places when a parse action is required
    and :class:`ParserElement.add_condition` cannot be used (such as when adding a condition
    to an operator level in :class:`infix_notation`).

    Optional keyword arguments:

    - ``message`` - define a custom message to be used in the raised exception
    - ``fatal`` - if True, will raise :class:`ParseFatalException` to stop parsing immediately;
      otherwise will raise :class:`ParseException`

    """
    msg = message if message is not None else "failed user-defined condition"
    exc_type = ParseFatalException if fatal else ParseException
    fn = _trim_arity(fn)

    @wraps(fn)
    def pa(s, l, t):
        if not bool(fn(s, l, t)):
            raise exc_type(s, l, msg)

    return pa


def _default_start_debug_action(
    instring: str, loc: int, expr: "ParserElement", cache_hit: bool = False
):
    cache_hit_str = "*" if cache_hit else ""
    print(
        (
            f"{cache_hit_str}Match {expr} at loc {loc}({lineno(loc, instring)},{col(loc, instring)})\n"
            f"  {line(loc, instring)}\n"
            f"  {' ' * (col(loc, instring) - 1)}^"
        )
    )


def _default_success_debug_action(
    instring: str,
    startloc: int,
    endloc: int,
    expr: "ParserElement",
    toks: ParseResults,
    cache_hit: bool = False,
):
    cache_hit_str = "*" if cache_hit else ""
    print(f"{cache_hit_str}Matched {expr} -> {toks.as_list()}")


def _default_exception_debug_action(
    instring: str,
    loc: int,
    expr: "ParserElement",
    exc: Exception,
    cache_hit: bool = False,
):
    cache_hit_str = "*" if cache_hit else ""
    print(f"{cache_hit_str}Match {expr} failed, {type(exc).__name__} raised: {exc}")


def null_debug_action(*args):
    """'Do-nothing' debug action, to suppress debugging output during parsing."""


class ParserElement(ABC):
    """Abstract base level parser element class."""

    DEFAULT_WHITE_CHARS: str = " \n\t\r"
    verbose_stacktrace: bool = False
    _literalStringClass: type = None  # type: ignore[assignment]

    @staticmethod
    def set_default_whitespace_chars(chars: str) -> None:
        r"""
        Overrides the default whitespace chars

        Example::

            # default whitespace chars are space, <TAB> and newline
            Word(alphas)[1, ...].parse_string("abc def\nghi jkl")  # -> ['abc', 'def', 'ghi', 'jkl']

            # change to just treat newline as significant
            ParserElement.set_default_whitespace_chars(" \t")
            Word(alphas)[1, ...].parse_string("abc def\nghi jkl")  # -> ['abc', 'def']
        """
        ParserElement.DEFAULT_WHITE_CHARS = chars

        # update whitespace all parse expressions defined in this module
        for expr in _builtin_exprs:
            if expr.copyDefaultWhiteChars:
                expr.whiteChars = set(chars)

    @staticmethod
    def inline_literals_using(cls: type) -> None:
        """
        Set class to be used for inclusion of string literals into a parser.

        Example::

            # default literal class used is Literal
            integer = Word(nums)
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")

            date_str.parse_string("1999/12/31")  # -> ['1999', '/', '12', '/', '31']


            # change to Suppress
            ParserElement.inline_literals_using(Suppress)
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")

            date_str.parse_string("1999/12/31")  # -> ['1999', '12', '31']
        """
        ParserElement._literalStringClass = cls

    @classmethod
    def using_each(cls, seq, **class_kwargs):
        """
        Yields a sequence of class(obj, **class_kwargs) for obj in seq.

        Example::

            LPAR, RPAR, LBRACE, RBRACE, SEMI = Suppress.using_each("(){};")

        """
        yield from (cls(obj, **class_kwargs) for obj in seq)

    class DebugActions(NamedTuple):
        debug_try: typing.Optional[DebugStartAction]
        debug_match: typing.Optional[DebugSuccessAction]
        debug_fail: typing.Optional[DebugExceptionAction]

    def __init__(self, savelist: bool = False):
        self.parseAction: List[ParseAction] = list()
        self.failAction: typing.Optional[ParseFailAction] = None
        self.customName: str = None  # type: ignore[assignment]
        self._defaultName: typing.Optional[str] = None
        self.resultsName: str = None  # type: ignore[assignment]
        self.saveAsList = savelist
        self.skipWhitespace = True
        self.whiteChars = set(ParserElement.DEFAULT_WHITE_CHARS)
        self.copyDefaultWhiteChars = True
        # used when checking for left-recursion
        self.mayReturnEmpty = False
        self.keepTabs = False
        self.ignoreExprs: List["ParserElement"] = list()
        self.debug = False
        self.streamlined = False
        # optimize exception handling for subclasses that don't advance parse index
        self.mayIndexError = True
        self.errmsg = ""
        # mark results names as modal (report only last) or cumulative (list all)
        self.modalResults = True
        # custom debug actions
        self.debugActions = self.DebugActions(None, None, None)
        # avoid redundant calls to preParse
        self.callPreparse = True
        self.callDuringTry = False
        self.suppress_warnings_: List[Diagnostics] = []

    def suppress_warning(self, warning_type: Diagnostics) -> "ParserElement":
        """
        Suppress warnings emitted for a particular diagnostic on this expression.

        Example::

            base = pp.Forward()
            base.suppress_warning(Diagnostics.warn_on_parse_using_empty_Forward)

            # statement would normally raise a warning, but is now suppressed
            print(base.parse_string("x"))

        """
        self.suppress_warnings_.append(warning_type)
        return self

    def visit_all(self):
        """General-purpose method to yield all expressions and sub-expressions
        in a grammar. Typically just for internal use.
        """
        to_visit = deque([self])
        seen = set()
        while to_visit:
            cur = to_visit.popleft()

            # guard against looping forever through recursive grammars
            if cur in seen:
                continue
            seen.add(cur)

            to_visit.extend(cur.recurse())
            yield cur

    def copy(self) -> "ParserElement":
        """
        Make a copy of this :class:`ParserElement`.  Useful for defining
        different parse actions for the same parsing pattern, using copies of
        the original parse element.

        Example::

            integer = Word(nums).set_parse_action(lambda toks: int(toks[0]))
            integerK = integer.copy().add_parse_action(lambda toks: toks[0] * 1024) + Suppress("K")
            integerM = integer.copy().add_parse_action(lambda toks: toks[0] * 1024 * 1024) + Suppress("M")

            print((integerK | integerM | integer)[1, ...].parse_string("5K 100 640K 256M"))

        prints::

            [5120, 100, 655360, 268435456]

        Equivalent form of ``expr.copy()`` is just ``expr()``::

            integerM = integer().add_parse_action(lambda toks: toks[0] * 1024 * 1024) + Suppress("M")
        """
        cpy = copy.copy(self)
        cpy.parseAction = self.parseAction[:]
        cpy.ignoreExprs = self.ignoreExprs[:]
        if self.copyDefaultWhiteChars:
            cpy.whiteChars = set(ParserElement.DEFAULT_WHITE_CHARS)
        return cpy

    def set_results_name(
        self, name: str, list_all_matches: bool = False, *, listAllMatches: bool = False
    ) -> "ParserElement":
        """
        Define name for referencing matching tokens as a nested attribute
        of the returned parse results.

        Normally, results names are assigned as you would assign keys in a dict:
        any existing value is overwritten by later values. If it is necessary to
        keep all values captured for a particular results name, call ``set_results_name``
        with ``list_all_matches`` = True.

        NOTE: ``set_results_name`` returns a *copy* of the original :class:`ParserElement` object;
        this is so that the client can define a basic element, such as an
        integer, and reference it in multiple places with different names.

        You can also set results names using the abbreviated syntax,
        ``expr("name")`` in place of ``expr.set_results_name("name")``
        - see :class:`__call__`. If ``list_all_matches`` is required, use
        ``expr("name*")``.

        Example::

            date_str = (integer.set_results_name("year") + '/'
                        + integer.set_results_name("month") + '/'
                        + integer.set_results_name("day"))

            # equivalent form:
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")
        """
        listAllMatches = listAllMatches or list_all_matches
        return self._setResultsName(name, listAllMatches)

    def _setResultsName(self, name, listAllMatches=False):
        if name is None:
            return self
        newself = self.copy()
        if name.endswith("*"):
            name = name[:-1]
            listAllMatches = True
        newself.resultsName = name
        newself.modalResults = not listAllMatches
        return newself

    def set_break(self, break_flag: bool = True) -> "ParserElement":
        """
        Method to invoke the Python pdb debugger when this element is
        about to be parsed. Set ``break_flag`` to ``True`` to enable, ``False`` to
        disable.
        """
        if break_flag:
            _parseMethod = self._parse

            def breaker(instring, loc, doActions=True, callPreParse=True):
                import pdb

                # this call to pdb.set_trace() is intentional, not a checkin error
                pdb.set_trace()
                return _parseMethod(instring, loc, doActions, callPreParse)

            breaker._originalParseMethod = _parseMethod  # type: ignore [attr-defined]
            self._parse = breaker  # type: ignore [assignment]
        else:
            if hasattr(self._parse, "_originalParseMethod"):
                self._parse = self._parse._originalParseMethod  # type: ignore [attr-defined, assignment]
        return self

    def set_parse_action(self, *fns: ParseAction, **kwargs) -> "ParserElement":
        """
        Define one or more actions to perform when successfully matching parse element definition.

        Parse actions can be called to perform data conversions, do extra validation,
        update external data structures, or enhance or replace the parsed tokens.
        Each parse action ``fn`` is a callable method with 0-3 arguments, called as
        ``fn(s, loc, toks)`` , ``fn(loc, toks)`` , ``fn(toks)`` , or just ``fn()`` , where:

        - ``s``    = the original string being parsed (see note below)
        - ``loc``  = the location of the matching substring
        - ``toks`` = a list of the matched tokens, packaged as a :class:`ParseResults` object

        The parsed tokens are passed to the parse action as ParseResults. They can be
        modified in place using list-style append, extend, and pop operations to update
        the parsed list elements; and with dictionary-style item set and del operations
        to add, update, or remove any named results. If the tokens are modified in place,
        it is not necessary to return them with a return statement.

        Parse actions can also completely replace the given tokens, with another ``ParseResults``
        object, or with some entirely different object (common for parse actions that perform data
        conversions). A convenient way to build a new parse result is to define the values
        using a dict, and then create the return value using :class:`ParseResults.from_dict`.

        If None is passed as the ``fn`` parse action, all previously added parse actions for this
        expression are cleared.

        Optional keyword arguments:

        - ``call_during_try`` = (default= ``False``) indicate if parse action should be run during
          lookaheads and alternate testing. For parse actions that have side effects, it is
          important to only call the parse action once it is determined that it is being
          called as part of a successful parse. For parse actions that perform additional
          validation, then call_during_try should be passed as True, so that the validation
          code is included in the preliminary "try" parses.

        Note: the default parsing behavior is to expand tabs in the input string
        before starting the parsing process.  See :class:`parse_string` for more
        information on parsing strings containing ``<TAB>`` s, and suggested
        methods to maintain a consistent view of the parsed string, the parse
        location, and line and column positions within the parsed string.

        Example::

            # parse dates in the form YYYY/MM/DD

            # use parse action to convert toks from str to int at parse time
            def convert_to_int(toks):
                return int(toks[0])

            # use a parse action to verify that the date is a valid date
            def is_valid_date(instring, loc, toks):
                from datetime import date
                year, month, day = toks[::2]
                try:
                    date(year, month, day)
                except ValueError:
                    raise ParseException(instring, loc, "invalid date given")

            integer = Word(nums)
            date_str = integer + '/' + integer + '/' + integer

            # add parse actions
            integer.set_parse_action(convert_to_int)
            date_str.set_parse_action(is_valid_date)

            # note that integer fields are now ints, not strings
            date_str.run_tests('''
                # successful parse - note that integer fields were converted to ints
                1999/12/31

                # fail - invalid date
                1999/13/31
                ''')
        """
        if list(fns) == [None]:
            self.parseAction = []
        else:
            if not all(callable(fn) for fn in fns):
                raise TypeError("parse actions must be callable")
            self.parseAction = [_trim_arity(fn) for fn in fns]
            self.callDuringTry = kwargs.get(
                "call_during_try", kwargs.get("callDuringTry", False)
            )
        return self

    def add_parse_action(self, *fns: ParseAction, **kwargs) -> "ParserElement":
        """
        Add one or more parse actions to expression's list of parse actions. See :class:`set_parse_action`.

        See examples in :class:`copy`.
        """
        self.parseAction += [_trim_arity(fn) for fn in fns]
        self.callDuringTry = self.callDuringTry or kwargs.get(
            "call_during_try", kwargs.get("callDuringTry", False)
        )
        return self

    def add_condition(self, *fns: ParseCondition, **kwargs) -> "ParserElement":
        """Add a boolean predicate function to expression's list of parse actions. See
        :class:`set_parse_action` for function call signatures. Unlike ``set_parse_action``,
        functions passed to ``add_condition`` need to return boolean success/fail of the condition.

        Optional keyword arguments:

        - ``message`` = define a custom message to be used in the raised exception
        - ``fatal`` = if True, will raise ParseFatalException to stop parsing immediately; otherwise will raise
          ParseException
        - ``call_during_try`` = boolean to indicate if this method should be called during internal tryParse calls,
          default=False

        Example::

            integer = Word(nums).set_parse_action(lambda toks: int(toks[0]))
            year_int = integer.copy()
            year_int.add_condition(lambda toks: toks[0] >= 2000, message="Only support years 2000 and later")
            date_str = year_int + '/' + integer + '/' + integer

            result = date_str.parse_string("1999/12/31")  # -> Exception: Only support years 2000 and later (at char 0),
                                                                         (line:1, col:1)
        """
        for fn in fns:
            self.parseAction.append(
                condition_as_parse_action(
                    fn,
                    message=str(kwargs.get("message")),
                    fatal=bool(kwargs.get("fatal", False)),
                )
            )

        self.callDuringTry = self.callDuringTry or kwargs.get(
            "call_during_try", kwargs.get("callDuringTry", False)
        )
        return self

    def set_fail_action(self, fn: ParseFailAction) -> "ParserElement":
        """
        Define action to perform if parsing fails at this expression.
        Fail acton fn is a callable function that takes the arguments
        ``fn(s, loc, expr, err)`` where:

        - ``s`` = string being parsed
        - ``loc`` = location where expression match was attempted and failed
        - ``expr`` = the parse expression that failed
        - ``err`` = the exception thrown

        The function returns no value.  It may throw :class:`ParseFatalException`
        if it is desired to stop parsing immediately."""
        self.failAction = fn
        return self

    def _skipIgnorables(self, instring: str, loc: int) -> int:
        if not self.ignoreExprs:
            return loc
        exprsFound = True
        ignore_expr_fns = [e._parse for e in self.ignoreExprs]
        while exprsFound:
            exprsFound = False
            for ignore_fn in ignore_expr_fns:
                try:
                    while 1:
                        loc, dummy = ignore_fn(instring, loc)
                        exprsFound = True
                except ParseException:
                    pass
        return loc

    def preParse(self, instring: str, loc: int) -> int:
        if self.ignoreExprs:
            loc = self._skipIgnorables(instring, loc)

        if self.skipWhitespace:
            instrlen = len(instring)
            white_chars = self.whiteChars
            while loc < instrlen and instring[loc] in white_chars:
                loc += 1

        return loc

    def parseImpl(self, instring, loc, doActions=True):
        return loc, []

    def postParse(self, instring, loc, tokenlist):
        return tokenlist

    # @profile
    def _parseNoCache(
        self, instring, loc, doActions=True, callPreParse=True
    ) -> Tuple[int, ParseResults]:
        TRY, MATCH, FAIL = 0, 1, 2
        debugging = self.debug  # and doActions)
        len_instring = len(instring)

        if debugging or self.failAction:
            # print("Match {} at loc {}({}, {})".format(self, loc, lineno(loc, instring), col(loc, instring)))
            try:
                if callPreParse and self.callPreparse:
                    pre_loc = self.preParse(instring, loc)
                else:
                    pre_loc = loc
                tokens_start = pre_loc
                if self.debugActions.debug_try:
                    self.debugActions.debug_try(instring, tokens_start, self, False)
                if self.mayIndexError or pre_loc >= len_instring:
                    try:
                        loc, tokens = self.parseImpl(instring, pre_loc, doActions)
                    except IndexError:
                        raise ParseException(instring, len_instring, self.errmsg, self)
                else:
                    loc, tokens = self.parseImpl(instring, pre_loc, doActions)
            except Exception as err:
                # print("Exception raised:", err)
                if self.debugActions.debug_fail:
                    self.debugActions.debug_fail(
                        instring, tokens_start, self, err, False
                    )
                if self.failAction:
                    self.failAction(instring, tokens_start, self, err)
                raise
        else:
            if callPreParse and self.callPreparse:
                pre_loc = self.preParse(instring, loc)
            else:
                pre_loc = loc
            tokens_start = pre_loc
            if self.mayIndexError or pre_loc >= len_instring:
                try:
                    loc, tokens = self.parseImpl(instring, pre_loc, doActions)
                except IndexError:
                    raise ParseException(instring, len_instring, self.errmsg, self)
            else:
                loc, tokens = self.parseImpl(instring, pre_loc, doActions)

        tokens = self.postParse(instring, loc, tokens)

        ret_tokens = ParseResults(
            tokens, self.resultsName, asList=self.saveAsList, modal=self.modalResults
        )
        if self.parseAction and (doActions or self.callDuringTry):
            if debugging:
                try:
                    for fn in self.parseAction:
                        try:
                            tokens = fn(instring, tokens_start, ret_tokens)  # type: ignore [call-arg, arg-type]
                        except IndexError as parse_action_exc:
                            exc = ParseException("exception raised in parse action")
                            raise exc from parse_action_exc

                        if tokens is not None and tokens is not ret_tokens:
                            ret_tokens = ParseResults(
                                tokens,
                                self.resultsName,
                                asList=self.saveAsList
                                and isinstance(tokens, (ParseResults, list)),
                                modal=self.modalResults,
                            )
                except Exception as err:
                    # print "Exception raised in user parse action:", err
                    if self.debugActions.debug_fail:
                        self.debugActions.debug_fail(
                            instring, tokens_start, self, err, False
                        )
                    raise
            else:
                for fn in self.parseAction:
                    try:
                        tokens = fn(instring, tokens_start, ret_tokens)  # type: ignore [call-arg, arg-type]
                    except IndexError as parse_action_exc:
                        exc = ParseException("exception raised in parse action")
                        raise exc from parse_action_exc

                    if tokens is not None and tokens is not ret_tokens:
                        ret_tokens = ParseResults(
                            tokens,
                            self.resultsName,
                            asList=self.saveAsList
                            and isinstance(tokens, (ParseResults, list)),
                            modal=self.modalResults,
                        )
        if debugging:
            # print("Matched", self, "->", ret_tokens.as_list())
            if self.debugActions.debug_match:
                self.debugActions.debug_match(
                    instring, tokens_start, loc, self, ret_tokens, False
                )

        return loc, ret_tokens

    def try_parse(
        self,
        instring: str,
        loc: int,
        *,
        raise_fatal: bool = False,
        do_actions: bool = False,
    ) -> int:
        try:
            return self._parse(instring, loc, doActions=do_actions)[0]
        except ParseFatalException:
            if raise_fatal:
                raise
            raise ParseException(instring, loc, self.errmsg, self)

    def can_parse_next(self, instring: str, loc: int, do_actions: bool = False) -> bool:
        try:
            self.try_parse(instring, loc, do_actions=do_actions)
        except (ParseException, IndexError):
            return False
        else:
            return True

    # cache for left-recursion in Forward references
    recursion_lock = RLock()
    recursion_memos: typing.Dict[
        Tuple[int, "Forward", bool], Tuple[int, Union[ParseResults, Exception]]
    ] = {}

    class _CacheType(dict):
        """
        class to help type checking
        """

        not_in_cache: bool

        def get(self, *args):
            ...

        def set(self, *args):
            ...

    # argument cache for optimizing repeated calls when backtracking through recursive expressions
    packrat_cache = (
        _CacheType()
    )  # set later by enable_packrat(); this is here so that reset_cache() doesn't fail
    packrat_cache_lock = RLock()
    packrat_cache_stats = [0, 0]

    # this method gets repeatedly called during backtracking with the same arguments -
    # we can cache these arguments and save ourselves the trouble of re-parsing the contained expression
    def _parseCache(
        self, instring, loc, doActions=True, callPreParse=True
    ) -> Tuple[int, ParseResults]:
        HIT, MISS = 0, 1
        TRY, MATCH, FAIL = 0, 1, 2
        lookup = (self, instring, loc, callPreParse, doActions)
        with ParserElement.packrat_cache_lock:
            cache = ParserElement.packrat_cache
            value = cache.get(lookup)
            if value is cache.not_in_cache:
                ParserElement.packrat_cache_stats[MISS] += 1
                try:
                    value = self._parseNoCache(instring, loc, doActions, callPreParse)
                except ParseBaseException as pe:
                    # cache a copy of the exception, without the traceback
                    cache.set(lookup, pe.__class__(*pe.args))
                    raise
                else:
                    cache.set(lookup, (value[0], value[1].copy(), loc))
                    return value
            else:
                ParserElement.packrat_cache_stats[HIT] += 1
                if self.debug and self.debugActions.debug_try:
                    try:
                        self.debugActions.debug_try(instring, loc, self, cache_hit=True)  # type: ignore [call-arg]
                    except TypeError:
                        pass
                if isinstance(value, Exception):
                    if self.debug and self.debugActions.debug_fail:
                        try:
                            self.debugActions.debug_fail(
                                instring, loc, self, value, cache_hit=True  # type: ignore [call-arg]
                            )
                        except TypeError:
                            pass
                    raise value

                value = cast(Tuple[int, ParseResults, int], value)
                loc_, result, endloc = value[0], value[1].copy(), value[2]
                if self.debug and self.debugActions.debug_match:
                    try:
                        self.debugActions.debug_match(
                            instring, loc_, endloc, self, result, cache_hit=True  # type: ignore [call-arg]
                        )
                    except TypeError:
                        pass

                return loc_, result

    _parse = _parseNoCache

    @staticmethod
    def reset_cache() -> None:
        ParserElement.packrat_cache.clear()
        ParserElement.packrat_cache_stats[:] = [0] * len(
            ParserElement.packrat_cache_stats
        )
        ParserElement.recursion_memos.clear()

    _packratEnabled = False
    _left_recursion_enabled = False

    @staticmethod
    def disable_memoization() -> None:
        """
        Disables active Packrat or Left Recursion parsing and their memoization

        This method also works if neither Packrat nor Left Recursion are enabled.
        This makes it safe to call before activating Packrat nor Left Recursion
        to clear any previous settings.
        """
        ParserElement.reset_cache()
        ParserElement._left_recursion_enabled = False
        ParserElement._packratEnabled = False
        ParserElement._parse = ParserElement._parseNoCache

    @staticmethod
    def enable_left_recursion(
        cache_size_limit: typing.Optional[int] = None, *, force=False
    ) -> None:
        """
        Enables "bounded recursion" parsing, which allows for both direct and indirect
        left-recursion. During parsing, left-recursive :class:`Forward` elements are
        repeatedly matched with a fixed recursion depth that is gradually increased
        until finding the longest match.

        Example::

            from pip._vendor import pyparsing as pp
            pp.ParserElement.enable_left_recursion()

            E = pp.Forward("E")
            num = pp.Word(pp.nums)
            # match `num`, or `num '+' num`, or `num '+' num '+' num`, ...
            E <<= E + '+' - num | num

            print(E.parse_string("1+2+3"))

        Recursion search naturally memoizes matches of ``Forward`` elements and may
        thus skip reevaluation of parse actions during backtracking. This may break
        programs with parse actions which rely on strict ordering of side-effects.

        Parameters:

        - ``cache_size_limit`` - (default=``None``) - memoize at most this many
          ``Forward`` elements during matching; if ``None`` (the default),
          memoize all ``Forward`` elements.

        Bounded Recursion parsing works similar but not identical to Packrat parsing,
        thus the two cannot be used together. Use ``force=True`` to disable any
        previous, conflicting settings.
        """
        if force:
            ParserElement.disable_memoization()
        elif ParserElement._packratEnabled:
            raise RuntimeError("Packrat and Bounded Recursion are not compatible")
        if cache_size_limit is None:
            ParserElement.recursion_memos = _UnboundedMemo()  # type: ignore[assignment]
        elif cache_size_limit > 0:
            ParserElement.recursion_memos = _LRUMemo(capacity=cache_size_limit)  # type: ignore[assignment]
        else:
            raise NotImplementedError("Memo size of %s" % cache_size_limit)
        ParserElement._left_recursion_enabled = True

    @staticmethod
    def enable_packrat(cache_size_limit: int = 128, *, force: bool = False) -> None:
        """
        Enables "packrat" parsing, which adds memoizing to the parsing logic.
        Repeated parse attempts at the same string location (which happens
        often in many complex grammars) can immediately return a cached value,
        instead of re-executing parsing/validating code.  Memoizing is done of
        both valid results and parsing exceptions.

        Parameters:

        - ``cache_size_limit`` - (default= ``128``) - if an integer value is provided
          will limit the size of the packrat cache; if None is passed, then
          the cache size will be unbounded; if 0 is passed, the cache will
          be effectively disabled.

        This speedup may break existing programs that use parse actions that
        have side-effects.  For this reason, packrat parsing is disabled when
        you first import pyparsing.  To activate the packrat feature, your
        program must call the class method :class:`ParserElement.enable_packrat`.
        For best results, call ``enable_packrat()`` immediately after
        importing pyparsing.

        Example::

            from pip._vendor import pyparsing
            pyparsing.ParserElement.enable_packrat()

        Packrat parsing works similar but not identical to Bounded Recursion parsing,
        thus the two cannot be used together. Use ``force=True`` to disable any
        previous, conflicting settings.
        """
        if force:
            ParserElement.disable_memoization()
        elif ParserElement._left_recursion_enabled:
            raise RuntimeError("Packrat and Bounded Recursion are not compatible")
        if not ParserElement._packratEnabled:
            ParserElement._packratEnabled = True
            if cache_size_limit is None:
                ParserElement.packrat_cache = _UnboundedCache()
            else:
                ParserElement.packrat_cache = _FifoCache(cache_size_limit)  # type: ignore[assignment]
            ParserElement._parse = ParserElement._parseCache

    def parse_string(
        self, instring: str, parse_all: bool = False, *, parseAll: bool = False
    ) -> ParseResults:
        """
        Parse a string with respect to the parser definition. This function is intended as the primary interface to the
        client code.

        :param instring: The input string to be parsed.
        :param parse_all: If set, the entire input string must match the grammar.
        :param parseAll: retained for pre-PEP8 compatibility, will be removed in a future release.
        :raises ParseException: Raised if ``parse_all`` is set and the input string does not match the whole grammar.
        :returns: the parsed data as a :class:`ParseResults` object, which may be accessed as a `list`, a `dict`, or
          an object with attributes if the given parser includes results names.

        If the input string is required to match the entire grammar, ``parse_all`` flag must be set to ``True``. This
        is also equivalent to ending the grammar with :class:`StringEnd`\\ ().

        To report proper column numbers, ``parse_string`` operates on a copy of the input string where all tabs are
        converted to spaces (8 spaces per tab, as per the default in ``string.expandtabs``). If the input string
        contains tabs and the grammar uses parse actions that use the ``loc`` argument to index into the string
        being parsed, one can ensure a consistent view of the input string by doing one of the following:

        - calling ``parse_with_tabs`` on your grammar before calling ``parse_string`` (see :class:`parse_with_tabs`),
        - define your parse action using the full ``(s,loc,toks)`` signature, and reference the input string using the
          parse action's ``s`` argument, or
        - explicitly expand the tabs in your input string before calling ``parse_string``.

        Examples:

        By default, partial matches are OK.

        >>> res = Word('a').parse_string('aaaaabaaa')
        >>> print(res)
        ['aaaaa']

        The parsing behavior varies by the inheriting class of this abstract class. Please refer to the children
        directly to see more examples.

        It raises an exception if parse_all flag is set and instring does not match the whole grammar.

        >>> res = Word('a').parse_string('aaaaabaaa', parse_all=True)
        Traceback (most recent call last):
        ...
        pyparsing.ParseException: Expected end of text, found 'b'  (at char 5), (line:1, col:6)
        """
        parseAll = parse_all or parseAll

        ParserElement.reset_cache()
        if not self.streamlined:
            self.streamline()
        for e in self.ignoreExprs:
            e.streamline()
        if not self.keepTabs:
            instring = instring.expandtabs()
        try:
            loc, tokens = self._parse(instring, 0)
            if parseAll:
                loc = self.preParse(instring, loc)
                se = Empty() + StringEnd()
                se._parse(instring, loc)
        except ParseBaseException as exc:
            if ParserElement.verbose_stacktrace:
                raise
            else:
                # catch and re-raise exception from here, clearing out pyparsing internal stack trace
                raise exc.with_traceback(None)
        else:
            return tokens

    def scan_string(
        self,
        instring: str,
        max_matches: int = _MAX_INT,
        overlap: bool = False,
        *,
        debug: bool = False,
        maxMatches: int = _MAX_INT,
    ) -> Generator[Tuple[ParseResults, int, int], None, None]:
        """
        Scan the input string for expression matches.  Each match will return the
        matching tokens, start location, and end location.  May be called with optional
        ``max_matches`` argument, to clip scanning after 'n' matches are found.  If
        ``overlap`` is specified, then overlapping matches will be reported.

        Note that the start and end locations are reported relative to the string
        being parsed.  See :class:`parse_string` for more information on parsing
        strings with embedded tabs.

        Example::

            source = "sldjf123lsdjjkf345sldkjf879lkjsfd987"
            print(source)
            for tokens, start, end in Word(alphas).scan_string(source):
                print(' '*start + '^'*(end-start))
                print(' '*start + tokens[0])

        prints::

            sldjf123lsdjjkf345sldkjf879lkjsfd987
            ^^^^^
            sldjf
                    ^^^^^^^
                    lsdjjkf
                              ^^^^^^
                              sldkjf
                                       ^^^^^^
                                       lkjsfd
        """
        maxMatches = min(maxMatches, max_matches)
        if not self.streamlined:
            self.streamline()
        for e in self.ignoreExprs:
            e.streamline()

        if not self.keepTabs:
            instring = str(instring).expandtabs()
        instrlen = len(instring)
        loc = 0
        preparseFn = self.preParse
        parseFn = self._parse
        ParserElement.resetCache()
        matches = 0
        try:
            while loc <= instrlen and matches < maxMatches:
                try:
                    preloc: int = preparseFn(instring, loc)
                    nextLoc: int
                    tokens: ParseResults
                    nextLoc, tokens = parseFn(instring, preloc, callPreParse=False)
                except ParseException:
                    loc = preloc + 1
                else:
                    if nextLoc > loc:
                        matches += 1
                        if debug:
                            print(
                                {
                                    "tokens": tokens.asList(),
                                    "start": preloc,
                                    "end": nextLoc,
                                }
                            )
                        yield tokens, preloc, nextLoc
                        if overlap:
                            nextloc = preparseFn(instring, loc)
                            if nextloc > loc:
                                loc = nextLoc
                            else:
                                loc += 1
                        else:
                            loc = nextLoc
                    else:
                        loc = preloc + 1
        except ParseBaseException as exc:
            if ParserElement.verbose_stacktrace:
                raise
            else:
                # catch and re-raise exception from here, clears out pyparsing internal stack trace
                raise exc.with_traceback(None)

    def transform_string(self, instring: str, *, debug: bool = False) -> str:
        """
        Extension to :class:`scan_string`, to modify matching text with modified tokens that may
        be returned from a parse action.  To use ``transform_string``, define a grammar and
        attach a parse action to it that modifies the returned token list.
        Invoking ``transform_string()`` on a target string will then scan for matches,
        and replace the matched text patterns according to the logic in the parse
        action.  ``transform_string()`` returns the resulting transformed string.

        Example::

            wd = Word(alphas)
            wd.set_parse_action(lambda toks: toks[0].title())

            print(wd.transform_string("now is the winter of our discontent made glorious summer by this sun of york."))

        prints::

            Now Is The Winter Of Our Discontent Made Glorious Summer By This Sun Of York.
        """
        out: List[str] = []
        lastE = 0
        # force preservation of <TAB>s, to minimize unwanted transformation of string, and to
        # keep string locs straight between transform_string and scan_string
        self.keepTabs = True
        try:
            for t, s, e in self.scan_string(instring, debug=debug):
                out.append(instring[lastE:s])
                if t:
                    if isinstance(t, ParseResults):
                        out += t.as_list()
                    elif isinstance(t, Iterable) and not isinstance(t, str_type):
                        out.extend(t)
                    else:
                        out.append(t)
                lastE = e
            out.append(instring[lastE:])
            out = [o for o in out if o]
            return "".join([str(s) for s in _flatten(out)])
        except ParseBaseException as exc:
            if ParserElement.verbose_stacktrace:
                raise
            else:
                # catch and re-raise exception from here, clears out pyparsing internal stack trace
                raise exc.with_traceback(None)

    def search_string(
        self,
        instring: str,
        max_matches: int = _MAX_INT,
        *,
        debug: bool = False,
        maxMatches: int = _MAX_INT,
    ) -> ParseResults:
        """
        Another extension to :class:`scan_string`, simplifying the access to the tokens found
        to match the given parse expression.  May be called with optional
        ``max_matches`` argument, to clip searching after 'n' matches are found.

        Example::

            # a capitalized word starts with an uppercase letter, followed by zero or more lowercase letters
            cap_word = Word(alphas.upper(), alphas.lower())

            print(cap_word.search_string("More than Iron, more than Lead, more than Gold I need Electricity"))

            # the sum() builtin can be used to merge results into a single ParseResults object
            print(sum(cap_word.search_string("More than Iron, more than Lead, more than Gold I need Electricity")))

        prints::

            [['More'], ['Iron'], ['Lead'], ['Gold'], ['I'], ['Electricity']]
            ['More', 'Iron', 'Lead', 'Gold', 'I', 'Electricity']
        """
        maxMatches = min(maxMatches, max_matches)
        try:
            return ParseResults(
                [t for t, s, e in self.scan_string(instring, maxMatches, debug=debug)]
            )
        except ParseBaseException as exc:
            if ParserElement.verbose_stacktrace:
                raise
            else:
                # catch and re-raise exception from here, clears out pyparsing internal stack trace
                raise exc.with_traceback(None)

    def split(
        self,
        instring: str,
        maxsplit: int = _MAX_INT,
        include_separators: bool = False,
        *,
        includeSeparators=False,
    ) -> Generator[str, None, None]:
        """
        Generator method to split a string using the given expression as a separator.
        May be called with optional ``maxsplit`` argument, to limit the number of splits;
        and the optional ``include_separators`` argument (default= ``False``), if the separating
        matching text should be included in the split results.

        Example::

            punc = one_of(list(".,;:/-!?"))
            print(list(punc.split("This, this?, this sentence, is badly punctuated!")))

        prints::

            ['This', ' this', '', ' this sentence', ' is badly punctuated', '']
        """
        includeSeparators = includeSeparators or include_separators
        last = 0
        for t, s, e in self.scan_string(instring, max_matches=maxsplit):
            yield instring[last:s]
            if includeSeparators:
                yield t[0]
            last = e
        yield instring[last:]

    def __add__(self, other) -> "ParserElement":
        """
        Implementation of ``+`` operator - returns :class:`And`. Adding strings to a :class:`ParserElement`
        converts them to :class:`Literal`\\ s by default.

        Example::

            greet = Word(alphas) + "," + Word(alphas) + "!"
            hello = "Hello, World!"
            print(hello, "->", greet.parse_string(hello))

        prints::

            Hello, World! -> ['Hello', ',', 'World', '!']

        ``...`` may be used as a parse expression as a short form of :class:`SkipTo`::

            Literal('start') + ... + Literal('end')

        is equivalent to::

            Literal('start') + SkipTo('end')("_skipped*") + Literal('end')

        Note that the skipped text is returned with '_skipped' as a results name,
        and to support having multiple skips in the same parser, the value returned is
        a list of all skipped text.
        """
        if other is Ellipsis:
            return _PendingSkip(self)

        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return And([self, other])

    def __radd__(self, other) -> "ParserElement":
        """
        Implementation of ``+`` operator when left operand is not a :class:`ParserElement`
        """
        if other is Ellipsis:
            return SkipTo(self)("_skipped*") + self

        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return other + self

    def __sub__(self, other) -> "ParserElement":
        """
        Implementation of ``-`` operator, returns :class:`And` with error stop
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return self + And._ErrorStop() + other

    def __rsub__(self, other) -> "ParserElement":
        """
        Implementation of ``-`` operator when left operand is not a :class:`ParserElement`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return other - self

    def __mul__(self, other) -> "ParserElement":
        """
        Implementation of ``*`` operator, allows use of ``expr * 3`` in place of
        ``expr + expr + expr``.  Expressions may also be multiplied by a 2-integer
        tuple, similar to ``{min, max}`` multipliers in regular expressions.  Tuples
        may also include ``None`` as in:

        - ``expr*(n, None)`` or ``expr*(n, )`` is equivalent
          to ``expr*n + ZeroOrMore(expr)``
          (read as "at least n instances of ``expr``")
        - ``expr*(None, n)`` is equivalent to ``expr*(0, n)``
          (read as "0 to n instances of ``expr``")
        - ``expr*(None, None)`` is equivalent to ``ZeroOrMore(expr)``
        - ``expr*(1, None)`` is equivalent to ``OneOrMore(expr)``

        Note that ``expr*(None, n)`` does not raise an exception if
        more than n exprs exist in the input stream; that is,
        ``expr*(None, n)`` does not enforce a maximum number of expr
        occurrences.  If this behavior is desired, then write
        ``expr*(None, n) + ~expr``
        """
        if other is Ellipsis:
            other = (0, None)
        elif isinstance(other, tuple) and other[:1] == (Ellipsis,):
            other = ((0,) + other[1:] + (None,))[:2]

        if isinstance(other, int):
            minElements, optElements = other, 0
        elif isinstance(other, tuple):
            other = tuple(o if o is not Ellipsis else None for o in other)
            other = (other + (None, None))[:2]
            if other[0] is None:
                other = (0, other[1])
            if isinstance(other[0], int) and other[1] is None:
                if other[0] == 0:
                    return ZeroOrMore(self)
                if other[0] == 1:
                    return OneOrMore(self)
                else:
                    return self * other[0] + ZeroOrMore(self)
            elif isinstance(other[0], int) and isinstance(other[1], int):
                minElements, optElements = other
                optElements -= minElements
            else:
                return NotImplemented
        else:
            return NotImplemented

        if minElements < 0:
            raise ValueError("cannot multiply ParserElement by negative value")
        if optElements < 0:
            raise ValueError(
                "second tuple value must be greater or equal to first tuple value"
            )
        if minElements == optElements == 0:
            return And([])

        if optElements:

            def makeOptionalList(n):
                if n > 1:
                    return Opt(self + makeOptionalList(n - 1))
                else:
                    return Opt(self)

            if minElements:
                if minElements == 1:
                    ret = self + makeOptionalList(optElements)
                else:
                    ret = And([self] * minElements) + makeOptionalList(optElements)
            else:
                ret = makeOptionalList(optElements)
        else:
            if minElements == 1:
                ret = self
            else:
                ret = And([self] * minElements)
        return ret

    def __rmul__(self, other) -> "ParserElement":
        return self.__mul__(other)

    def __or__(self, other) -> "ParserElement":
        """
        Implementation of ``|`` operator - returns :class:`MatchFirst`
        """
        if other is Ellipsis:
            return _PendingSkip(self, must_skip=True)

        if isinstance(other, str_type):
            # `expr | ""` is equivalent to `Opt(expr)`
            if other == "":
                return Opt(self)
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return MatchFirst([self, other])

    def __ror__(self, other) -> "ParserElement":
        """
        Implementation of ``|`` operator when left operand is not a :class:`ParserElement`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return other | self

    def __xor__(self, other) -> "ParserElement":
        """
        Implementation of ``^`` operator - returns :class:`Or`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return Or([self, other])

    def __rxor__(self, other) -> "ParserElement":
        """
        Implementation of ``^`` operator when left operand is not a :class:`ParserElement`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return other ^ self

    def __and__(self, other) -> "ParserElement":
        """
        Implementation of ``&`` operator - returns :class:`Each`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return Each([self, other])

    def __rand__(self, other) -> "ParserElement":
        """
        Implementation of ``&`` operator when left operand is not a :class:`ParserElement`
        """
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return other & self

    def __invert__(self) -> "ParserElement":
        """
        Implementation of ``~`` operator - returns :class:`NotAny`
        """
        return NotAny(self)

    # disable __iter__ to override legacy use of sequential access to __getitem__ to
    # iterate over a sequence
    __iter__ = None

    def __getitem__(self, key):
        """
        use ``[]`` indexing notation as a short form for expression repetition:

        - ``expr[n]`` is equivalent to ``expr*n``
        - ``expr[m, n]`` is equivalent to ``expr*(m, n)``
        - ``expr[n, ...]`` or ``expr[n,]`` is equivalent
             to ``expr*n + ZeroOrMore(expr)``
             (read as "at least n instances of ``expr``")
        - ``expr[..., n]`` is equivalent to ``expr*(0, n)``
             (read as "0 to n instances of ``expr``")
        - ``expr[...]`` and ``expr[0, ...]`` are equivalent to ``ZeroOrMore(expr)``
        - ``expr[1, ...]`` is equivalent to ``OneOrMore(expr)``

        ``None`` may be used in place of ``...``.

        Note that ``expr[..., n]`` and ``expr[m, n]`` do not raise an exception
        if more than ``n`` ``expr``\\ s exist in the input stream.  If this behavior is
        desired, then write ``expr[..., n] + ~expr``.

        For repetition with a stop_on expression, use slice notation:

        - ``expr[...: end_expr]`` and ``expr[0, ...: end_expr]`` are equivalent to ``ZeroOrMore(expr, stop_on=end_expr)``
        - ``expr[1, ...: end_expr]`` is equivalent to ``OneOrMore(expr, stop_on=end_expr)``

        """

        stop_on_defined = False
        stop_on = NoMatch()
        if isinstance(key, slice):
            key, stop_on = key.start, key.stop
            if key is None:
                key = ...
            stop_on_defined = True
        elif isinstance(key, tuple) and isinstance(key[-1], slice):
            key, stop_on = (key[0], key[1].start), key[1].stop
            stop_on_defined = True

        # convert single arg keys to tuples
        if isinstance(key, str_type):
            key = (key,)
        try:
            iter(key)
        except TypeError:
            key = (key, key)

        if len(key) > 2:
            raise TypeError(
                f"only 1 or 2 index arguments supported ({key[:5]}{f'... [{len(key)}]' if len(key) > 5 else ''})"
            )

        # clip to 2 elements
        ret = self * tuple(key[:2])
        ret = typing.cast(_MultipleMatch, ret)

        if stop_on_defined:
            ret.stopOn(stop_on)

        return ret

    def __call__(self, name: typing.Optional[str] = None) -> "ParserElement":
        """
        Shortcut for :class:`set_results_name`, with ``list_all_matches=False``.

        If ``name`` is given with a trailing ``'*'`` character, then ``list_all_matches`` will be
        passed as ``True``.

        If ``name`` is omitted, same as calling :class:`copy`.

        Example::

            # these are equivalent
            userdata = Word(alphas).set_results_name("name") + Word(nums + "-").set_results_name("socsecno")
            userdata = Word(alphas)("name") + Word(nums + "-")("socsecno")
        """
        if name is not None:
            return self._setResultsName(name)
        else:
            return self.copy()

    def suppress(self) -> "ParserElement":
        """
        Suppresses the output of this :class:`ParserElement`; useful to keep punctuation from
        cluttering up returned output.
        """
        return Suppress(self)

    def ignore_whitespace(self, recursive: bool = True) -> "ParserElement":
        """
        Enables the skipping of whitespace before matching the characters in the
        :class:`ParserElement`'s defined pattern.

        :param recursive: If ``True`` (the default), also enable whitespace skipping in child elements (if any)
        """
        self.skipWhitespace = True
        return self

    def leave_whitespace(self, recursive: bool = True) -> "ParserElement":
        """
        Disables the skipping of whitespace before matching the characters in the
        :class:`ParserElement`'s defined pattern.  This is normally only used internally by
        the pyparsing module, but may be needed in some whitespace-sensitive grammars.

        :param recursive: If true (the default), also disable whitespace skipping in child elements (if any)
        """
        self.skipWhitespace = False
        return self

    def set_whitespace_chars(
        self, chars: Union[Set[str], str], copy_defaults: bool = False
    ) -> "ParserElement":
        """
        Overrides the default whitespace chars
        """
        self.skipWhitespace = True
        self.whiteChars = set(chars)
        self.copyDefaultWhiteChars = copy_defaults
        return self

    def parse_with_tabs(self) -> "ParserElement":
        """
        Overrides default behavior to expand ``<TAB>`` s to spaces before parsing the input string.
        Must be called before ``parse_string`` when the input grammar contains elements that
        match ``<TAB>`` characters.
        """
        self.keepTabs = True
        return self

    def ignore(self, other: "ParserElement") -> "ParserElement":
        """
        Define expression to be ignored (e.g., comments) while doing pattern
        matching; may be called repeatedly, to define multiple comment or other
        ignorable patterns.

        Example::

            patt = Word(alphas)[1, ...]
            patt.parse_string('ablaj /* comment */ lskjd')
            # -> ['ablaj']

            patt.ignore(c_style_comment)
            patt.parse_string('ablaj /* comment */ lskjd')
            # -> ['ablaj', 'lskjd']
        """
        import typing

        if isinstance(other, str_type):
            other = Suppress(other)

        if isinstance(other, Suppress):
            if other not in self.ignoreExprs:
                self.ignoreExprs.append(other)
        else:
            self.ignoreExprs.append(Suppress(other.copy()))
        return self

    def set_debug_actions(
        self,
        start_action: DebugStartAction,
        success_action: DebugSuccessAction,
        exception_action: DebugExceptionAction,
    ) -> "ParserElement":
        """
        Customize display of debugging messages while doing pattern matching:

        - ``start_action`` - method to be called when an expression is about to be parsed;
          should have the signature ``fn(input_string: str, location: int, expression: ParserElement, cache_hit: bool)``

        - ``success_action`` - method to be called when an expression has successfully parsed;
          should have the signature ``fn(input_string: str, start_location: int, end_location: int, expression: ParserELement, parsed_tokens: ParseResults, cache_hit: bool)``

        - ``exception_action`` - method to be called when expression fails to parse;
          should have the signature ``fn(input_string: str, location: int, expression: ParserElement, exception: Exception, cache_hit: bool)``
        """
        self.debugActions = self.DebugActions(
            start_action or _default_start_debug_action,  # type: ignore[truthy-function]
            success_action or _default_success_debug_action,  # type: ignore[truthy-function]
            exception_action or _default_exception_debug_action,  # type: ignore[truthy-function]
        )
        self.debug = True
        return self

    def set_debug(self, flag: bool = True, recurse: bool = False) -> "ParserElement":
        """
        Enable display of debugging messages while doing pattern matching.
        Set ``flag`` to ``True`` to enable, ``False`` to disable.
        Set ``recurse`` to ``True`` to set the debug flag on this expression and all sub-expressions.

        Example::

            wd = Word(alphas).set_name("alphaword")
            integer = Word(nums).set_name("numword")
            term = wd | integer

            # turn on debugging for wd
            wd.set_debug()

            term[1, ...].parse_string("abc 123 xyz 890")

        prints::

            Match alphaword at loc 0(1,1)
            Matched alphaword -> ['abc']
            Match alphaword at loc 3(1,4)
            Exception raised:Expected alphaword (at char 4), (line:1, col:5)
            Match alphaword at loc 7(1,8)
            Matched alphaword -> ['xyz']
            Match alphaword at loc 11(1,12)
            Exception raised:Expected alphaword (at char 12), (line:1, col:13)
            Match alphaword at loc 15(1,16)
            Exception raised:Expected alphaword (at char 15), (line:1, col:16)

        The output shown is that produced by the default debug actions - custom debug actions can be
        specified using :class:`set_debug_actions`. Prior to attempting
        to match the ``wd`` expression, the debugging message ``"Match <exprname> at loc <n>(<line>,<col>)"``
        is shown. Then if the parse succeeds, a ``"Matched"`` message is shown, or an ``"Exception raised"``
        message is shown. Also note the use of :class:`set_name` to assign a human-readable name to the expression,
        which makes debugging and exception messages easier to understand - for instance, the default
        name created for the :class:`Word` expression without calling ``set_name`` is ``"W:(A-Za-z)"``.
        """
        if recurse:
            for expr in self.visit_all():
                expr.set_debug(flag, recurse=False)
            return self

        if flag:
            self.set_debug_actions(
                _default_start_debug_action,
                _default_success_debug_action,
                _default_exception_debug_action,
            )
        else:
            self.debug = False
        return self

    @property
    def default_name(self) -> str:
        if self._defaultName is None:
            self._defaultName = self._generateDefaultName()
        return self._defaultName

    @abstractmethod
    def _generateDefaultName(self) -> str:
        """
        Child classes must define this method, which defines how the ``default_name`` is set.
        """

    def set_name(self, name: str) -> "ParserElement":
        """
        Define name for this expression, makes debugging and exception messages clearer.

        Example::

            Word(nums).parse_string("ABC")  # -> Exception: Expected W:(0-9) (at char 0), (line:1, col:1)
            Word(nums).set_name("integer").parse_string("ABC")  # -> Exception: Expected integer (at char 0), (line:1, col:1)
        """
        self.customName = name
        self.errmsg = "Expected " + self.name
        if __diag__.enable_debug_on_named_expressions:
            self.set_debug()
        return self

    @property
    def name(self) -> str:
        # This will use a user-defined name if available, but otherwise defaults back to the auto-generated name
        return self.customName if self.customName is not None else self.default_name

    def __str__(self) -> str:
        return self.name

    def __repr__(self) -> str:
        return str(self)

    def streamline(self) -> "ParserElement":
        self.streamlined = True
        self._defaultName = None
        return self

    def recurse(self) -> List["ParserElement"]:
        return []

    def _checkRecursion(self, parseElementList):
        subRecCheckList = parseElementList[:] + [self]
        for e in self.recurse():
            e._checkRecursion(subRecCheckList)

    def validate(self, validateTrace=None) -> None:
        """
        Check defined expressions for valid structure, check for infinite recursive definitions.
        """
        warnings.warn(
            "ParserElement.validate() is deprecated, and should not be used to check for left recursion",
            DeprecationWarning,
            stacklevel=2,
        )
        self._checkRecursion([])

    def parse_file(
        self,
        file_or_filename: Union[str, Path, TextIO],
        encoding: str = "utf-8",
        parse_all: bool = False,
        *,
        parseAll: bool = False,
    ) -> ParseResults:
        """
        Execute the parse expression on the given file or filename.
        If a filename is specified (instead of a file object),
        the entire file is opened, read, and closed before parsing.
        """
        parseAll = parseAll or parse_all
        try:
            file_or_filename = typing.cast(TextIO, file_or_filename)
            file_contents = file_or_filename.read()
        except AttributeError:
            file_or_filename = typing.cast(str, file_or_filename)
            with open(file_or_filename, "r", encoding=encoding) as f:
                file_contents = f.read()
        try:
            return self.parse_string(file_contents, parseAll)
        except ParseBaseException as exc:
            if ParserElement.verbose_stacktrace:
                raise
            else:
                # catch and re-raise exception from here, clears out pyparsing internal stack trace
                raise exc.with_traceback(None)

    def __eq__(self, other):
        if self is other:
            return True
        elif isinstance(other, str_type):
            return self.matches(other, parse_all=True)
        elif isinstance(other, ParserElement):
            return vars(self) == vars(other)
        return False

    def __hash__(self):
        return id(self)

    def matches(
        self, test_string: str, parse_all: bool = True, *, parseAll: bool = True
    ) -> bool:
        """
        Method for quick testing of a parser against a test string. Good for simple
        inline microtests of sub expressions while building up larger parser.

        Parameters:

        - ``test_string`` - to test against this expression for a match
        - ``parse_all`` - (default= ``True``) - flag to pass to :class:`parse_string` when running tests

        Example::

            expr = Word(nums)
            assert expr.matches("100")
        """
        parseAll = parseAll and parse_all
        try:
            self.parse_string(str(test_string), parse_all=parseAll)
            return True
        except ParseBaseException:
            return False

    def run_tests(
        self,
        tests: Union[str, List[str]],
        parse_all: bool = True,
        comment: typing.Optional[Union["ParserElement", str]] = "#",
        full_dump: bool = True,
        print_results: bool = True,
        failure_tests: bool = False,
        post_parse: typing.Optional[Callable[[str, ParseResults], str]] = None,
        file: typing.Optional[TextIO] = None,
        with_line_numbers: bool = False,
        *,
        parseAll: bool = True,
        fullDump: bool = True,
        printResults: bool = True,
        failureTests: bool = False,
        postParse: typing.Optional[Callable[[str, ParseResults], str]] = None,
    ) -> Tuple[bool, List[Tuple[str, Union[ParseResults, Exception]]]]:
        """
        Execute the parse expression on a series of test strings, showing each
        test, the parsed results or where the parse failed. Quick and easy way to
        run a parse expression against a list of sample strings.

        Parameters:

        - ``tests`` - a list of separate test strings, or a multiline string of test strings
        - ``parse_all`` - (default= ``True``) - flag to pass to :class:`parse_string` when running tests
        - ``comment`` - (default= ``'#'``) - expression for indicating embedded comments in the test
          string; pass None to disable comment filtering
        - ``full_dump`` - (default= ``True``) - dump results as list followed by results names in nested outline;
          if False, only dump nested list
        - ``print_results`` - (default= ``True``) prints test output to stdout
        - ``failure_tests`` - (default= ``False``) indicates if these tests are expected to fail parsing
        - ``post_parse`` - (default= ``None``) optional callback for successful parse results; called as
          `fn(test_string, parse_results)` and returns a string to be added to the test output
        - ``file`` - (default= ``None``) optional file-like object to which test output will be written;
          if None, will default to ``sys.stdout``
        - ``with_line_numbers`` - default= ``False``) show test strings with line and column numbers

        Returns: a (success, results) tuple, where success indicates that all tests succeeded
        (or failed if ``failure_tests`` is True), and the results contain a list of lines of each
        test's output

        Example::

            number_expr = pyparsing_common.number.copy()

            result = number_expr.run_tests('''
                # unsigned integer
                100
                # negative integer
                -100
                # float with scientific notation
                6.02e23
                # integer with scientific notation
                1e-12
                ''')
            print("Success" if result[0] else "Failed!")

            result = number_expr.run_tests('''
                # stray character
                100Z
                # missing leading digit before '.'
                -.100
                # too many '.'
                3.14.159
                ''', failure_tests=True)
            print("Success" if result[0] else "Failed!")

        prints::

            # unsigned integer
            100
            [100]

            # negative integer
            -100
            [-100]

            # float with scientific notation
            6.02e23
            [6.02e+23]

            # integer with scientific notation
            1e-12
            [1e-12]

            Success

            # stray character
            100Z
               ^
            FAIL: Expected end of text (at char 3), (line:1, col:4)

            # missing leading digit before '.'
            -.100
            ^
            FAIL: Expected {real number with scientific notation | real number | signed integer} (at char 0), (line:1, col:1)

            # too many '.'
            3.14.159
                ^
            FAIL: Expected end of text (at char 4), (line:1, col:5)

            Success

        Each test string must be on a single line. If you want to test a string that spans multiple
        lines, create a test like this::

            expr.run_tests(r"this is a test\\n of strings that spans \\n 3 lines")

        (Note that this is a raw string literal, you must include the leading ``'r'``.)
        """
        from .testing import pyparsing_test

        parseAll = parseAll and parse_all
        fullDump = fullDump and full_dump
        printResults = printResults and print_results
        failureTests = failureTests or failure_tests
        postParse = postParse or post_parse
        if isinstance(tests, str_type):
            tests = typing.cast(str, tests)
            line_strip = type(tests).strip
            tests = [line_strip(test_line) for test_line in tests.rstrip().splitlines()]
        comment_specified = comment is not None
        if comment_specified:
            if isinstance(comment, str_type):
                comment = typing.cast(str, comment)
                comment = Literal(comment)
        comment = typing.cast(ParserElement, comment)
        if file is None:
            file = sys.stdout
        print_ = file.write

        result: Union[ParseResults, Exception]
        allResults: List[Tuple[str, Union[ParseResults, Exception]]] = []
        comments: List[str] = []
        success = True
        NL = Literal(r"\n").add_parse_action(replace_with("\n")).ignore(quoted_string)
        BOM = "\ufeff"
        for t in tests:
            if comment_specified and comment.matches(t, False) or comments and not t:
                comments.append(
                    pyparsing_test.with_line_numbers(t) if with_line_numbers else t
                )
                continue
            if not t:
                continue
            out = [
                "\n" + "\n".join(comments) if comments else "",
                pyparsing_test.with_line_numbers(t) if with_line_numbers else t,
            ]
            comments = []
            try:
                # convert newline marks to actual newlines, and strip leading BOM if present
                t = NL.transform_string(t.lstrip(BOM))
                result = self.parse_string(t, parse_all=parseAll)
            except ParseBaseException as pe:
                fatal = "(FATAL)" if isinstance(pe, ParseFatalException) else ""
                out.append(pe.explain())
                out.append("FAIL: " + str(pe))
                if ParserElement.verbose_stacktrace:
                    out.extend(traceback.format_tb(pe.__traceback__))
                success = success and failureTests
                result = pe
            except Exception as exc:
                out.append(f"FAIL-EXCEPTION: {type(exc).__name__}: {exc}")
                if ParserElement.verbose_stacktrace:
                    out.extend(traceback.format_tb(exc.__traceback__))
                success = success and failureTests
                result = exc
            else:
                success = success and not failureTests
                if postParse is not None:
                    try:
                        pp_value = postParse(t, result)
                        if pp_value is not None:
                            if isinstance(pp_value, ParseResults):
                                out.append(pp_value.dump())
                            else:
                                out.append(str(pp_value))
                        else:
                            out.append(result.dump())
                    except Exception as e:
                        out.append(result.dump(full=fullDump))
                        out.append(
                            f"{postParse.__name__} failed: {type(e).__name__}: {e}"
                        )
                else:
                    out.append(result.dump(full=fullDump))
            out.append("")

            if printResults:
                print_("\n".join(out))

            allResults.append((t, result))

        return success, allResults

    def create_diagram(
        self,
        output_html: Union[TextIO, Path, str],
        vertical: int = 3,
        show_results_names: bool = False,
        show_groups: bool = False,
        embed: bool = False,
        **kwargs,
    ) -> None:
        """
        Create a railroad diagram for the parser.

        Parameters:

        - ``output_html`` (str or file-like object) - output target for generated
          diagram HTML
        - ``vertical`` (int) - threshold for formatting multiple alternatives vertically
          instead of horizontally (default=3)
        - ``show_results_names`` - bool flag whether diagram should show annotations for
          defined results names
        - ``show_groups`` - bool flag whether groups should be highlighted with an unlabeled surrounding box
        - ``embed`` - bool flag whether generated HTML should omit <HEAD>, <BODY>, and <DOCTYPE> tags to embed
          the resulting HTML in an enclosing HTML source
        - ``head`` - str containing additional HTML to insert into the <HEAD> section of the generated code;
          can be used to insert custom CSS styling
        - ``body`` - str containing additional HTML to insert at the beginning of the <BODY> section of the
          generated code

        Additional diagram-formatting keyword arguments can also be included;
        see railroad.Diagram class.
        """

        try:
            from .diagram import to_railroad, railroad_to_html
        except ImportError as ie:
            raise Exception(
                "must ``pip install pyparsing[diagrams]`` to generate parser railroad diagrams"
            ) from ie

        self.streamline()

        railroad = to_railroad(
            self,
            vertical=vertical,
            show_results_names=show_results_names,
            show_groups=show_groups,
            diagram_kwargs=kwargs,
        )
        if isinstance(output_html, (str, Path)):
            with open(output_html, "w", encoding="utf-8") as diag_file:
                diag_file.write(railroad_to_html(railroad, embed=embed, **kwargs))
        else:
            # we were passed a file-like object, just write to it
            output_html.write(railroad_to_html(railroad, embed=embed, **kwargs))

    # Compatibility synonyms
    # fmt: off
    @staticmethod
    @replaced_by_pep8(inline_literals_using)
    def inlineLiteralsUsing(): ...

    @staticmethod
    @replaced_by_pep8(set_default_whitespace_chars)
    def setDefaultWhitespaceChars(): ...

    @replaced_by_pep8(set_results_name)
    def setResultsName(self): ...

    @replaced_by_pep8(set_break)
    def setBreak(self): ...

    @replaced_by_pep8(set_parse_action)
    def setParseAction(self): ...

    @replaced_by_pep8(add_parse_action)
    def addParseAction(self): ...

    @replaced_by_pep8(add_condition)
    def addCondition(self): ...

    @replaced_by_pep8(set_fail_action)
    def setFailAction(self): ...

    @replaced_by_pep8(try_parse)
    def tryParse(self): ...

    @staticmethod
    @replaced_by_pep8(enable_left_recursion)
    def enableLeftRecursion(): ...

    @staticmethod
    @replaced_by_pep8(enable_packrat)
    def enablePackrat(): ...

    @replaced_by_pep8(parse_string)
    def parseString(self): ...

    @replaced_by_pep8(scan_string)
    def scanString(self): ...

    @replaced_by_pep8(transform_string)
    def transformString(self): ...

    @replaced_by_pep8(search_string)
    def searchString(self): ...

    @replaced_by_pep8(ignore_whitespace)
    def ignoreWhitespace(self): ...

    @replaced_by_pep8(leave_whitespace)
    def leaveWhitespace(self): ...

    @replaced_by_pep8(set_whitespace_chars)
    def setWhitespaceChars(self): ...

    @replaced_by_pep8(parse_with_tabs)
    def parseWithTabs(self): ...

    @replaced_by_pep8(set_debug_actions)
    def setDebugActions(self): ...

    @replaced_by_pep8(set_debug)
    def setDebug(self): ...

    @replaced_by_pep8(set_name)
    def setName(self): ...

    @replaced_by_pep8(parse_file)
    def parseFile(self): ...

    @replaced_by_pep8(run_tests)
    def runTests(self): ...

    canParseNext = can_parse_next
    resetCache = reset_cache
    defaultName = default_name
    # fmt: on


class _PendingSkip(ParserElement):
    # internal placeholder class to hold a place were '...' is added to a parser element,
    # once another ParserElement is added, this placeholder will be replaced with a SkipTo
    def __init__(self, expr: ParserElement, must_skip: bool = False):
        super().__init__()
        self.anchor = expr
        self.must_skip = must_skip

    def _generateDefaultName(self) -> str:
        return str(self.anchor + Empty()).replace("Empty", "...")

    def __add__(self, other) -> "ParserElement":
        skipper = SkipTo(other).set_name("...")("_skipped*")
        if self.must_skip:

            def must_skip(t):
                if not t._skipped or t._skipped.as_list() == [""]:
                    del t[0]
                    t.pop("_skipped", None)

            def show_skip(t):
                if t._skipped.as_list()[-1:] == [""]:
                    t.pop("_skipped")
                    t["_skipped"] = "missing <" + repr(self.anchor) + ">"

            return (
                self.anchor + skipper().add_parse_action(must_skip)
                | skipper().add_parse_action(show_skip)
            ) + other

        return self.anchor + skipper + other

    def __repr__(self):
        return self.defaultName

    def parseImpl(self, *args):
        raise Exception(
            "use of `...` expression without following SkipTo target expression"
        )


class Token(ParserElement):
    """Abstract :class:`ParserElement` subclass, for defining atomic
    matching patterns.
    """

    def __init__(self):
        super().__init__(savelist=False)

    def _generateDefaultName(self) -> str:
        return type(self).__name__


class NoMatch(Token):
    """
    A token that will never match.
    """

    def __init__(self):
        super().__init__()
        self.mayReturnEmpty = True
        self.mayIndexError = False
        self.errmsg = "Unmatchable token"

    def parseImpl(self, instring, loc, doActions=True):
        raise ParseException(instring, loc, self.errmsg, self)


class Literal(Token):
    """
    Token to exactly match a specified string.

    Example::

        Literal('blah').parse_string('blah')  # -> ['blah']
        Literal('blah').parse_string('blahfooblah')  # -> ['blah']
        Literal('blah').parse_string('bla')  # -> Exception: Expected "blah"

    For case-insensitive matching, use :class:`CaselessLiteral`.

    For keyword matching (force word break before and after the matched string),
    use :class:`Keyword` or :class:`CaselessKeyword`.
    """

    def __new__(cls, match_string: str = "", *, matchString: str = ""):
        # Performance tuning: select a subclass with optimized parseImpl
        if cls is Literal:
            match_string = matchString or match_string
            if not match_string:
                return super().__new__(Empty)
            if len(match_string) == 1:
                return super().__new__(_SingleCharLiteral)

        # Default behavior
        return super().__new__(cls)

    # Needed to make copy.copy() work correctly if we customize __new__
    def __getnewargs__(self):
        return (self.match,)

    def __init__(self, match_string: str = "", *, matchString: str = ""):
        super().__init__()
        match_string = matchString or match_string
        self.match = match_string
        self.matchLen = len(match_string)
        self.firstMatchChar = match_string[:1]
        self.errmsg = "Expected " + self.name
        self.mayReturnEmpty = False
        self.mayIndexError = False

    def _generateDefaultName(self) -> str:
        return repr(self.match)

    def parseImpl(self, instring, loc, doActions=True):
        if instring[loc] == self.firstMatchChar and instring.startswith(
            self.match, loc
        ):
            return loc + self.matchLen, self.match
        raise ParseException(instring, loc, self.errmsg, self)


class Empty(Literal):
    """
    An empty token, will always match.
    """

    def __init__(self, match_string="", *, matchString=""):
        super().__init__("")
        self.mayReturnEmpty = True
        self.mayIndexError = False

    def _generateDefaultName(self) -> str:
        return "Empty"

    def parseImpl(self, instring, loc, doActions=True):
        return loc, []


class _SingleCharLiteral(Literal):
    def parseImpl(self, instring, loc, doActions=True):
        if instring[loc] == self.firstMatchChar:
            return loc + 1, self.match
        raise ParseException(instring, loc, self.errmsg, self)


ParserElement._literalStringClass = Literal


class Keyword(Token):
    """
    Token to exactly match a specified string as a keyword, that is,
    it must be immediately preceded and followed by whitespace or
    non-keyword characters. Compare with :class:`Literal`:

    - ``Literal("if")`` will match the leading ``'if'`` in
      ``'ifAndOnlyIf'``.
    - ``Keyword("if")`` will not; it will only match the leading
      ``'if'`` in ``'if x=1'``, or ``'if(y==2)'``

    Accepts two optional constructor arguments in addition to the
    keyword string:

    - ``ident_chars`` is a string of characters that would be valid
      identifier characters, defaulting to all alphanumerics + "_" and
      "$"
    - ``caseless`` allows case-insensitive matching, default is ``False``.

    Example::

        Keyword("start").parse_string("start")  # -> ['start']
        Keyword("start").parse_string("starting")  # -> Exception

    For case-insensitive matching, use :class:`CaselessKeyword`.
    """

    DEFAULT_KEYWORD_CHARS = alphanums + "_$"

    def __init__(
        self,
        match_string: str = "",
        ident_chars: typing.Optional[str] = None,
        caseless: bool = False,
        *,
        matchString: str = "",
        identChars: typing.Optional[str] = None,
    ):
        super().__init__()
        identChars = identChars or ident_chars
        if identChars is None:
            identChars = Keyword.DEFAULT_KEYWORD_CHARS
        match_string = matchString or match_string
        self.match = match_string
        self.matchLen = len(match_string)
        try:
            self.firstMatchChar = match_string[0]
        except IndexError:
            raise ValueError("null string passed to Keyword; use Empty() instead")
        self.errmsg = f"Expected {type(self).__name__} {self.name}"
        self.mayReturnEmpty = False
        self.mayIndexError = False
        self.caseless = caseless
        if caseless:
            self.caselessmatch = match_string.upper()
            identChars = identChars.upper()
        self.identChars = set(identChars)

    def _generateDefaultName(self) -> str:
        return repr(self.match)

    def parseImpl(self, instring, loc, doActions=True):
        errmsg = self.errmsg
        errloc = loc
        if self.caseless:
            if instring[loc : loc + self.matchLen].upper() == self.caselessmatch:
                if loc == 0 or instring[loc - 1].upper() not in self.identChars:
                    if (
                        loc >= len(instring) - self.matchLen
                        or instring[loc + self.matchLen].upper() not in self.identChars
                    ):
                        return loc + self.matchLen, self.match
                    else:
                        # followed by keyword char
                        errmsg += ", was immediately followed by keyword character"
                        errloc = loc + self.matchLen
                else:
                    # preceded by keyword char
                    errmsg += ", keyword was immediately preceded by keyword character"
                    errloc = loc - 1
            # else no match just raise plain exception

        else:
            if (
                instring[loc] == self.firstMatchChar
                and self.matchLen == 1
                or instring.startswith(self.match, loc)
            ):
                if loc == 0 or instring[loc - 1] not in self.identChars:
                    if (
                        loc >= len(instring) - self.matchLen
                        or instring[loc + self.matchLen] not in self.identChars
                    ):
                        return loc + self.matchLen, self.match
                    else:
                        # followed by keyword char
                        errmsg += (
                            ", keyword was immediately followed by keyword character"
                        )
                        errloc = loc + self.matchLen
                else:
                    # preceded by keyword char
                    errmsg += ", keyword was immediately preceded by keyword character"
                    errloc = loc - 1
            # else no match just raise plain exception

        raise ParseException(instring, errloc, errmsg, self)

    @staticmethod
    def set_default_keyword_chars(chars) -> None:
        """
        Overrides the default characters used by :class:`Keyword` expressions.
        """
        Keyword.DEFAULT_KEYWORD_CHARS = chars

    setDefaultKeywordChars = set_default_keyword_chars


class CaselessLiteral(Literal):
    """
    Token to match a specified string, ignoring case of letters.
    Note: the matched results will always be in the case of the given
    match string, NOT the case of the input text.

    Example::

        CaselessLiteral("CMD")[1, ...].parse_string("cmd CMD Cmd10")
        # -> ['CMD', 'CMD', 'CMD']

    (Contrast with example for :class:`CaselessKeyword`.)
    """

    def __init__(self, match_string: str = "", *, matchString: str = ""):
        match_string = matchString or match_string
        super().__init__(match_string.upper())
        # Preserve the defining literal.
        self.returnString = match_string
        self.errmsg = "Expected " + self.name

    def parseImpl(self, instring, loc, doActions=True):
        if instring[loc : loc + self.matchLen].upper() == self.match:
            return loc + self.matchLen, self.returnString
        raise ParseException(instring, loc, self.errmsg, self)


class CaselessKeyword(Keyword):
    """
    Caseless version of :class:`Keyword`.

    Example::

        CaselessKeyword("CMD")[1, ...].parse_string("cmd CMD Cmd10")
        # -> ['CMD', 'CMD']

    (Contrast with example for :class:`CaselessLiteral`.)
    """

    def __init__(
        self,
        match_string: str = "",
        ident_chars: typing.Optional[str] = None,
        *,
        matchString: str = "",
        identChars: typing.Optional[str] = None,
    ):
        identChars = identChars or ident_chars
        match_string = matchString or match_string
        super().__init__(match_string, identChars, caseless=True)


class CloseMatch(Token):
    """A variation on :class:`Literal` which matches "close" matches,
    that is, strings with at most 'n' mismatching characters.
    :class:`CloseMatch` takes parameters:

    - ``match_string`` - string to be matched
    - ``caseless`` - a boolean indicating whether to ignore casing when comparing characters
    - ``max_mismatches`` - (``default=1``) maximum number of
      mismatches allowed to count as a match

    The results from a successful parse will contain the matched text
    from the input string and the following named results:

    - ``mismatches`` - a list of the positions within the
      match_string where mismatches were found
    - ``original`` - the original match_string used to compare
      against the input string

    If ``mismatches`` is an empty list, then the match was an exact
    match.

    Example::

        patt = CloseMatch("ATCATCGAATGGA")
        patt.parse_string("ATCATCGAAXGGA") # -> (['ATCATCGAAXGGA'], {'mismatches': [[9]], 'original': ['ATCATCGAATGGA']})
        patt.parse_string("ATCAXCGAAXGGA") # -> Exception: Expected 'ATCATCGAATGGA' (with up to 1 mismatches) (at char 0), (line:1, col:1)

        # exact match
        patt.parse_string("ATCATCGAATGGA") # -> (['ATCATCGAATGGA'], {'mismatches': [[]], 'original': ['ATCATCGAATGGA']})

        # close match allowing up to 2 mismatches
        patt = CloseMatch("ATCATCGAATGGA", max_mismatches=2)
        patt.parse_string("ATCAXCGAAXGGA") # -> (['ATCAXCGAAXGGA'], {'mismatches': [[4, 9]], 'original': ['ATCATCGAATGGA']})
    """

    def __init__(
        self,
        match_string: str,
        max_mismatches: typing.Optional[int] = None,
        *,
        maxMismatches: int = 1,
        caseless=False,
    ):
        maxMismatches = max_mismatches if max_mismatches is not None else maxMismatches
        super().__init__()
        self.match_string = match_string
        self.maxMismatches = maxMismatches
        self.errmsg = f"Expected {self.match_string!r} (with up to {self.maxMismatches} mismatches)"
        self.caseless = caseless
        self.mayIndexError = False
        self.mayReturnEmpty = False

    def _generateDefaultName(self) -> str:
        return f"{type(self).__name__}:{self.match_string!r}"

    def parseImpl(self, instring, loc, doActions=True):
        start = loc
        instrlen = len(instring)
        maxloc = start + len(self.match_string)

        if maxloc <= instrlen:
            match_string = self.match_string
            match_stringloc = 0
            mismatches = []
            maxMismatches = self.maxMismatches

            for match_stringloc, s_m in enumerate(
                zip(instring[loc:maxloc], match_string)
            ):
                src, mat = s_m
                if self.caseless:
                    src, mat = src.lower(), mat.lower()

                if src != mat:
                    mismatches.append(match_stringloc)
                    if len(mismatches) > maxMismatches:
                        break
            else:
                loc = start + match_stringloc + 1
                results = ParseResults([instring[start:loc]])
                results["original"] = match_string
                results["mismatches"] = mismatches
                return loc, results

        raise ParseException(instring, loc, self.errmsg, self)


class Word(Token):
    """Token for matching words composed of allowed character sets.

    Parameters:

    - ``init_chars`` - string of all characters that should be used to
      match as a word; "ABC" will match "AAA", "ABAB", "CBAC", etc.;
      if ``body_chars`` is also specified, then this is the string of
      initial characters
    - ``body_chars`` - string of characters that
      can be used for matching after a matched initial character as
      given in ``init_chars``; if omitted, same as the initial characters
      (default=``None``)
    - ``min`` - minimum number of characters to match (default=1)
    - ``max`` - maximum number of characters to match (default=0)
    - ``exact`` - exact number of characters to match (default=0)
    - ``as_keyword`` - match as a keyword (default=``False``)
    - ``exclude_chars`` - characters that might be
      found in the input ``body_chars`` string but which should not be
      accepted for matching ;useful to define a word of all
      printables except for one or two characters, for instance
      (default=``None``)

    :class:`srange` is useful for defining custom character set strings
    for defining :class:`Word` expressions, using range notation from
    regular expression character sets.

    A common mistake is to use :class:`Word` to match a specific literal
    string, as in ``Word("Address")``. Remember that :class:`Word`
    uses the string argument to define *sets* of matchable characters.
    This expression would match "Add", "AAA", "dAred", or any other word
    made up of the characters 'A', 'd', 'r', 'e', and 's'. To match an
    exact literal string, use :class:`Literal` or :class:`Keyword`.

    pyparsing includes helper strings for building Words:

    - :class:`alphas`
    - :class:`nums`
    - :class:`alphanums`
    - :class:`hexnums`
    - :class:`alphas8bit` (alphabetic characters in ASCII range 128-255
      - accented, tilded, umlauted, etc.)
    - :class:`punc8bit` (non-alphabetic characters in ASCII range
      128-255 - currency, symbols, superscripts, diacriticals, etc.)
    - :class:`printables` (any non-whitespace character)

    ``alphas``, ``nums``, and ``printables`` are also defined in several
    Unicode sets - see :class:`pyparsing_unicode``.

    Example::

        # a word composed of digits
        integer = Word(nums) # equivalent to Word("0123456789") or Word(srange("0-9"))

        # a word with a leading capital, and zero or more lowercase
        capital_word = Word(alphas.upper(), alphas.lower())

        # hostnames are alphanumeric, with leading alpha, and '-'
        hostname = Word(alphas, alphanums + '-')

        # roman numeral (not a strict parser, accepts invalid mix of characters)
        roman = Word("IVXLCDM")

        # any string of non-whitespace characters, except for ','
        csv_value = Word(printables, exclude_chars=",")
    """

    def __init__(
        self,
        init_chars: str = "",
        body_chars: typing.Optional[str] = None,
        min: int = 1,
        max: int = 0,
        exact: int = 0,
        as_keyword: bool = False,
        exclude_chars: typing.Optional[str] = None,
        *,
        initChars: typing.Optional[str] = None,
        bodyChars: typing.Optional[str] = None,
        asKeyword: bool = False,
        excludeChars: typing.Optional[str] = None,
    ):
        initChars = initChars or init_chars
        bodyChars = bodyChars or body_chars
        asKeyword = asKeyword or as_keyword
        excludeChars = excludeChars or exclude_chars
        super().__init__()
        if not initChars:
            raise ValueError(
                f"invalid {type(self).__name__}, initChars cannot be empty string"
            )

        initChars_set = set(initChars)
        if excludeChars:
            excludeChars_set = set(excludeChars)
            initChars_set -= excludeChars_set
            if bodyChars:
                bodyChars = "".join(set(bodyChars) - excludeChars_set)
        self.initChars = initChars_set
        self.initCharsOrig = "".join(sorted(initChars_set))

        if bodyChars:
            self.bodyChars = set(bodyChars)
            self.bodyCharsOrig = "".join(sorted(bodyChars))
        else:
            self.bodyChars = initChars_set
            self.bodyCharsOrig = self.initCharsOrig

        self.maxSpecified = max > 0

        if min < 1:
            raise ValueError(
                "cannot specify a minimum length < 1; use Opt(Word()) if zero-length word is permitted"
            )

        if self.maxSpecified and min > max:
            raise ValueError(
                f"invalid args, if min and max both specified min must be <= max (min={min}, max={max})"
            )

        self.minLen = min

        if max > 0:
            self.maxLen = max
        else:
            self.maxLen = _MAX_INT

        if exact > 0:
            min = max = exact
            self.maxLen = exact
            self.minLen = exact

        self.errmsg = "Expected " + self.name
        self.mayIndexError = False
        self.asKeyword = asKeyword
        if self.asKeyword:
            self.errmsg += " as a keyword"

        # see if we can make a regex for this Word
        if " " not in (self.initChars | self.bodyChars):
            if len(self.initChars) == 1:
                re_leading_fragment = re.escape(self.initCharsOrig)
            else:
                re_leading_fragment = f"[{_collapse_string_to_ranges(self.initChars)}]"

            if self.bodyChars == self.initChars:
                if max == 0:
                    repeat = "+"
                elif max == 1:
                    repeat = ""
                else:
                    if self.minLen != self.maxLen:
                        repeat = f"{{{self.minLen},{'' if self.maxLen == _MAX_INT else self.maxLen}}}"
                    else:
                        repeat = f"{{{self.minLen}}}"
                self.reString = f"{re_leading_fragment}{repeat}"
            else:
                if max == 1:
                    re_body_fragment = ""
                    repeat = ""
                else:
                    re_body_fragment = f"[{_collapse_string_to_ranges(self.bodyChars)}]"
                    if max == 0:
                        repeat = "*"
                    elif max == 2:
                        repeat = "?" if min <= 1 else ""
                    else:
                        if min != max:
                            repeat = f"{{{min - 1 if min > 0 else 0},{max - 1}}}"
                        else:
                            repeat = f"{{{min - 1 if min > 0 else 0}}}"

                self.reString = (
                    f"{re_leading_fragment}" f"{re_body_fragment}" f"{repeat}"
                )

            if self.asKeyword:
                self.reString = rf"\b{self.reString}\b"

            try:
                self.re = re.compile(self.reString)
            except re.error:
                self.re = None  # type: ignore[assignment]
            else:
                self.re_match = self.re.match
                self.parseImpl = self.parseImpl_regex  # type: ignore[assignment]

    def _generateDefaultName(self) -> str:
        def charsAsStr(s):
            max_repr_len = 16
            s = _collapse_string_to_ranges(s, re_escape=False)
            if len(s) > max_repr_len:
                return s[: max_repr_len - 3] + "..."
            else:
                return s

        if self.initChars != self.bodyChars:
            base = f"W:({charsAsStr(self.initChars)}, {charsAsStr(self.bodyChars)})"
        else:
            base = f"W:({charsAsStr(self.initChars)})"

        # add length specification
        if self.minLen > 1 or self.maxLen != _MAX_INT:
            if self.minLen == self.maxLen:
                if self.minLen == 1:
                    return base[2:]
                else:
                    return base + f"{{{self.minLen}}}"
            elif self.maxLen == _MAX_INT:
                return base + f"{{{self.minLen},...}}"
            else:
                return base + f"{{{self.minLen},{self.maxLen}}}"
        return base

    def parseImpl(self, instring, loc, doActions=True):
        if instring[loc] not in self.initChars:
            raise ParseException(instring, loc, self.errmsg, self)

        start = loc
        loc += 1
        instrlen = len(instring)
        bodychars = self.bodyChars
        maxloc = start + self.maxLen
        maxloc = min(maxloc, instrlen)
        while loc < maxloc and instring[loc] in bodychars:
            loc += 1

        throwException = False
        if loc - start < self.minLen:
            throwException = True
        elif self.maxSpecified and loc < instrlen and instring[loc] in bodychars:
            throwException = True
        elif self.asKeyword:
            if (
                start > 0
                and instring[start - 1] in bodychars
                or loc < instrlen
                and instring[loc] in bodychars
            ):
                throwException = True

        if throwException:
            raise ParseException(instring, loc, self.errmsg, self)

        return loc, instring[start:loc]

    def parseImpl_regex(self, instring, loc, doActions=True):
        result = self.re_match(instring, loc)
        if not result:
            raise ParseException(instring, loc, self.errmsg, self)

        loc = result.end()
        return loc, result.group()


class Char(Word):
    """A short-cut class for defining :class:`Word` ``(characters, exact=1)``,
    when defining a match of any single character in a string of
    characters.
    """

    def __init__(
        self,
        charset: str,
        as_keyword: bool = False,
        exclude_chars: typing.Optional[str] = None,
        *,
        asKeyword: bool = False,
        excludeChars: typing.Optional[str] = None,
    ):
        asKeyword = asKeyword or as_keyword
        excludeChars = excludeChars or exclude_chars
        super().__init__(
            charset, exact=1, as_keyword=asKeyword, exclude_chars=excludeChars
        )


class Regex(Token):
    r"""Token for matching strings that match a given regular
    expression. Defined with string specifying the regular expression in
    a form recognized by the stdlib Python  `re module <https://docs.python.org/3/library/re.html>`_.
    If the given regex contains named groups (defined using ``(?P<name>...)``),
    these will be preserved as named :class:`ParseResults`.

    If instead of the Python stdlib ``re`` module you wish to use a different RE module
    (such as the ``regex`` module), you can do so by building your ``Regex`` object with
    a compiled RE that was compiled using ``regex``.

    Example::

        realnum = Regex(r"[+-]?\d+\.\d*")
        # ref: https://stackoverflow.com/questions/267399/how-do-you-match-only-valid-roman-numerals-with-a-regular-expression
        roman = Regex(r"M{0,4}(CM|CD|D?{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})")

        # named fields in a regex will be returned as named results
        date = Regex(r'(?P<year>\d{4})-(?P<month>\d\d?)-(?P<day>\d\d?)')

        # the Regex class will accept re's compiled using the regex module
        import regex
        parser = pp.Regex(regex.compile(r'[0-9]'))
    """

    def __init__(
        self,
        pattern: Any,
        flags: Union[re.RegexFlag, int] = 0,
        as_group_list: bool = False,
        as_match: bool = False,
        *,
        asGroupList: bool = False,
        asMatch: bool = False,
    ):
        """The parameters ``pattern`` and ``flags`` are passed
        to the ``re.compile()`` function as-is. See the Python
        `re module <https://docs.python.org/3/library/re.html>`_ module for an
        explanation of the acceptable patterns and flags.
        """
        super().__init__()
        asGroupList = asGroupList or as_group_list
        asMatch = asMatch or as_match

        if isinstance(pattern, str_type):
            if not pattern:
                raise ValueError("null string passed to Regex; use Empty() instead")

            self._re = None
            self.reString = self.pattern = pattern
            self.flags = flags

        elif hasattr(pattern, "pattern") and hasattr(pattern, "match"):
            self._re = pattern
            self.pattern = self.reString = pattern.pattern
            self.flags = flags

        else:
            raise TypeError(
                "Regex may only be constructed with a string or a compiled RE object"
            )

        self.errmsg = "Expected " + self.name
        self.mayIndexError = False
        self.asGroupList = asGroupList
        self.asMatch = asMatch
        if self.asGroupList:
            self.parseImpl = self.parseImplAsGroupList  # type: ignore [assignment]
        if self.asMatch:
            self.parseImpl = self.parseImplAsMatch  # type: ignore [assignment]

    @cached_property
    def re(self):
        if self._re:
            return self._re
        else:
            try:
                return re.compile(self.pattern, self.flags)
            except re.error:
                raise ValueError(f"invalid pattern ({self.pattern!r}) passed to Regex")

    @cached_property
    def re_match(self):
        return self.re.match

    @cached_property
    def mayReturnEmpty(self):
        return self.re_match("") is not None

    def _generateDefaultName(self) -> str:
        return "Re:({})".format(repr(self.pattern).replace("\\\\", "\\"))

    def parseImpl(self, instring, loc, doActions=True):
        result = self.re_match(instring, loc)
        if not result:
            raise ParseException(instring, loc, self.errmsg, self)

        loc = result.end()
        ret = ParseResults(result.group())
        d = result.groupdict()
        if d:
            for k, v in d.items():
                ret[k] = v
        return loc, ret

    def parseImplAsGroupList(self, instring, loc, doActions=True):
        result = self.re_match(instring, loc)
        if not result:
            raise ParseException(instring, loc, self.errmsg, self)

        loc = result.end()
        ret = result.groups()
        return loc, ret

    def parseImplAsMatch(self, instring, loc, doActions=True):
        result = self.re_match(instring, loc)
        if not result:
            raise ParseException(instring, loc, self.errmsg, self)

        loc = result.end()
        ret = result
        return loc, ret

    def sub(self, repl: str) -> ParserElement:
        r"""
        Return :class:`Regex` with an attached parse action to transform the parsed
        result as if called using `re.sub(expr, repl, string) <https://docs.python.org/3/library/re.html#re.sub>`_.

        Example::

            make_html = Regex(r"(\w+):(.*?):").sub(r"<\1>\2</\1>")
            print(make_html.transform_string("h1:main title:"))
            # prints "<h1>main title</h1>"
        """
        if self.asGroupList:
            raise TypeError("cannot use sub() with Regex(as_group_list=True)")

        if self.asMatch and callable(repl):
            raise TypeError(
                "cannot use sub() with a callable with Regex(as_match=True)"
            )

        if self.asMatch:

            def pa(tokens):
                return tokens[0].expand(repl)

        else:

            def pa(tokens):
                return self.re.sub(repl, tokens[0])

        return self.add_parse_action(pa)


class QuotedString(Token):
    r"""
    Token for matching strings that are delimited by quoting characters.

    Defined with the following parameters:

    - ``quote_char`` - string of one or more characters defining the
      quote delimiting string
    - ``esc_char`` - character to re_escape quotes, typically backslash
      (default= ``None``)
    - ``esc_quote`` - special quote sequence to re_escape an embedded quote
      string (such as SQL's ``""`` to re_escape an embedded ``"``)
      (default= ``None``)
    - ``multiline`` - boolean indicating whether quotes can span
      multiple lines (default= ``False``)
    - ``unquote_results`` - boolean indicating whether the matched text
      should be unquoted (default= ``True``)
    - ``end_quote_char`` - string of one or more characters defining the
      end of the quote delimited string (default= ``None``  => same as
      quote_char)
    - ``convert_whitespace_escapes`` - convert escaped whitespace
      (``'\t'``, ``'\n'``, etc.) to actual whitespace
      (default= ``True``)

    Example::

        qs = QuotedString('"')
        print(qs.search_string('lsjdf "This is the quote" sldjf'))
        complex_qs = QuotedString('{{', end_quote_char='}}')
        print(complex_qs.search_string('lsjdf {{This is the "quote"}} sldjf'))
        sql_qs = QuotedString('"', esc_quote='""')
        print(sql_qs.search_string('lsjdf "This is the quote with ""embedded"" quotes" sldjf'))

    prints::

        [['This is the quote']]
        [['This is the "quote"']]
        [['This is the quote with "embedded" quotes']]
    """
    ws_map = dict(((r"\t", "\t"), (r"\n", "\n"), (r"\f", "\f"), (r"\r", "\r")))

    def __init__(
        self,
        quote_char: str = "",
        esc_char: typing.Optional[str] = None,
        esc_quote: typing.Optional[str] = None,
        multiline: bool = False,
        unquote_results: bool = True,
        end_quote_char: typing.Optional[str] = None,
        convert_whitespace_escapes: bool = True,
        *,
        quoteChar: str = "",
        escChar: typing.Optional[str] = None,
        escQuote: typing.Optional[str] = None,
        unquoteResults: bool = True,
        endQuoteChar: typing.Optional[str] = None,
        convertWhitespaceEscapes: bool = True,
    ):
        super().__init__()
        escChar = escChar or esc_char
        escQuote = escQuote or esc_quote
        unquoteResults = unquoteResults and unquote_results
        endQuoteChar = endQuoteChar or end_quote_char
        convertWhitespaceEscapes = (
            convertWhitespaceEscapes and convert_whitespace_escapes
        )
        quote_char = quoteChar or quote_char

        # remove white space from quote chars - wont work anyway
        quote_char = quote_char.strip()
        if not quote_char:
            raise ValueError("quote_char cannot be the empty string")

        if endQuoteChar is None:
            endQuoteChar = quote_char
        else:
            endQuoteChar = endQuoteChar.strip()
            if not endQuoteChar:
                raise ValueError("end_quote_char cannot be the empty string")

        self.quoteChar: str = quote_char
        self.quoteCharLen: int = len(quote_char)
        self.firstQuoteChar: str = quote_char[0]
        self.endQuoteChar: str = endQuoteChar
        self.endQuoteCharLen: int = len(endQuoteChar)
        self.escChar: str = escChar or ""
        self.escQuote: str = escQuote or ""
        self.unquoteResults: bool = unquoteResults
        self.convertWhitespaceEscapes: bool = convertWhitespaceEscapes
        self.multiline = multiline

        sep = ""
        inner_pattern = ""

        if escQuote:
            inner_pattern += rf"{sep}(?:{re.escape(escQuote)})"
            sep = "|"

        if escChar:
            inner_pattern += rf"{sep}(?:{re.escape(escChar)}.)"
            sep = "|"
            self.escCharReplacePattern = re.escape(escChar) + "(.)"

        if len(self.endQuoteChar) > 1:
            inner_pattern += (
                f"{sep}(?:"
                + "|".join(
                    f"(?:{re.escape(self.endQuoteChar[:i])}(?!{re.escape(self.endQuoteChar[i:])}))"
                    for i in range(len(self.endQuoteChar) - 1, 0, -1)
                )
                + ")"
            )
            sep = "|"

        self.flags = re.RegexFlag(0)

        if multiline:
            self.flags = re.MULTILINE | re.DOTALL
            inner_pattern += (
                rf"{sep}(?:[^{_escape_regex_range_chars(self.endQuoteChar[0])}"
                rf"{(_escape_regex_range_chars(escChar) if escChar is not None else '')}])"
            )
        else:
            inner_pattern += (
                rf"{sep}(?:[^{_escape_regex_range_chars(self.endQuoteChar[0])}\n\r"
                rf"{(_escape_regex_range_chars(escChar) if escChar is not None else '')}])"
            )

        self.pattern = "".join(
            [
                re.escape(self.quoteChar),
                "(?:",
                inner_pattern,
                ")*",
                re.escape(self.endQuoteChar),
            ]
        )

        if self.unquoteResults:
            if self.convertWhitespaceEscapes:
                self.unquote_scan_re = re.compile(
                    rf"({'|'.join(re.escape(k) for k in self.ws_map)})|({re.escape(self.escChar)}.)|(\n|.)",
                    flags=self.flags,
                )
            else:
                self.unquote_scan_re = re.compile(
                    rf"({re.escape(self.escChar)}.)|(\n|.)", flags=self.flags
                )

        try:
            self.re = re.compile(self.pattern, self.flags)
            self.reString = self.pattern
            self.re_match = self.re.match
        except re.error:
            raise ValueError(f"invalid pattern {self.pattern!r} passed to Regex")

        self.errmsg = "Expected " + self.name
        self.mayIndexError = False
        self.mayReturnEmpty = True

    def _generateDefaultName(self) -> str:
        if self.quoteChar == self.endQuoteChar and isinstance(self.quoteChar, str_type):
            return f"string enclosed in {self.quoteChar!r}"

        return f"quoted string, starting with {self.quoteChar} ending with {self.endQuoteChar}"

    def parseImpl(self, instring, loc, doActions=True):
        result = (
            instring[loc] == self.firstQuoteChar
            and self.re_match(instring, loc)
            or None
        )
        if not result:
            raise ParseException(instring, loc, self.errmsg, self)

        loc = result.end()
        ret = result.group()

        if self.unquoteResults:
            # strip off quotes
            ret = ret[self.quoteCharLen : -self.endQuoteCharLen]

            if isinstance(ret, str_type):
                if self.convertWhitespaceEscapes:
                    ret = "".join(
                        self.ws_map[match.group(1)]
                        if match.group(1)
                        else match.group(2)[-1]
                        if match.group(2)
                        else match.group(3)
                        for match in self.unquote_scan_re.finditer(ret)
                    )
                else:
                    ret = "".join(
                        match.group(1)[-1] if match.group(1) else match.group(2)
                        for match in self.unquote_scan_re.finditer(ret)
                    )

                # replace escaped quotes
                if self.escQuote:
                    ret = ret.replace(self.escQuote, self.endQuoteChar)

        return loc, ret


class CharsNotIn(Token):
    """Token for matching words composed of characters *not* in a given
    set (will include whitespace in matched characters if not listed in
    the provided exclusion set - see example). Defined with string
    containing all disallowed characters, and an optional minimum,
    maximum, and/or exact length.  The default value for ``min`` is
    1 (a minimum value < 1 is not valid); the default values for
    ``max`` and ``exact`` are 0, meaning no maximum or exact
    length restriction.

    Example::

        # define a comma-separated-value as anything that is not a ','
        csv_value = CharsNotIn(',')
        print(DelimitedList(csv_value).parse_string("dkls,lsdkjf,s12 34,@!#,213"))

    prints::

        ['dkls', 'lsdkjf', 's12 34', '@!#', '213']
    """

    def __init__(
        self,
        not_chars: str = "",
        min: int = 1,
        max: int = 0,
        exact: int = 0,
        *,
        notChars: str = "",
    ):
        super().__init__()
        self.skipWhitespace = False
        self.notChars = not_chars or notChars
        self.notCharsSet = set(self.notChars)

        if min < 1:
            raise ValueError(
                "cannot specify a minimum length < 1; use "
                "Opt(CharsNotIn()) if zero-length char group is permitted"
            )

        self.minLen = min

        if max > 0:
            self.maxLen = max
        else:
            self.maxLen = _MAX_INT

        if exact > 0:
            self.maxLen = exact
            self.minLen = exact

        self.errmsg = "Expected " + self.name
        self.mayReturnEmpty = self.minLen == 0
        self.mayIndexError = False

    def _generateDefaultName(self) -> str:
        not_chars_str = _collapse_string_to_ranges(self.notChars)
        if len(not_chars_str) > 16:
            return f"!W:({self.notChars[: 16 - 3]}...)"
        else:
            return f"!W:({self.notChars})"

    def parseImpl(self, instring, loc, doActions=True):
        notchars = self.notCharsSet
        if instring[loc] in notchars:
            raise ParseException(instring, loc, self.errmsg, self)

        start = loc
        loc += 1
        maxlen = min(start + self.maxLen, len(instring))
        while loc < maxlen and instring[loc] not in notchars:
            loc += 1

        if loc - start < self.minLen:
            raise ParseException(instring, loc, self.errmsg, self)

        return loc, instring[start:loc]


class White(Token):
    """Special matching class for matching whitespace.  Normally,
    whitespace is ignored by pyparsing grammars.  This class is included
    when some whitespace structures are significant.  Define with
    a string containing the whitespace characters to be matched; default
    is ``" \\t\\r\\n"``.  Also takes optional ``min``,
    ``max``, and ``exact`` arguments, as defined for the
    :class:`Word` class.
    """

    whiteStrs = {
        " ": "<SP>",
        "\t": "<TAB>",
        "\n": "<LF>",
        "\r": "<CR>",
        "\f": "<FF>",
        "\u00A0": "<NBSP>",
        "\u1680": "<OGHAM_SPACE_MARK>",
        "\u180E": "<MONGOLIAN_VOWEL_SEPARATOR>",
        "\u2000": "<EN_QUAD>",
        "\u2001": "<EM_QUAD>",
        "\u2002": "<EN_SPACE>",
        "\u2003": "<EM_SPACE>",
        "\u2004": "<THREE-PER-EM_SPACE>",
        "\u2005": "<FOUR-PER-EM_SPACE>",
        "\u2006": "<SIX-PER-EM_SPACE>",
        "\u2007": "<FIGURE_SPACE>",
        "\u2008": "<PUNCTUATION_SPACE>",
        "\u2009": "<THIN_SPACE>",
        "\u200A": "<HAIR_SPACE>",
        "\u200B": "<ZERO_WIDTH_SPACE>",
        "\u202F": "<NNBSP>",
        "\u205F": "<MMSP>",
        "\u3000": "<IDEOGRAPHIC_SPACE>",
    }

    def __init__(self, ws: str = " \t\r\n", min: int = 1, max: int = 0, exact: int = 0):
        super().__init__()
        self.matchWhite = ws
        self.set_whitespace_chars(
            "".join(c for c in self.whiteStrs if c not in self.matchWhite),
            copy_defaults=True,
        )
        # self.leave_whitespace()
        self.mayReturnEmpty = True
        self.errmsg = "Expected " + self.name

        self.minLen = min

        if max > 0:
            self.maxLen = max
        else:
            self.maxLen = _MAX_INT

        if exact > 0:
            self.maxLen = exact
            self.minLen = exact

    def _generateDefaultName(self) -> str:
        return "".join(White.whiteStrs[c] for c in self.matchWhite)

    def parseImpl(self, instring, loc, doActions=True):
        if instring[loc] not in self.matchWhite:
            raise ParseException(instring, loc, self.errmsg, self)
        start = loc
        loc += 1
        maxloc = start + self.maxLen
        maxloc = min(maxloc, len(instring))
        while loc < maxloc and instring[loc] in self.matchWhite:
            loc += 1

        if loc - start < self.minLen:
            raise ParseException(instring, loc, self.errmsg, self)

        return loc, instring[start:loc]


class PositionToken(Token):
    def __init__(self):
        super().__init__()
        self.mayReturnEmpty = True
        self.mayIndexError = False


class GoToColumn(PositionToken):
    """Token to advance to a specific column of input text; useful for
    tabular report scraping.
    """

    def __init__(self, colno: int):
        super().__init__()
        self.col = colno

    def preParse(self, instring: str, loc: int) -> int:
        if col(loc, instring) != self.col:
            instrlen = len(instring)
            if self.ignoreExprs:
                loc = self._skipIgnorables(instring, loc)
            while (
                loc < instrlen
                and instring[loc].isspace()
                and col(loc, instring) != self.col
            ):
                loc += 1
        return loc

    def parseImpl(self, instring, loc, doActions=True):
        thiscol = col(loc, instring)
        if thiscol > self.col:
            raise ParseException(instring, loc, "Text not in expected column", self)
        newloc = loc + self.col - thiscol
        ret = instring[loc:newloc]
        return newloc, ret


class LineStart(PositionToken):
    r"""Matches if current position is at the beginning of a line within
    the parse string

    Example::

        test = '''\
        AAA this line
        AAA and this line
          AAA but not this one
        B AAA and definitely not this one
        '''

        for t in (LineStart() + 'AAA' + rest_of_line).search_string(test):
            print(t)

    prints::

        ['AAA', ' this line']
        ['AAA', ' and this line']

    """

    def __init__(self):
        super().__init__()
        self.leave_whitespace()
        self.orig_whiteChars = set() | self.whiteChars
        self.whiteChars.discard("\n")
        self.skipper = Empty().set_whitespace_chars(self.whiteChars)
        self.errmsg = "Expected start of line"

    def preParse(self, instring: str, loc: int) -> int:
        if loc == 0:
            return loc
        else:
            ret = self.skipper.preParse(instring, loc)
            if "\n" in self.orig_whiteChars:
                while instring[ret : ret + 1] == "\n":
                    ret = self.skipper.preParse(instring, ret + 1)
            return ret

    def parseImpl(self, instring, loc, doActions=True):
        if col(loc, instring) == 1:
            return loc, []
        raise ParseException(instring, loc, self.errmsg, self)


class LineEnd(PositionToken):
    """Matches if current position is at the end of a line within the
    parse string
    """

    def __init__(self):
        super().__init__()
        self.whiteChars.discard("\n")
        self.set_whitespace_chars(self.whiteChars, copy_defaults=False)
        self.errmsg = "Expected end of line"

    def parseImpl(self, instring, loc, doActions=True):
        if loc < len(instring):
            if instring[loc] == "\n":
                return loc + 1, "\n"
            else:
                raise ParseException(instring, loc, self.errmsg, self)
        elif loc == len(instring):
            return loc + 1, []
        else:
            raise ParseException(instring, loc, self.errmsg, self)


class StringStart(PositionToken):
    """Matches if current position is at the beginning of the parse
    string
    """

    def __init__(self):
        super().__init__()
        self.errmsg = "Expected start of text"

    def parseImpl(self, instring, loc, doActions=True):
        if loc != 0:
            # see if entire string up to here is just whitespace and ignoreables
            if loc != self.preParse(instring, 0):
                raise ParseException(instring, loc, self.errmsg, self)
        return loc, []


class StringEnd(PositionToken):
    """
    Matches if current position is at the end of the parse string
    """

    def __init__(self):
        super().__init__()
        self.errmsg = "Expected end of text"

    def parseImpl(self, instring, loc, doActions=True):
        if loc < len(instring):
            raise ParseException(instring, loc, self.errmsg, self)
        elif loc == len(instring):
            return loc + 1, []
        elif loc > len(instring):
            return loc, []
        else:
            raise ParseException(instring, loc, self.errmsg, self)


class WordStart(PositionToken):
    """Matches if the current position is at the beginning of a
    :class:`Word`, and is not preceded by any character in a given
    set of ``word_chars`` (default= ``printables``). To emulate the
    ``\b`` behavior of regular expressions, use
    ``WordStart(alphanums)``. ``WordStart`` will also match at
    the beginning of the string being parsed, or at the beginning of
    a line.
    """

    def __init__(self, word_chars: str = printables, *, wordChars: str = printables):
        wordChars = word_chars if wordChars == printables else wordChars
        super().__init__()
        self.wordChars = set(wordChars)
        self.errmsg = "Not at the start of a word"

    def parseImpl(self, instring, loc, doActions=True):
        if loc != 0:
            if (
                instring[loc - 1] in self.wordChars
                or instring[loc] not in self.wordChars
            ):
                raise ParseException(instring, loc, self.errmsg, self)
        return loc, []


class WordEnd(PositionToken):
    """Matches if the current position is at the end of a :class:`Word`,
    and is not followed by any character in a given set of ``word_chars``
    (default= ``printables``). To emulate the ``\b`` behavior of
    regular expressions, use ``WordEnd(alphanums)``. ``WordEnd``
    will also match at the end of the string being parsed, or at the end
    of a line.
    """

    def __init__(self, word_chars: str = printables, *, wordChars: str = printables):
        wordChars = word_chars if wordChars == printables else wordChars
        super().__init__()
        self.wordChars = set(wordChars)
        self.skipWhitespace = False
        self.errmsg = "Not at the end of a word"

    def parseImpl(self, instring, loc, doActions=True):
        instrlen = len(instring)
        if instrlen > 0 and loc < instrlen:
            if (
                instring[loc] in self.wordChars
                or instring[loc - 1] not in self.wordChars
            ):
                raise ParseException(instring, loc, self.errmsg, self)
        return loc, []


class ParseExpression(ParserElement):
    """Abstract subclass of ParserElement, for combining and
    post-processing parsed tokens.
    """

    def __init__(self, exprs: typing.Iterable[ParserElement], savelist: bool = False):
        super().__init__(savelist)
        self.exprs: List[ParserElement]
        if isinstance(exprs, _generatorType):
            exprs = list(exprs)

        if isinstance(exprs, str_type):
            self.exprs = [self._literalStringClass(exprs)]
        elif isinstance(exprs, ParserElement):
            self.exprs = [exprs]
        elif isinstance(exprs, Iterable):
            exprs = list(exprs)
            # if sequence of strings provided, wrap with Literal
            if any(isinstance(expr, str_type) for expr in exprs):
                exprs = (
                    self._literalStringClass(e) if isinstance(e, str_type) else e
                    for e in exprs
                )
            self.exprs = list(exprs)
        else:
            try:
                self.exprs = list(exprs)
            except TypeError:
                self.exprs = [exprs]
        self.callPreparse = False

    def recurse(self) -> List[ParserElement]:
        return self.exprs[:]

    def append(self, other) -> ParserElement:
        self.exprs.append(other)
        self._defaultName = None
        return self

    def leave_whitespace(self, recursive: bool = True) -> ParserElement:
        """
        Extends ``leave_whitespace`` defined in base class, and also invokes ``leave_whitespace`` on
           all contained expressions.
        """
        super().leave_whitespace(recursive)

        if recursive:
            self.exprs = [e.copy() for e in self.exprs]
            for e in self.exprs:
                e.leave_whitespace(recursive)
        return self

    def ignore_whitespace(self, recursive: bool = True) -> ParserElement:
        """
        Extends ``ignore_whitespace`` defined in base class, and also invokes ``leave_whitespace`` on
           all contained expressions.
        """
        super().ignore_whitespace(recursive)
        if recursive:
            self.exprs = [e.copy() for e in self.exprs]
            for e in self.exprs:
                e.ignore_whitespace(recursive)
        return self

    def ignore(self, other) -> ParserElement:
        if isinstance(other, Suppress):
            if other not in self.ignoreExprs:
                super().ignore(other)
                for e in self.exprs:
                    e.ignore(self.ignoreExprs[-1])
        else:
            super().ignore(other)
            for e in self.exprs:
                e.ignore(self.ignoreExprs[-1])
        return self

    def _generateDefaultName(self) -> str:
        return f"{self.__class__.__name__}:({str(self.exprs)})"

    def streamline(self) -> ParserElement:
        if self.streamlined:
            return self

        super().streamline()

        for e in self.exprs:
            e.streamline()

        # collapse nested :class:`And`'s of the form ``And(And(And(a, b), c), d)`` to ``And(a, b, c, d)``
        # but only if there are no parse actions or resultsNames on the nested And's
        # (likewise for :class:`Or`'s and :class:`MatchFirst`'s)
        if len(self.exprs) == 2:
            other = self.exprs[0]
            if (
                isinstance(other, self.__class__)
                and not other.parseAction
                and other.resultsName is None
                and not other.debug
            ):
                self.exprs = other.exprs[:] + [self.exprs[1]]
                self._defaultName = None
                self.mayReturnEmpty |= other.mayReturnEmpty
                self.mayIndexError |= other.mayIndexError

            other = self.exprs[-1]
            if (
                isinstance(other, self.__class__)
                and not other.parseAction
                and other.resultsName is None
                and not other.debug
            ):
                self.exprs = self.exprs[:-1] + other.exprs[:]
                self._defaultName = None
                self.mayReturnEmpty |= other.mayReturnEmpty
                self.mayIndexError |= other.mayIndexError

        self.errmsg = "Expected " + str(self)

        return self

    def validate(self, validateTrace=None) -> None:
        warnings.warn(
            "ParserElement.validate() is deprecated, and should not be used to check for left recursion",
            DeprecationWarning,
            stacklevel=2,
        )
        tmp = (validateTrace if validateTrace is not None else [])[:] + [self]
        for e in self.exprs:
            e.validate(tmp)
        self._checkRecursion([])

    def copy(self) -> ParserElement:
        ret = super().copy()
        ret = typing.cast(ParseExpression, ret)
        ret.exprs = [e.copy() for e in self.exprs]
        return ret

    def _setResultsName(self, name, listAllMatches=False):
        if (
            __diag__.warn_ungrouped_named_tokens_in_collection
            and Diagnostics.warn_ungrouped_named_tokens_in_collection
            not in self.suppress_warnings_
        ):
            for e in self.exprs:
                if (
                    isinstance(e, ParserElement)
                    and e.resultsName
                    and Diagnostics.warn_ungrouped_named_tokens_in_collection
                    not in e.suppress_warnings_
                ):
                    warnings.warn(
                        "{}: setting results name {!r} on {} expression "
                        "collides with {!r} on contained expression".format(
                            "warn_ungrouped_named_tokens_in_collection",
                            name,
                            type(self).__name__,
                            e.resultsName,
                        ),
                        stacklevel=3,
                    )

        return super()._setResultsName(name, listAllMatches)

    # Compatibility synonyms
    # fmt: off
    @replaced_by_pep8(leave_whitespace)
    def leaveWhitespace(self): ...

    @replaced_by_pep8(ignore_whitespace)
    def ignoreWhitespace(self): ...
    # fmt: on


class And(ParseExpression):
    """
    Requires all given :class:`ParseExpression` s to be found in the given order.
    Expressions may be separated by whitespace.
    May be constructed using the ``'+'`` operator.
    May also be constructed using the ``'-'`` operator, which will
    suppress backtracking.

    Example::

        integer = Word(nums)
        name_expr = Word(alphas)[1, ...]

        expr = And([integer("id"), name_expr("name"), integer("age")])
        # more easily written as:
        expr = integer("id") + name_expr("name") + integer("age")
    """

    class _ErrorStop(Empty):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.leave_whitespace()

        def _generateDefaultName(self) -> str:
            return "-"

    def __init__(
        self, exprs_arg: typing.Iterable[ParserElement], savelist: bool = True
    ):
        exprs: List[ParserElement] = list(exprs_arg)
        if exprs and Ellipsis in exprs:
            tmp = []
            for i, expr in enumerate(exprs):
                if expr is Ellipsis:
                    if i < len(exprs) - 1:
                        skipto_arg: ParserElement = typing.cast(
                            ParseExpression, (Empty() + exprs[i + 1])
                        ).exprs[-1]
                        tmp.append(SkipTo(skipto_arg)("_skipped*"))
                    else:
                        raise Exception(
                            "cannot construct And with sequence ending in ..."
                        )
                else:
                    tmp.append(expr)
            exprs[:] = tmp
        super().__init__(exprs, savelist)
        if self.exprs:
            self.mayReturnEmpty = all(e.mayReturnEmpty for e in self.exprs)
            if not isinstance(self.exprs[0], White):
                self.set_whitespace_chars(
                    self.exprs[0].whiteChars,
                    copy_defaults=self.exprs[0].copyDefaultWhiteChars,
                )
                self.skipWhitespace = self.exprs[0].skipWhitespace
            else:
                self.skipWhitespace = False
        else:
            self.mayReturnEmpty = True
        self.callPreparse = True

    def streamline(self) -> ParserElement:
        # collapse any _PendingSkip's
        if self.exprs:
            if any(
                isinstance(e, ParseExpression)
                and e.exprs
                and isinstance(e.exprs[-1], _PendingSkip)
                for e in self.exprs[:-1]
            ):
                deleted_expr_marker = NoMatch()
                for i, e in enumerate(self.exprs[:-1]):
                    if e is deleted_expr_marker:
                        continue
                    if (
                        isinstance(e, ParseExpression)
                        and e.exprs
                        and isinstance(e.exprs[-1], _PendingSkip)
                    ):
                        e.exprs[-1] = e.exprs[-1] + self.exprs[i + 1]
                        self.exprs[i + 1] = deleted_expr_marker
                self.exprs = [e for e in self.exprs if e is not deleted_expr_marker]

        super().streamline()

        # link any IndentedBlocks to the prior expression
        prev: ParserElement
        cur: ParserElement
        for prev, cur in zip(self.exprs, self.exprs[1:]):
            # traverse cur or any first embedded expr of cur looking for an IndentedBlock
            # (but watch out for recursive grammar)
            seen = set()
            while True:
                if id(cur) in seen:
                    break
                seen.add(id(cur))
                if isinstance(cur, IndentedBlock):
                    prev.add_parse_action(
                        lambda s, l, t, cur_=cur: setattr(
                            cur_, "parent_anchor", col(l, s)
                        )
                    )
                    break
                subs = cur.recurse()
                next_first = next(iter(subs), None)
                if next_first is None:
                    break
                cur = typing.cast(ParserElement, next_first)

        self.mayReturnEmpty = all(e.mayReturnEmpty for e in self.exprs)
        return self

    def parseImpl(self, instring, loc, doActions=True):
        # pass False as callPreParse arg to _parse for first element, since we already
        # pre-parsed the string as part of our And pre-parsing
        loc, resultlist = self.exprs[0]._parse(
            instring, loc, doActions, callPreParse=False
        )
        errorStop = False
        for e in self.exprs[1:]:
            # if isinstance(e, And._ErrorStop):
            if type(e) is And._ErrorStop:
                errorStop = True
                continue
            if errorStop:
                try:
                    loc, exprtokens = e._parse(instring, loc, doActions)
                except ParseSyntaxException:
                    raise
                except ParseBaseException as pe:
                    pe.__traceback__ = None
                    raise ParseSyntaxException._from_exception(pe)
                except IndexError:
                    raise ParseSyntaxException(
                        instring, len(instring), self.errmsg, self
                    )
            else:
                loc, exprtokens = e._parse(instring, loc, doActions)
            resultlist += exprtokens
        return loc, resultlist

    def __iadd__(self, other):
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return self.append(other)  # And([self, other])

    def _checkRecursion(self, parseElementList):
        subRecCheckList = parseElementList[:] + [self]
        for e in self.exprs:
            e._checkRecursion(subRecCheckList)
            if not e.mayReturnEmpty:
                break

    def _generateDefaultName(self) -> str:
        inner = " ".join(str(e) for e in self.exprs)
        # strip off redundant inner {}'s
        while len(inner) > 1 and inner[0 :: len(inner) - 1] == "{}":
            inner = inner[1:-1]
        return "{" + inner + "}"


class Or(ParseExpression):
    """Requires that at least one :class:`ParseExpression` is found. If
    two expressions match, the expression that matches the longest
    string will be used. May be constructed using the ``'^'``
    operator.

    Example::

        # construct Or using '^' operator

        number = Word(nums) ^ Combine(Word(nums) + '.' + Word(nums))
        print(number.search_string("123 3.1416 789"))

    prints::

        [['123'], ['3.1416'], ['789']]
    """

    def __init__(self, exprs: typing.Iterable[ParserElement], savelist: bool = False):
        super().__init__(exprs, savelist)
        if self.exprs:
            self.mayReturnEmpty = any(e.mayReturnEmpty for e in self.exprs)
            self.skipWhitespace = all(e.skipWhitespace for e in self.exprs)
        else:
            self.mayReturnEmpty = True

    def streamline(self) -> ParserElement:
        super().streamline()
        if self.exprs:
            self.mayReturnEmpty = any(e.mayReturnEmpty for e in self.exprs)
            self.saveAsList = any(e.saveAsList for e in self.exprs)
            self.skipWhitespace = all(
                e.skipWhitespace and not isinstance(e, White) for e in self.exprs
            )
        else:
            self.saveAsList = False
        return self

    def parseImpl(self, instring, loc, doActions=True):
        maxExcLoc = -1
        maxException = None
        matches = []
        fatals = []
        if all(e.callPreparse for e in self.exprs):
            loc = self.preParse(instring, loc)
        for e in self.exprs:
            try:
                loc2 = e.try_parse(instring, loc, raise_fatal=True)
            except ParseFatalException as pfe:
                pfe.__traceback__ = None
                pfe.parser_element = e
                fatals.append(pfe)
                maxException = None
                maxExcLoc = -1
            except ParseException as err:
                if not fatals:
                    err.__traceback__ = None
                    if err.loc > maxExcLoc:
                        maxException = err
                        maxExcLoc = err.loc
            except IndexError:
                if len(instring) > maxExcLoc:
                    maxException = ParseException(
                        instring, len(instring), e.errmsg, self
                    )
                    maxExcLoc = len(instring)
            else:
                # save match among all matches, to retry longest to shortest
                matches.append((loc2, e))

        if matches:
            # re-evaluate all matches in descending order of length of match, in case attached actions
            # might change whether or how much they match of the input.
            matches.sort(key=itemgetter(0), reverse=True)

            if not doActions:
                # no further conditions or parse actions to change the selection of
                # alternative, so the first match will be the best match
                best_expr = matches[0][1]
                return best_expr._parse(instring, loc, doActions)

            longest = -1, None
            for loc1, expr1 in matches:
                if loc1 <= longest[0]:
                    # already have a longer match than this one will deliver, we are done
                    return longest

                try:
                    loc2, toks = expr1._parse(instring, loc, doActions)
                except ParseException as err:
                    err.__traceback__ = None
                    if err.loc > maxExcLoc:
                        maxException = err
                        maxExcLoc = err.loc
                else:
                    if loc2 >= loc1:
                        return loc2, toks
                    # didn't match as much as before
                    elif loc2 > longest[0]:
                        longest = loc2, toks

            if longest != (-1, None):
                return longest

        if fatals:
            if len(fatals) > 1:
                fatals.sort(key=lambda e: -e.loc)
                if fatals[0].loc == fatals[1].loc:
                    fatals.sort(key=lambda e: (-e.loc, -len(str(e.parser_element))))
            max_fatal = fatals[0]
            raise max_fatal

        if maxException is not None:
            # infer from this check that all alternatives failed at the current position
            # so emit this collective error message instead of any single error message
            if maxExcLoc == loc:
                maxException.msg = self.errmsg
            raise maxException
        else:
            raise ParseException(
                instring, loc, "no defined alternatives to match", self
            )

    def __ixor__(self, other):
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return self.append(other)  # Or([self, other])

    def _generateDefaultName(self) -> str:
        return "{" + " ^ ".join(str(e) for e in self.exprs) + "}"

    def _setResultsName(self, name, listAllMatches=False):
        if (
            __diag__.warn_multiple_tokens_in_named_alternation
            and Diagnostics.warn_multiple_tokens_in_named_alternation
            not in self.suppress_warnings_
        ):
            if any(
                isinstance(e, And)
                and Diagnostics.warn_multiple_tokens_in_named_alternation
                not in e.suppress_warnings_
                for e in self.exprs
            ):
                warnings.warn(
                    "{}: setting results name {!r} on {} expression "
                    "will return a list of all parsed tokens in an And alternative, "
                    "in prior versions only the first token was returned; enclose "
                    "contained argument in Group".format(
                        "warn_multiple_tokens_in_named_alternation",
                        name,
                        type(self).__name__,
                    ),
                    stacklevel=3,
                )

        return super()._setResultsName(name, listAllMatches)


class MatchFirst(ParseExpression):
    """Requires that at least one :class:`ParseExpression` is found. If
    more than one expression matches, the first one listed is the one that will
    match. May be constructed using the ``'|'`` operator.

    Example::

        # construct MatchFirst using '|' operator

        # watch the order of expressions to match
        number = Word(nums) | Combine(Word(nums) + '.' + Word(nums))
        print(number.search_string("123 3.1416 789")) #  Fail! -> [['123'], ['3'], ['1416'], ['789']]

        # put more selective expression first
        number = Combine(Word(nums) + '.' + Word(nums)) | Word(nums)
        print(number.search_string("123 3.1416 789")) #  Better -> [['123'], ['3.1416'], ['789']]
    """

    def __init__(self, exprs: typing.Iterable[ParserElement], savelist: bool = False):
        super().__init__(exprs, savelist)
        if self.exprs:
            self.mayReturnEmpty = any(e.mayReturnEmpty for e in self.exprs)
            self.skipWhitespace = all(e.skipWhitespace for e in self.exprs)
        else:
            self.mayReturnEmpty = True

    def streamline(self) -> ParserElement:
        if self.streamlined:
            return self

        super().streamline()
        if self.exprs:
            self.saveAsList = any(e.saveAsList for e in self.exprs)
            self.mayReturnEmpty = any(e.mayReturnEmpty for e in self.exprs)
            self.skipWhitespace = all(
                e.skipWhitespace and not isinstance(e, White) for e in self.exprs
            )
        else:
            self.saveAsList = False
            self.mayReturnEmpty = True
        return self

    def parseImpl(self, instring, loc, doActions=True):
        maxExcLoc = -1
        maxException = None

        for e in self.exprs:
            try:
                return e._parse(
                    instring,
                    loc,
                    doActions,
                )
            except ParseFatalException as pfe:
                pfe.__traceback__ = None
                pfe.parser_element = e
                raise
            except ParseException as err:
                if err.loc > maxExcLoc:
                    maxException = err
                    maxExcLoc = err.loc
            except IndexError:
                if len(instring) > maxExcLoc:
                    maxException = ParseException(
                        instring, len(instring), e.errmsg, self
                    )
                    maxExcLoc = len(instring)

        if maxException is not None:
            # infer from this check that all alternatives failed at the current position
            # so emit this collective error message instead of any individual error message
            if maxExcLoc == loc:
                maxException.msg = self.errmsg
            raise maxException
        else:
            raise ParseException(
                instring, loc, "no defined alternatives to match", self
            )

    def __ior__(self, other):
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return self.append(other)  # MatchFirst([self, other])

    def _generateDefaultName(self) -> str:
        return "{" + " | ".join(str(e) for e in self.exprs) + "}"

    def _setResultsName(self, name, listAllMatches=False):
        if (
            __diag__.warn_multiple_tokens_in_named_alternation
            and Diagnostics.warn_multiple_tokens_in_named_alternation
            not in self.suppress_warnings_
        ):
            if any(
                isinstance(e, And)
                and Diagnostics.warn_multiple_tokens_in_named_alternation
                not in e.suppress_warnings_
                for e in self.exprs
            ):
                warnings.warn(
                    "{}: setting results name {!r} on {} expression "
                    "will return a list of all parsed tokens in an And alternative, "
                    "in prior versions only the first token was returned; enclose "
                    "contained argument in Group".format(
                        "warn_multiple_tokens_in_named_alternation",
                        name,
                        type(self).__name__,
                    ),
                    stacklevel=3,
                )

        return super()._setResultsName(name, listAllMatches)


class Each(ParseExpression):
    """Requires all given :class:`ParseExpression` s to be found, but in
    any order. Expressions may be separated by whitespace.

    May be constructed using the ``'&'`` operator.

    Example::

        color = one_of("RED ORANGE YELLOW GREEN BLUE PURPLE BLACK WHITE BROWN")
        shape_type = one_of("SQUARE CIRCLE TRIANGLE STAR HEXAGON OCTAGON")
        integer = Word(nums)
        shape_attr = "shape:" + shape_type("shape")
        posn_attr = "posn:" + Group(integer("x") + ',' + integer("y"))("posn")
        color_attr = "color:" + color("color")
        size_attr = "size:" + integer("size")

        # use Each (using operator '&') to accept attributes in any order
        # (shape and posn are required, color and size are optional)
        shape_spec = shape_attr & posn_attr & Opt(color_attr) & Opt(size_attr)

        shape_spec.run_tests('''
            shape: SQUARE color: BLACK posn: 100, 120
            shape: CIRCLE size: 50 color: BLUE posn: 50,80
            color:GREEN size:20 shape:TRIANGLE posn:20,40
            '''
            )

    prints::

        shape: SQUARE color: BLACK posn: 100, 120
        ['shape:', 'SQUARE', 'color:', 'BLACK', 'posn:', ['100', ',', '120']]
        - color: BLACK
        - posn: ['100', ',', '120']
          - x: 100
          - y: 120
        - shape: SQUARE


        shape: CIRCLE size: 50 color: BLUE posn: 50,80
        ['shape:', 'CIRCLE', 'size:', '50', 'color:', 'BLUE', 'posn:', ['50', ',', '80']]
        - color: BLUE
        - posn: ['50', ',', '80']
          - x: 50
          - y: 80
        - shape: CIRCLE
        - size: 50


        color: GREEN size: 20 shape: TRIANGLE posn: 20,40
        ['color:', 'GREEN', 'size:', '20', 'shape:', 'TRIANGLE', 'posn:', ['20', ',', '40']]
        - color: GREEN
        - posn: ['20', ',', '40']
          - x: 20
          - y: 40
        - shape: TRIANGLE
        - size: 20
    """

    def __init__(self, exprs: typing.Iterable[ParserElement], savelist: bool = True):
        super().__init__(exprs, savelist)
        if self.exprs:
            self.mayReturnEmpty = all(e.mayReturnEmpty for e in self.exprs)
        else:
            self.mayReturnEmpty = True
        self.skipWhitespace = True
        self.initExprGroups = True
        self.saveAsList = True

    def __iand__(self, other):
        if isinstance(other, str_type):
            other = self._literalStringClass(other)
        if not isinstance(other, ParserElement):
            return NotImplemented
        return self.append(other)  # Each([self, other])

    def streamline(self) -> ParserElement:
        super().streamline()
        if self.exprs:
            self.mayReturnEmpty = all(e.mayReturnEmpty for e in self.exprs)
        else:
            self.mayReturnEmpty = True
        return self

    def parseImpl(self, instring, loc, doActions=True):
        if self.initExprGroups:
            self.opt1map = dict(
                (id(e.expr), e) for e in self.exprs if isinstance(e, Opt)
            )
            opt1 = [e.expr for e in self.exprs if isinstance(e, Opt)]
            opt2 = [
                e
                for e in self.exprs
                if e.mayReturnEmpty and not isinstance(e, (Opt, Regex, ZeroOrMore))
            ]
            self.optionals = opt1 + opt2
            self.multioptionals = [
                e.expr.set_results_name(e.resultsName, list_all_matches=True)
                for e in self.exprs
                if isinstance(e, _MultipleMatch)
            ]
            self.multirequired = [
                e.expr.set_results_name(e.resultsName, list_all_matches=True)
                for e in self.exprs
                if isinstance(e, OneOrMore)
            ]
            self.required = [
                e for e in self.exprs if not isinstance(e, (Opt, ZeroOrMore, OneOrMore))
            ]
            self.required += self.multirequired
            self.initExprGroups = False

        tmpLoc = loc
        tmpReqd = self.required[:]
        tmpOpt = self.optionals[:]
        multis = self.multioptionals[:]
        matchOrder = []

        keepMatching = True
        failed = []
        fatals = []
        while keepMatching:
            tmpExprs = tmpReqd + tmpOpt + multis
            failed.clear()
            fatals.clear()
            for e in tmpExprs:
                try:
                    tmpLoc = e.try_parse(instring, tmpLoc, raise_fatal=True)
                except ParseFatalException as pfe:
                    pfe.__traceback__ = None
                    pfe.parser_element = e
                    fatals.append(pfe)
                    failed.append(e)
                except ParseException:
                    failed.append(e)
                else:
                    matchOrder.append(self.opt1map.get(id(e), e))
                    if e in tmpReqd:
                        tmpReqd.remove(e)
                    elif e in tmpOpt:
                        tmpOpt.remove(e)
            if len(failed) == len(tmpExprs):
                keepMatching = False

        # look for any ParseFatalExceptions
        if fatals:
            if len(fatals) > 1:
                fatals.sort(key=lambda e: -e.loc)
                if fatals[0].loc == fatals[1].loc:
                    fatals.sort(key=lambda e: (-e.loc, -len(str(e.parser_element))))
            max_fatal = fatals[0]
            raise max_fatal

        if tmpReqd:
            missing = ", ".join([str(e) for e in tmpReqd])
            raise ParseException(
                instring,
                loc,
                f"Missing one or more required elements ({missing})",
            )

        # add any unmatched Opts, in case they have default values defined
        matchOrder += [e for e in self.exprs if isinstance(e, Opt) and e.expr in tmpOpt]

        total_results = ParseResults([])
        for e in matchOrder:
            loc, results = e._parse(instring, loc, doActions)
            total_results += results

        return loc, total_results

    def _generateDefaultName(self) -> str:
        return "{" + " & ".join(str(e) for e in self.exprs) + "}"


class ParseElementEnhance(ParserElement):
    """Abstract subclass of :class:`ParserElement`, for combining and
    post-processing parsed tokens.
    """

    def __init__(self, expr: Union[ParserElement, str], savelist: bool = False):
        super().__init__(savelist)
        if isinstance(expr, str_type):
            expr_str = typing.cast(str, expr)
            if issubclass(self._literalStringClass, Token):
                expr = self._literalStringClass(expr_str)  # type: ignore[call-arg]
            elif issubclass(type(self), self._literalStringClass):
                expr = Literal(expr_str)
            else:
                expr = self._literalStringClass(Literal(expr_str))  # type: ignore[assignment, call-arg]
        expr = typing.cast(ParserElement, expr)
        self.expr = expr
        if expr is not None:
            self.mayIndexError = expr.mayIndexError
            self.mayReturnEmpty = expr.mayReturnEmpty
            self.set_whitespace_chars(
                expr.whiteChars, copy_defaults=expr.copyDefaultWhiteChars
            )
            self.skipWhitespace = expr.skipWhitespace
            self.saveAsList = expr.saveAsList
            self.callPreparse = expr.callPreparse
            self.ignoreExprs.extend(expr.ignoreExprs)

    def recurse(self) -> List[ParserElement]:
        return [self.expr] if self.expr is not None else []

    def parseImpl(self, instring, loc, doActions=True):
        if self.expr is not None:
            try:
                return self.expr._parse(instring, loc, doActions, callPreParse=False)
            except ParseBaseException as pbe:
                pbe.msg = self.errmsg
                raise
        else:
            raise ParseException(instring, loc, "No expression defined", self)

    def leave_whitespace(self, recursive: bool = True) -> ParserElement:
        super().leave_whitespace(recursive)

        if recursive:
            if self.expr is not None:
                self.expr = self.expr.copy()
                self.expr.leave_whitespace(recursive)
        return self

    def ignore_whitespace(self, recursive: bool = True) -> ParserElement:
        super().ignore_whitespace(recursive)

        if recursive:
            if self.expr is not None:
                self.expr = self.expr.copy()
                self.expr.ignore_whitespace(recursive)
        return self

    def ignore(self, other) -> ParserElement:
        if isinstance(other, Suppress):
            if other not in self.ignoreExprs:
                super().ignore(other)
                if self.expr is not None:
                    self.expr.ignore(self.ignoreExprs[-1])
        else:
            super().ignore(other)
            if self.expr is not None:
                self.expr.ignore(self.ignoreExprs[-1])
        return self

    def streamline(self) -> ParserElement:
        super().streamline()
        if self.expr is not None:
            self.expr.streamline()
        return self

    def _checkRecursion(self, parseElementList):
        if self in parseElementList:
            raise RecursiveGrammarException(parseElementList + [self])
        subRecCheckList = parseElementList[:] + [self]
        if self.expr is not None:
            self.expr._checkRecursion(subRecCheckList)

    def validate(self, validateTrace=None) -> None:
        warnings.warn(
            "ParserElement.validate() is deprecated, and should not be used to check for left recursion",
            DeprecationWarning,
            stacklevel=2,
        )
        if validateTrace is None:
            validateTrace = []
        tmp = validateTrace[:] + [self]
        if self.expr is not None:
            self.expr.validate(tmp)
        self._checkRecursion([])

    def _generateDefaultName(self) -> str:
        return f"{self.__class__.__name__}:({str(self.expr)})"

    # Compatibility synonyms
    # fmt: off
    @replaced_by_pep8(leave_whitespace)
    def leaveWhitespace(self): ...

    @replaced_by_pep8(ignore_whitespace)
    def ignoreWhitespace(self): ...
    # fmt: on


class IndentedBlock(ParseElementEnhance):
    """
    Expression to match one or more expressions at a given indentation level.
    Useful for parsing text where structure is implied by indentation (like Python source code).
    """

    class _Indent(Empty):
        def __init__(self, ref_col: int):
            super().__init__()
            self.errmsg = f"expected indent at column {ref_col}"
            self.add_condition(lambda s, l, t: col(l, s) == ref_col)

    class _IndentGreater(Empty):
        def __init__(self, ref_col: int):
            super().__init__()
            self.errmsg = f"expected indent at column greater than {ref_col}"
            self.add_condition(lambda s, l, t: col(l, s) > ref_col)

    def __init__(
        self, expr: ParserElement, *, recursive: bool = False, grouped: bool = True
    ):
        super().__init__(expr, savelist=True)
        # if recursive:
        #     raise NotImplementedError("IndentedBlock with recursive is not implemented")
        self._recursive = recursive
        self._grouped = grouped
        self.parent_anchor = 1

    def parseImpl(self, instring, loc, doActions=True):
        # advance parse position to non-whitespace by using an Empty()
        # this should be the column to be used for all subsequent indented lines
        anchor_loc = Empty().preParse(instring, loc)

        # see if self.expr matches at the current location - if not it will raise an exception
        # and no further work is necessary
        self.expr.try_parse(instring, anchor_loc, do_actions=doActions)

        indent_col = col(anchor_loc, instring)
        peer_detect_expr = self._Indent(indent_col)

        inner_expr = Empty() + peer_detect_expr + self.expr
        if self._recursive:
            sub_indent = self._IndentGreater(indent_col)
            nested_block = IndentedBlock(
                self.expr, recursive=self._recursive, grouped=self._grouped
            )
            nested_block.set_debug(self.debug)
            nested_block.parent_anchor = indent_col
            inner_expr += Opt(sub_indent + nested_block)

        inner_expr.set_name(f"inner {hex(id(inner_expr))[-4:].upper()}@{indent_col}")
        block = OneOrMore(inner_expr)

        trailing_undent = self._Indent(self.parent_anchor) | StringEnd()

        if self._grouped:
            wrapper = Group
        else:
            wrapper = lambda expr: expr
        return (wrapper(block) + Optional(trailing_undent)).parseImpl(
            instring, anchor_loc, doActions
        )


class AtStringStart(ParseElementEnhance):
    """Matches if expression matches at the beginning of the parse
    string::

        AtStringStart(Word(nums)).parse_string("123")
        # prints ["123"]

        AtStringStart(Word(nums)).parse_string("    123")
        # raises ParseException
    """

    def __init__(self, expr: Union[ParserElement, str]):
        super().__init__(expr)
        self.callPreparse = False

    def parseImpl(self, instring, loc, doActions=True):
        if loc != 0:
            raise ParseException(instring, loc, "not found at string start")
        return super().parseImpl(instring, loc, doActions)


class AtLineStart(ParseElementEnhance):
    r"""Matches if an expression matches at the beginning of a line within
    the parse string

    Example::

        test = '''\
        AAA this line
        AAA and this line
          AAA but not this one
        B AAA and definitely not this one
        '''

        for t in (AtLineStart('AAA') + rest_of_line).search_string(test):
            print(t)

    prints::

        ['AAA', ' this line']
        ['AAA', ' and this line']

    """

    def __init__(self, expr: Union[ParserElement, str]):
        super().__init__(expr)
        self.callPreparse = False

    def parseImpl(self, instring, loc, doActions=True):
        if col(loc, instring) != 1:
            raise ParseException(instring, loc, "not found at line start")
        return super().parseImpl(instring, loc, doActions)


class FollowedBy(ParseElementEnhance):
    """Lookahead matching of the given parse expression.
    ``FollowedBy`` does *not* advance the parsing position within
    the input string, it only verifies that the specified parse
    expression matches at the current position.  ``FollowedBy``
    always returns a null token list. If any results names are defined
    in the lookahead expression, those *will* be returned for access by
    name.

    Example::

        # use FollowedBy to match a label only if it is followed by a ':'
        data_word = Word(alphas)
        label = data_word + FollowedBy(':')
        attr_expr = Group(label + Suppress(':') + OneOrMore(data_word, stop_on=label).set_parse_action(' '.join))

        attr_expr[1, ...].parse_string("shape: SQUARE color: BLACK posn: upper left").pprint()

    prints::

        [['shape', 'SQUARE'], ['color', 'BLACK'], ['posn', 'upper left']]
    """

    def __init__(self, expr: Union[ParserElement, str]):
        super().__init__(expr)
        self.mayReturnEmpty = True

    def parseImpl(self, instring, loc, doActions=True):
        # by using self._expr.parse and deleting the contents of the returned ParseResults list
        # we keep any named results that were defined in the FollowedBy expression
        _, ret = self.expr._parse(instring, loc, doActions=doActions)
        del ret[:]

        return loc, ret


class PrecededBy(ParseElementEnhance):
    """Lookbehind matching of the given parse expression.
    ``PrecededBy`` does not advance the parsing position within the
    input string, it only verifies that the specified parse expression
    matches prior to the current position.  ``PrecededBy`` always
    returns a null token list, but if a results name is defined on the
    given expression, it is returned.

    Parameters:

    - ``expr`` - expression that must match prior to the current parse
      location
    - ``retreat`` - (default= ``None``) - (int) maximum number of characters
      to lookbehind prior to the current parse location

    If the lookbehind expression is a string, :class:`Literal`,
    :class:`Keyword`, or a :class:`Word` or :class:`CharsNotIn`
    with a specified exact or maximum length, then the retreat
    parameter is not required. Otherwise, retreat must be specified to
    give a maximum number of characters to look back from
    the current parse position for a lookbehind match.

    Example::

        # VB-style variable names with type prefixes
        int_var = PrecededBy("#") + pyparsing_common.identifier
        str_var = PrecededBy("$") + pyparsing_common.identifier

    """

    def __init__(
        self, expr: Union[ParserElement, str], retreat: typing.Optional[int] = None
    ):
        super().__init__(expr)
        self.expr = self.expr().leave_whitespace()
        self.mayReturnEmpty = True
        self.mayIndexError = False
        self.exact = False
        if isinstance(expr, str_type):
            expr = typing.cast(str, expr)
            retreat = len(expr)
            self.exact = True
        elif isinstance(expr, (Literal, Keyword)):
            retreat = expr.matchLen
            self.exact = True
        elif isinstance(expr, (Word, CharsNotIn)) and expr.maxLen != _MAX_INT:
            retreat = expr.maxLen
            self.exact = True
        elif isinstance(expr, PositionToken):
            retreat = 0
            self.exact = True
        self.retreat = retreat
        self.errmsg = "not preceded by " + str(expr)
        self.skipWhitespace = False
        self.parseAction.append(lambda s, l, t: t.__delitem__(slice(None, None)))

    def parseImpl(self, instring, loc=0, doActions=True):
        if self.exact:
            if loc < self.retreat:
                raise ParseException(instring, loc, self.errmsg)
            start = loc - self.retreat
            _, ret = self.expr._parse(instring, start)
        else:
            # retreat specified a maximum lookbehind window, iterate
            test_expr = self.expr + StringEnd()
            instring_slice = instring[max(0, loc - self.retreat) : loc]
            last_expr = ParseException(instring, loc, self.errmsg)
            for offset in range(1, min(loc, self.retreat + 1) + 1):
                try:
                    # print('trying', offset, instring_slice, repr(instring_slice[loc - offset:]))
                    _, ret = test_expr._parse(
                        instring_slice, len(instring_slice) - offset
                    )
                except ParseBaseException as pbe:
                    last_expr = pbe
                else:
                    break
            else:
                raise last_expr
        return loc, ret


class Located(ParseElementEnhance):
    """
    Decorates a returned token with its starting and ending
    locations in the input string.

    This helper adds the following results names:

    - ``locn_start`` - location where matched expression begins
    - ``locn_end`` - location where matched expression ends
    - ``value`` - the actual parsed results

    Be careful if the input text contains ``<TAB>`` characters, you
    may want to call :class:`ParserElement.parse_with_tabs`

    Example::

        wd = Word(alphas)
        for match in Located(wd).search_string("ljsdf123lksdjjf123lkkjj1222"):
            print(match)

    prints::

        [0, ['ljsdf'], 5]
        [8, ['lksdjjf'], 15]
        [18, ['lkkjj'], 23]

    """

    def parseImpl(self, instring, loc, doActions=True):
        start = loc
        loc, tokens = self.expr._parse(instring, start, doActions, callPreParse=False)
        ret_tokens = ParseResults([start, tokens, loc])
        ret_tokens["locn_start"] = start
        ret_tokens["value"] = tokens
        ret_tokens["locn_end"] = loc
        if self.resultsName:
            # must return as a list, so that the name will be attached to the complete group
            return loc, [ret_tokens]
        else:
            return loc, ret_tokens


class NotAny(ParseElementEnhance):
    """
    Lookahead to disallow matching with the given parse expression.
    ``NotAny`` does *not* advance the parsing position within the
    input string, it only verifies that the specified parse expression
    does *not* match at the current position.  Also, ``NotAny`` does
    *not* skip over leading whitespace. ``NotAny`` always returns
    a null token list.  May be constructed using the ``'~'`` operator.

    Example::

        AND, OR, NOT = map(CaselessKeyword, "AND OR NOT".split())

        # take care not to mistake keywords for identifiers
        ident = ~(AND | OR | NOT) + Word(alphas)
        boolean_term = Opt(NOT) + ident

        # very crude boolean expression - to support parenthesis groups and
        # operation hierarchy, use infix_notation
        boolean_expr = boolean_term + ((AND | OR) + boolean_term)[...]

        # integers that are followed by "." are actually floats
        integer = Word(nums) + ~Char(".")
    """

    def __init__(self, expr: Union[ParserElement, str]):
        super().__init__(expr)
        # do NOT use self.leave_whitespace(), don't want to propagate to exprs
        # self.leave_whitespace()
        self.skipWhitespace = False

        self.mayReturnEmpty = True
        self.errmsg = "Found unwanted token, " + str(self.expr)

    def parseImpl(self, instring, loc, doActions=True):
        if self.expr.can_parse_next(instring, loc, do_actions=doActions):
            raise ParseException(instring, loc, self.errmsg, self)
        return loc, []

    def _generateDefaultName(self) -> str:
        return "~{" + str(self.expr) + "}"


class _MultipleMatch(ParseElementEnhance):
    def __init__(
        self,
        expr: Union[str, ParserElement],
        stop_on: typing.Optional[Union[ParserElement, str]] = None,
        *,
        stopOn: typing.Optional[Union[ParserElement, str]] = None,
    ):
        super().__init__(expr)
        stopOn = stopOn or stop_on
        self.saveAsList = True
        ender = stopOn
        if isinstance(ender, str_type):
            ender = self._literalStringClass(ender)
        self.stopOn(ender)

    def stopOn(self, ender) -> ParserElement:
        if isinstance(ender, str_type):
            ender = self._literalStringClass(ender)
        self.not_ender = ~ender if ender is not None else None
        return self

    def parseImpl(self, instring, loc, doActions=True):
        self_expr_parse = self.expr._parse
        self_skip_ignorables = self._skipIgnorables
        check_ender = self.not_ender is not None
        if check_ender:
            try_not_ender = self.not_ender.try_parse

        # must be at least one (but first see if we are the stopOn sentinel;
        # if so, fail)
        if check_ender:
            try_not_ender(instring, loc)
        loc, tokens = self_expr_parse(instring, loc, doActions)
        try:
            hasIgnoreExprs = not not self.ignoreExprs
            while 1:
                if check_ender:
                    try_not_ender(instring, loc)
                if hasIgnoreExprs:
                    preloc = self_skip_ignorables(instring, loc)
                else:
                    preloc = loc
                loc, tmptokens = self_expr_parse(instring, preloc, doActions)
                tokens += tmptokens
        except (ParseException, IndexError):
            pass

        return loc, tokens

    def _setResultsName(self, name, listAllMatches=False):
        if (
            __diag__.warn_ungrouped_named_tokens_in_collection
            and Diagnostics.warn_ungrouped_named_tokens_in_collection
            not in self.suppress_warnings_
        ):
            for e in [self.expr] + self.expr.recurse():
                if (
                    isinstance(e, ParserElement)
                    and e.resultsName
                    and Diagnostics.warn_ungrouped_named_tokens_in_collection
                    not in e.suppress_warnings_
                ):
                    warnings.warn(
                        "{}: setting results name {!r} on {} expression "
                        "collides with {!r} on contained expression".format(
                            "warn_ungrouped_named_tokens_in_collection",
                            name,
                            type(self).__name__,
                            e.resultsName,
                        ),
                        stacklevel=3,
                    )

        return super()._setResultsName(name, listAllMatches)


class OneOrMore(_MultipleMatch):
    """
    Repetition of one or more of the given expression.

    Parameters:

    - ``expr`` - expression that must match one or more times
    - ``stop_on`` - (default= ``None``) - expression for a terminating sentinel
      (only required if the sentinel would ordinarily match the repetition
      expression)

    Example::

        data_word = Word(alphas)
        label = data_word + FollowedBy(':')
        attr_expr = Group(label + Suppress(':') + OneOrMore(data_word).set_parse_action(' '.join))

        text = "shape: SQUARE posn: upper left color: BLACK"
        attr_expr[1, ...].parse_string(text).pprint()  # Fail! read 'color' as data instead of next label -> [['shape', 'SQUARE color']]

        # use stop_on attribute for OneOrMore to avoid reading label string as part of the data
        attr_expr = Group(label + Suppress(':') + OneOrMore(data_word, stop_on=label).set_parse_action(' '.join))
        OneOrMore(attr_expr).parse_string(text).pprint() # Better -> [['shape', 'SQUARE'], ['posn', 'upper left'], ['color', 'BLACK']]

        # could also be written as
        (attr_expr * (1,)).parse_string(text).pprint()
    """

    def _generateDefaultName(self) -> str:
        return "{" + str(self.expr) + "}..."


class ZeroOrMore(_MultipleMatch):
    """
    Optional repetition of zero or more of the given expression.

    Parameters:

    - ``expr`` - expression that must match zero or more times
    - ``stop_on`` - expression for a terminating sentinel
      (only required if the sentinel would ordinarily match the repetition
      expression) - (default= ``None``)

    Example: similar to :class:`OneOrMore`
    """

    def __init__(
        self,
        expr: Union[str, ParserElement],
        stop_on: typing.Optional[Union[ParserElement, str]] = None,
        *,
        stopOn: typing.Optional[Union[ParserElement, str]] = None,
    ):
        super().__init__(expr, stopOn=stopOn or stop_on)
        self.mayReturnEmpty = True

    def parseImpl(self, instring, loc, doActions=True):
        try:
            return super().parseImpl(instring, loc, doActions)
        except (ParseException, IndexError):
            return loc, ParseResults([], name=self.resultsName)

    def _generateDefaultName(self) -> str:
        return "[" + str(self.expr) + "]..."


class DelimitedList(ParseElementEnhance):
    def __init__(
        self,
        expr: Union[str, ParserElement],
        delim: Union[str, ParserElement] = ",",
        combine: bool = False,
        min: typing.Optional[int] = None,
        max: typing.Optional[int] = None,
        *,
        allow_trailing_delim: bool = False,
    ):
        """Helper to define a delimited list of expressions - the delimiter
        defaults to ','. By default, the list elements and delimiters can
        have intervening whitespace, and comments, but this can be
        overridden by passing ``combine=True`` in the constructor. If
        ``combine`` is set to ``True``, the matching tokens are
        returned as a single token string, with the delimiters included;
        otherwise, the matching tokens are returned as a list of tokens,
        with the delimiters suppressed.

        If ``allow_trailing_delim`` is set to True, then the list may end with
        a delimiter.

        Example::

            DelimitedList(Word(alphas)).parse_string("aa,bb,cc") # -> ['aa', 'bb', 'cc']
            DelimitedList(Word(hexnums), delim=':', combine=True).parse_string("AA:BB:CC:DD:EE") # -> ['AA:BB:CC:DD:EE']
        """
        if isinstance(expr, str_type):
            expr = ParserElement._literalStringClass(expr)
        expr = typing.cast(ParserElement, expr)

        if min is not None:
            if min < 1:
                raise ValueError("min must be greater than 0")
        if max is not None:
            if min is not None and max < min:
                raise ValueError("max must be greater than, or equal to min")

        self.content = expr
        self.raw_delim = str(delim)
        self.delim = delim
        self.combine = combine
        if not combine:
            self.delim = Suppress(delim)
        self.min = min or 1
        self.max = max
        self.allow_trailing_delim = allow_trailing_delim

        delim_list_expr = self.content + (self.delim + self.content) * (
            self.min - 1,
            None if self.max is None else self.max - 1,
        )
        if self.allow_trailing_delim:
            delim_list_expr += Opt(self.delim)

        if self.combine:
            delim_list_expr = Combine(delim_list_expr)

        super().__init__(delim_list_expr, savelist=True)

    def _generateDefaultName(self) -> str:
        return "{0} [{1} {0}]...".format(self.content.streamline(), self.raw_delim)


class _NullToken:
    def __bool__(self):
        return False

    def __str__(self):
        return ""


class Opt(ParseElementEnhance):
    """
    Optional matching of the given expression.

    Parameters:

    - ``expr`` - expression that must match zero or more times
    - ``default`` (optional) - value to be returned if the optional expression is not found.

    Example::

        # US postal code can be a 5-digit zip, plus optional 4-digit qualifier
        zip = Combine(Word(nums, exact=5) + Opt('-' + Word(nums, exact=4)))
        zip.run_tests('''
            # traditional ZIP code
            12345

            # ZIP+4 form
            12101-0001

            # invalid ZIP
            98765-
            ''')

    prints::

        # traditional ZIP code
        12345
        ['12345']

        # ZIP+4 form
        12101-0001
        ['12101-0001']

        # invalid ZIP
        98765-
             ^
        FAIL: Expected end of text (at char 5), (line:1, col:6)
    """

    __optionalNotMatched = _NullToken()

    def __init__(
        self, expr: Union[ParserElement, str], default: Any = __optionalNotMatched
    ):
        super().__init__(expr, savelist=False)
        self.saveAsList = self.expr.saveAsList
        self.defaultValue = default
        self.mayReturnEmpty = True

    def parseImpl(self, instring, loc, doActions=True):
        self_expr = self.expr
        try:
            loc, tokens = self_expr._parse(instring, loc, doActions, callPreParse=False)
        except (ParseException, IndexError):
            default_value = self.defaultValue
            if default_value is not self.__optionalNotMatched:
                if self_expr.resultsName:
                    tokens = ParseResults([default_value])
                    tokens[self_expr.resultsName] = default_value
                else:
                    tokens = [default_value]
            else:
                tokens = []
        return loc, tokens

    def _generateDefaultName(self) -> str:
        inner = str(self.expr)
        # strip off redundant inner {}'s
        while len(inner) > 1 and inner[0 :: len(inner) - 1] == "{}":
            inner = inner[1:-1]
        return "[" + inner + "]"


Optional = Opt


class SkipTo(ParseElementEnhance):
    """
    Token for skipping over all undefined text until the matched
    expression is found.

    Parameters:

    - ``expr`` - target expression marking the end of the data to be skipped
    - ``include`` - if ``True``, the target expression is also parsed
      (the skipped text and target expression are returned as a 2-element
      list) (default= ``False``).
    - ``ignore`` - (default= ``None``) used to define grammars (typically quoted strings and
      comments) that might contain false matches to the target expression
    - ``fail_on`` - (default= ``None``) define expressions that are not allowed to be
      included in the skipped test; if found before the target expression is found,
      the :class:`SkipTo` is not a match

    Example::

        report = '''
            Outstanding Issues Report - 1 Jan 2000

               # | Severity | Description                               |  Days Open
            -----+----------+-------------------------------------------+-----------
             101 | Critical | Intermittent system crash                 |          6
              94 | Cosmetic | Spelling error on Login ('log|n')         |         14
              79 | Minor    | System slow when running too many reports |         47
            '''
        integer = Word(nums)
        SEP = Suppress('|')
        # use SkipTo to simply match everything up until the next SEP
        # - ignore quoted strings, so that a '|' character inside a quoted string does not match
        # - parse action will call token.strip() for each matched token, i.e., the description body
        string_data = SkipTo(SEP, ignore=quoted_string)
        string_data.set_parse_action(token_map(str.strip))
        ticket_expr = (integer("issue_num") + SEP
                      + string_data("sev") + SEP
                      + string_data("desc") + SEP
                      + integer("days_open"))

        for tkt in ticket_expr.search_string(report):
            print tkt.dump()

    prints::

        ['101', 'Critical', 'Intermittent system crash', '6']
        - days_open: '6'
        - desc: 'Intermittent system crash'
        - issue_num: '101'
        - sev: 'Critical'
        ['94', 'Cosmetic', "Spelling error on Login ('log|n')", '14']
        - days_open: '14'
        - desc: "Spelling error on Login ('log|n')"
        - issue_num: '94'
        - sev: 'Cosmetic'
        ['79', 'Minor', 'System slow when running too many reports', '47']
        - days_open: '47'
        - desc: 'System slow when running too many reports'
        - issue_num: '79'
        - sev: 'Minor'
    """

    def __init__(
        self,
        other: Union[ParserElement, str],
        include: bool = False,
        ignore: typing.Optional[Union[ParserElement, str]] = None,
        fail_on: typing.Optional[Union[ParserElement, str]] = None,
        *,
        failOn: typing.Optional[Union[ParserElement, str]] = None,
    ):
        super().__init__(other)
        failOn = failOn or fail_on
        if ignore is not None:
            self.ignore(ignore)
        self.mayReturnEmpty = True
        self.mayIndexError = False
        self.includeMatch = include
        self.saveAsList = False
        if isinstance(failOn, str_type):
            self.failOn = self._literalStringClass(failOn)
        else:
            self.failOn = failOn
        self.errmsg = "No match found for " + str(self.expr)

    def parseImpl(self, instring, loc, doActions=True):
        startloc = loc
        instrlen = len(instring)
        self_expr_parse = self.expr._parse
        self_failOn_canParseNext = (
            self.failOn.canParseNext if self.failOn is not None else None
        )
        self_preParse = self.preParse if self.callPreparse else None

        tmploc = loc
        while tmploc <= instrlen:
            if self_failOn_canParseNext is not None:
                # break if failOn expression matches
                if self_failOn_canParseNext(instring, tmploc):
                    break

            if self_preParse is not None:
                # skip grammar-ignored expressions
                tmploc = self_preParse(instring, tmploc)

            try:
                self_expr_parse(instring, tmploc, doActions=False, callPreParse=False)
            except (ParseException, IndexError):
                # no match, advance loc in string
                tmploc += 1
            else:
                # matched skipto expr, done
                break

        else:
            # ran off the end of the input string without matching skipto expr, fail
            raise ParseException(instring, loc, self.errmsg, self)

        # build up return values
        loc = tmploc
        skiptext = instring[startloc:loc]
        skipresult = ParseResults(skiptext)

        if self.includeMatch:
            loc, mat = self_expr_parse(instring, loc, doActions, callPreParse=False)
            skipresult += mat

        return loc, skipresult


class Forward(ParseElementEnhance):
    """
    Forward declaration of an expression to be defined later -
    used for recursive grammars, such as algebraic infix notation.
    When the expression is known, it is assigned to the ``Forward``
    variable using the ``'<<'`` operator.

    Note: take care when assigning to ``Forward`` not to overlook
    precedence of operators.

    Specifically, ``'|'`` has a lower precedence than ``'<<'``, so that::

        fwd_expr << a | b | c

    will actually be evaluated as::

        (fwd_expr << a) | b | c

    thereby leaving b and c out as parseable alternatives.  It is recommended that you
    explicitly group the values inserted into the ``Forward``::

        fwd_expr << (a | b | c)

    Converting to use the ``'<<='`` operator instead will avoid this problem.

    See :class:`ParseResults.pprint` for an example of a recursive
    parser created using ``Forward``.
    """

    def __init__(self, other: typing.Optional[Union[ParserElement, str]] = None):
        self.caller_frame = traceback.extract_stack(limit=2)[0]
        super().__init__(other, savelist=False)  # type: ignore[arg-type]
        self.lshift_line = None

    def __lshift__(self, other) -> "Forward":
        if hasattr(self, "caller_frame"):
            del self.caller_frame
        if isinstance(other, str_type):
            other = self._literalStringClass(other)

        if not isinstance(other, ParserElement):
            return NotImplemented

        self.expr = other
        self.streamlined = other.streamlined
        self.mayIndexError = self.expr.mayIndexError
        self.mayReturnEmpty = self.expr.mayReturnEmpty
        self.set_whitespace_chars(
            self.expr.whiteChars, copy_defaults=self.expr.copyDefaultWhiteChars
        )
        self.skipWhitespace = self.expr.skipWhitespace
        self.saveAsList = self.expr.saveAsList
        self.ignoreExprs.extend(self.expr.ignoreExprs)
        self.lshift_line = traceback.extract_stack(limit=2)[-2]  # type: ignore[assignment]
        return self

    def __ilshift__(self, other) -> "Forward":
        if not isinstance(other, ParserElement):
            return NotImplemented

        return self << other

    def __or__(self, other) -> "ParserElement":
        caller_line = traceback.extract_stack(limit=2)[-2]
        if (
            __diag__.warn_on_match_first_with_lshift_operator
            and caller_line == self.lshift_line
            and Diagnostics.warn_on_match_first_with_lshift_operator
            not in self.suppress_warnings_
        ):
            warnings.warn(
                "using '<<' operator with '|' is probably an error, use '<<='",
                stacklevel=2,
            )
        ret = super().__or__(other)
        return ret

    def __del__(self):
        # see if we are getting dropped because of '=' reassignment of var instead of '<<=' or '<<'
        if (
            self.expr is None
            and __diag__.warn_on_assignment_to_Forward
            and Diagnostics.warn_on_assignment_to_Forward not in self.suppress_warnings_
        ):
            warnings.warn_explicit(
                "Forward defined here but no expression attached later using '<<=' or '<<'",
                UserWarning,
                filename=self.caller_frame.filename,
                lineno=self.caller_frame.lineno,
            )

    def parseImpl(self, instring, loc, doActions=True):
        if (
            self.expr is None
            and __diag__.warn_on_parse_using_empty_Forward
            and Diagnostics.warn_on_parse_using_empty_Forward
            not in self.suppress_warnings_
        ):
            # walk stack until parse_string, scan_string, search_string, or transform_string is found
            parse_fns = (
                "parse_string",
                "scan_string",
                "search_string",
                "transform_string",
            )
            tb = traceback.extract_stack(limit=200)
            for i, frm in enumerate(reversed(tb), start=1):
                if frm.name in parse_fns:
                    stacklevel = i + 1
                    break
            else:
                stacklevel = 2
            warnings.warn(
                "Forward expression was never assigned a value, will not parse any input",
                stacklevel=stacklevel,
            )
        if not ParserElement._left_recursion_enabled:
            return super().parseImpl(instring, loc, doActions)
        # ## Bounded Recursion algorithm ##
        # Recursion only needs to be processed at ``Forward`` elements, since they are
        # the only ones that can actually refer to themselves. The general idea is
        # to handle recursion stepwise: We start at no recursion, then recurse once,
        # recurse twice, ..., until more recursion offers no benefit (we hit the bound).
        #
        # The "trick" here is that each ``Forward`` gets evaluated in two contexts
        # - to *match* a specific recursion level, and
        # - to *search* the bounded recursion level
        # and the two run concurrently. The *search* must *match* each recursion level
        # to find the best possible match. This is handled by a memo table, which
        # provides the previous match to the next level match attempt.
        #
        # See also "Left Recursion in Parsing Expression Grammars", Medeiros et al.
        #
        # There is a complication since we not only *parse* but also *transform* via
        # actions: We do not want to run the actions too often while expanding. Thus,
        # we expand using `doActions=False` and only run `doActions=True` if the next
        # recursion level is acceptable.
        with ParserElement.recursion_lock:
            memo = ParserElement.recursion_memos
            try:
                # we are parsing at a specific recursion expansion - use it as-is
                prev_loc, prev_result = memo[loc, self, doActions]
                if isinstance(prev_result, Exception):
                    raise prev_result
                return prev_loc, prev_result.copy()
            except KeyError:
                act_key = (loc, self, True)
                peek_key = (loc, self, False)
                # we are searching for the best recursion expansion - keep on improving
                # both `doActions` cases must be tracked separately here!
                prev_loc, prev_peek = memo[peek_key] = (
                    loc - 1,
                    ParseException(
                        instring, loc, "Forward recursion without base case", self
                    ),
                )
                if doActions:
                    memo[act_key] = memo[peek_key]
                while True:
                    try:
                        new_loc, new_peek = super().parseImpl(instring, loc, False)
                    except ParseException:
                        # we failed before getting any match – do not hide the error
                        if isinstance(prev_peek, Exception):
                            raise
                        new_loc, new_peek = prev_loc, prev_peek
                    # the match did not get better: we are done
                    if new_loc <= prev_loc:
                        if doActions:
                            # replace the match for doActions=False as well,
                            # in case the action did backtrack
                            prev_loc, prev_result = memo[peek_key] = memo[act_key]
                            del memo[peek_key], memo[act_key]
                            return prev_loc, prev_result.copy()
                        del memo[peek_key]
                        return prev_loc, prev_peek.copy()
                    # the match did get better: see if we can improve further
                    else:
                        if doActions:
                            try:
                                memo[act_key] = super().parseImpl(instring, loc, True)
                            except ParseException as e:
                                memo[peek_key] = memo[act_key] = (new_loc, e)
                                raise
                        prev_loc, prev_peek = memo[peek_key] = new_loc, new_peek

    def leave_whitespace(self, recursive: bool = True) -> ParserElement:
        self.skipWhitespace = False
        return self

    def ignore_whitespace(self, recursive: bool = True) -> ParserElement:
        self.skipWhitespace = True
        return self

    def streamline(self) -> ParserElement:
        if not self.streamlined:
            self.streamlined = True
            if self.expr is not None:
                self.expr.streamline()
        return self

    def validate(self, validateTrace=None) -> None:
        warnings.warn(
            "ParserElement.validate() is deprecated, and should not be used to check for left recursion",
            DeprecationWarning,
            stacklevel=2,
        )
        if validateTrace is None:
            validateTrace = []

        if self not in validateTrace:
            tmp = validateTrace[:] + [self]
            if self.expr is not None:
                self.expr.validate(tmp)
        self._checkRecursion([])

    def _generateDefaultName(self) -> str:
        # Avoid infinite recursion by setting a temporary _defaultName
        self._defaultName = ": ..."

        # Use the string representation of main expression.
        retString = "..."
        try:
            if self.expr is not None:
                retString = str(self.expr)[:1000]
            else:
                retString = "None"
        finally:
            return self.__class__.__name__ + ": " + retString

    def copy(self) -> ParserElement:
        if self.expr is not None:
            return super().copy()
        else:
            ret = Forward()
            ret <<= self
            return ret

    def _setResultsName(self, name, list_all_matches=False):
        if (
            __diag__.warn_name_set_on_empty_Forward
            and Diagnostics.warn_name_set_on_empty_Forward
            not in self.suppress_warnings_
        ):
            if self.expr is None:
                warnings.warn(
                    "{}: setting results name {!r} on {} expression "
                    "that has no contained expression".format(
                        "warn_name_set_on_empty_Forward", name, type(self).__name__
                    ),
                    stacklevel=3,
                )

        return super()._setResultsName(name, list_all_matches)

    # Compatibility synonyms
    # fmt: off
    @replaced_by_pep8(leave_whitespace)
    def leaveWhitespace(self): ...

    @replaced_by_pep8(ignore_whitespace)
    def ignoreWhitespace(self): ...
    # fmt: on


class TokenConverter(ParseElementEnhance):
    """
    Abstract subclass of :class:`ParseExpression`, for converting parsed results.
    """

    def __init__(self, expr: Union[ParserElement, str], savelist=False):
        super().__init__(expr)  # , savelist)
        self.saveAsList = False


class Combine(TokenConverter):
    """Converter to concatenate all matching tokens to a single string.
    By default, the matching patterns must also be contiguous in the
    input string; this can be disabled by specifying
    ``'adjacent=False'`` in the constructor.

    Example::

        real = Word(nums) + '.' + Word(nums)
        print(real.parse_string('3.1416')) # -> ['3', '.', '1416']
        # will also erroneously match the following
        print(real.parse_string('3. 1416')) # -> ['3', '.', '1416']

        real = Combine(Word(nums) + '.' + Word(nums))
        print(real.parse_string('3.1416')) # -> ['3.1416']
        # no match when there are internal spaces
        print(real.parse_string('3. 1416')) # -> Exception: Expected W:(0123...)
    """

    def __init__(
        self,
        expr: ParserElement,
        join_string: str = "",
        adjacent: bool = True,
        *,
        joinString: typing.Optional[str] = None,
    ):
        super().__init__(expr)
        joinString = joinString if joinString is not None else join_string
        # suppress whitespace-stripping in contained parse expressions, but re-enable it on the Combine itself
        if adjacent:
            self.leave_whitespace()
        self.adjacent = adjacent
        self.skipWhitespace = True
        self.joinString = joinString
        self.callPreparse = True

    def ignore(self, other) -> ParserElement:
        if self.adjacent:
            ParserElement.ignore(self, other)
        else:
            super().ignore(other)
        return self

    def postParse(self, instring, loc, tokenlist):
        retToks = tokenlist.copy()
        del retToks[:]
        retToks += ParseResults(
            ["".join(tokenlist._asStringList(self.joinString))], modal=self.modalResults
        )

        if self.resultsName and retToks.haskeys():
            return [retToks]
        else:
            return retToks


class Group(TokenConverter):
    """Converter to return the matched tokens as a list - useful for
    returning tokens of :class:`ZeroOrMore` and :class:`OneOrMore` expressions.

    The optional ``aslist`` argument when set to True will return the
    parsed tokens as a Python list instead of a pyparsing ParseResults.

    Example::

        ident = Word(alphas)
        num = Word(nums)
        term = ident | num
        func = ident + Opt(DelimitedList(term))
        print(func.parse_string("fn a, b, 100"))
        # -> ['fn', 'a', 'b', '100']

        func = ident + Group(Opt(DelimitedList(term)))
        print(func.parse_string("fn a, b, 100"))
        # -> ['fn', ['a', 'b', '100']]
    """

    def __init__(self, expr: ParserElement, aslist: bool = False):
        super().__init__(expr)
        self.saveAsList = True
        self._asPythonList = aslist

    def postParse(self, instring, loc, tokenlist):
        if self._asPythonList:
            return ParseResults.List(
                tokenlist.asList()
                if isinstance(tokenlist, ParseResults)
                else list(tokenlist)
            )
        else:
            return [tokenlist]


class Dict(TokenConverter):
    """Converter to return a repetitive expression as a list, but also
    as a dictionary. Each element can also be referenced using the first
    token in the expression as its key. Useful for tabular report
    scraping when the first column can be used as a item key.

    The optional ``asdict`` argument when set to True will return the
    parsed tokens as a Python dict instead of a pyparsing ParseResults.

    Example::

        data_word = Word(alphas)
        label = data_word + FollowedBy(':')

        text = "shape: SQUARE posn: upper left color: light blue texture: burlap"
        attr_expr = (label + Suppress(':') + OneOrMore(data_word, stop_on=label).set_parse_action(' '.join))

        # print attributes as plain groups
        print(attr_expr[1, ...].parse_string(text).dump())

        # instead of OneOrMore(expr), parse using Dict(Group(expr)[1, ...]) - Dict will auto-assign names
        result = Dict(Group(attr_expr)[1, ...]).parse_string(text)
        print(result.dump())

        # access named fields as dict entries, or output as dict
        print(result['shape'])
        print(result.as_dict())

    prints::

        ['shape', 'SQUARE', 'posn', 'upper left', 'color', 'light blue', 'texture', 'burlap']
        [['shape', 'SQUARE'], ['posn', 'upper left'], ['color', 'light blue'], ['texture', 'burlap']]
        - color: 'light blue'
        - posn: 'upper left'
        - shape: 'SQUARE'
        - texture: 'burlap'
        SQUARE
        {'color': 'light blue', 'posn': 'upper left', 'texture': 'burlap', 'shape': 'SQUARE'}

    See more examples at :class:`ParseResults` of accessing fields by results name.
    """

    def __init__(self, expr: ParserElement, asdict: bool = False):
        super().__init__(expr)
        self.saveAsList = True
        self._asPythonDict = asdict

    def postParse(self, instring, loc, tokenlist):
        for i, tok in enumerate(tokenlist):
            if len(tok) == 0:
                continue

            ikey = tok[0]
            if isinstance(ikey, int):
                ikey = str(ikey).strip()

            if len(tok) == 1:
                tokenlist[ikey] = _ParseResultsWithOffset("", i)

            elif len(tok) == 2 and not isinstance(tok[1], ParseResults):
                tokenlist[ikey] = _ParseResultsWithOffset(tok[1], i)

            else:
                try:
                    dictvalue = tok.copy()  # ParseResults(i)
                except Exception:
                    exc = TypeError(
                        "could not extract dict values from parsed results"
                        " - Dict expression must contain Grouped expressions"
                    )
                    raise exc from None

                del dictvalue[0]

                if len(dictvalue) != 1 or (
                    isinstance(dictvalue, ParseResults) and dictvalue.haskeys()
                ):
                    tokenlist[ikey] = _ParseResultsWithOffset(dictvalue, i)
                else:
                    tokenlist[ikey] = _ParseResultsWithOffset(dictvalue[0], i)

        if self._asPythonDict:
            return [tokenlist.as_dict()] if self.resultsName else tokenlist.as_dict()
        else:
            return [tokenlist] if self.resultsName else tokenlist


class Suppress(TokenConverter):
    """Converter for ignoring the results of a parsed expression.

    Example::

        source = "a, b, c,d"
        wd = Word(alphas)
        wd_list1 = wd + (',' + wd)[...]
        print(wd_list1.parse_string(source))

        # often, delimiters that are useful during parsing are just in the
        # way afterward - use Suppress to keep them out of the parsed output
        wd_list2 = wd + (Suppress(',') + wd)[...]
        print(wd_list2.parse_string(source))

        # Skipped text (using '...') can be suppressed as well
        source = "lead in START relevant text END trailing text"
        start_marker = Keyword("START")
        end_marker = Keyword("END")
        find_body = Suppress(...) + start_marker + ... + end_marker
        print(find_body.parse_string(source)

    prints::

        ['a', ',', 'b', ',', 'c', ',', 'd']
        ['a', 'b', 'c', 'd']
        ['START', 'relevant text ', 'END']

    (See also :class:`DelimitedList`.)
    """

    def __init__(self, expr: Union[ParserElement, str], savelist: bool = False):
        if expr is ...:
            expr = _PendingSkip(NoMatch())
        super().__init__(expr)

    def __add__(self, other) -> "ParserElement":
        if isinstance(self.expr, _PendingSkip):
            return Suppress(SkipTo(other)) + other
        else:
            return super().__add__(other)

    def __sub__(self, other) -> "ParserElement":
        if isinstance(self.expr, _PendingSkip):
            return Suppress(SkipTo(other)) - other
        else:
            return super().__sub__(other)

    def postParse(self, instring, loc, tokenlist):
        return []

    def suppress(self) -> ParserElement:
        return self


def trace_parse_action(f: ParseAction) -> ParseAction:
    """Decorator for debugging parse actions.

    When the parse action is called, this decorator will print
    ``">> entering method-name(line:<current_source_line>, <parse_location>, <matched_tokens>)"``.
    When the parse action completes, the decorator will print
    ``"<<"`` followed by the returned value, or any exception that the parse action raised.

    Example::

        wd = Word(alphas)

        @trace_parse_action
        def remove_duplicate_chars(tokens):
            return ''.join(sorted(set(''.join(tokens))))

        wds = wd[1, ...].set_parse_action(remove_duplicate_chars)
        print(wds.parse_string("slkdjs sld sldd sdlf sdljf"))

    prints::

        >>entering remove_duplicate_chars(line: 'slkdjs sld sldd sdlf sdljf', 0, (['slkdjs', 'sld', 'sldd', 'sdlf', 'sdljf'], {}))
        <<leaving remove_duplicate_chars (ret: 'dfjkls')
        ['dfjkls']
    """
    f = _trim_arity(f)

    def z(*paArgs):
        thisFunc = f.__name__
        s, l, t = paArgs[-3:]
        if len(paArgs) > 3:
            thisFunc = paArgs[0].__class__.__name__ + "." + thisFunc
        sys.stderr.write(f">>entering {thisFunc}(line: {line(l, s)!r}, {l}, {t!r})\n")
        try:
            ret = f(*paArgs)
        except Exception as exc:
            sys.stderr.write(f"<<leaving {thisFunc} (exception: {exc})\n")
            raise
        sys.stderr.write(f"<<leaving {thisFunc} (ret: {ret!r})\n")
        return ret

    z.__name__ = f.__name__
    return z


# convenience constants for positional expressions
empty = Empty().set_name("empty")
line_start = LineStart().set_name("line_start")
line_end = LineEnd().set_name("line_end")
string_start = StringStart().set_name("string_start")
string_end = StringEnd().set_name("string_end")

_escapedPunc = Regex(r"\\[\\[\]\/\-\*\.\$\+\^\?()~ ]").set_parse_action(
    lambda s, l, t: t[0][1]
)
_escapedHexChar = Regex(r"\\0?[xX][0-9a-fA-F]+").set_parse_action(
    lambda s, l, t: chr(int(t[0].lstrip(r"\0x"), 16))
)
_escapedOctChar = Regex(r"\\0[0-7]+").set_parse_action(
    lambda s, l, t: chr(int(t[0][1:], 8))
)
_singleChar = (
    _escapedPunc | _escapedHexChar | _escapedOctChar | CharsNotIn(r"\]", exact=1)
)
_charRange = Group(_singleChar + Suppress("-") + _singleChar)
_reBracketExpr = (
    Literal("[")
    + Opt("^").set_results_name("negate")
    + Group(OneOrMore(_charRange | _singleChar)).set_results_name("body")
    + Literal("]")
)


def srange(s: str) -> str:
    r"""Helper to easily define string ranges for use in :class:`Word`
    construction. Borrows syntax from regexp ``'[]'`` string range
    definitions::

        srange("[0-9]")   -> "0123456789"
        srange("[a-z]")   -> "abcdefghijklmnopqrstuvwxyz"
        srange("[a-z$_]") -> "abcdefghijklmnopqrstuvwxyz$_"

    The input string must be enclosed in []'s, and the returned string
    is the expanded character set joined into a single string. The
    values enclosed in the []'s may be:

    - a single character
    - an escaped character with a leading backslash (such as ``\-``
      or ``\]``)
    - an escaped hex character with a leading ``'\x'``
      (``\x21``, which is a ``'!'`` character) (``\0x##``
      is also supported for backwards compatibility)
    - an escaped octal character with a leading ``'\0'``
      (``\041``, which is a ``'!'`` character)
    - a range of any of the above, separated by a dash (``'a-z'``,
      etc.)
    - any combination of the above (``'aeiouy'``,
      ``'a-zA-Z0-9_$'``, etc.)
    """
    _expanded = (
        lambda p: p
        if not isinstance(p, ParseResults)
        else "".join(chr(c) for c in range(ord(p[0]), ord(p[1]) + 1))
    )
    try:
        return "".join(_expanded(part) for part in _reBracketExpr.parse_string(s).body)
    except Exception as e:
        return ""


def token_map(func, *args) -> ParseAction:
    """Helper to define a parse action by mapping a function to all
    elements of a :class:`ParseResults` list. If any additional args are passed,
    they are forwarded to the given function as additional arguments
    after the token, as in
    ``hex_integer = Word(hexnums).set_parse_action(token_map(int, 16))``,
    which will convert the parsed data to an integer using base 16.

    Example (compare the last to example in :class:`ParserElement.transform_string`::

        hex_ints = Word(hexnums)[1, ...].set_parse_action(token_map(int, 16))
        hex_ints.run_tests('''
            00 11 22 aa FF 0a 0d 1a
            ''')

        upperword = Word(alphas).set_parse_action(token_map(str.upper))
        upperword[1, ...].run_tests('''
            my kingdom for a horse
            ''')

        wd = Word(alphas).set_parse_action(token_map(str.title))
        wd[1, ...].set_parse_action(' '.join).run_tests('''
            now is the winter of our discontent made glorious summer by this sun of york
            ''')

    prints::

        00 11 22 aa FF 0a 0d 1a
        [0, 17, 34, 170, 255, 10, 13, 26]

        my kingdom for a horse
        ['MY', 'KINGDOM', 'FOR', 'A', 'HORSE']

        now is the winter of our discontent made glorious summer by this sun of york
        ['Now Is The Winter Of Our Discontent Made Glorious Summer By This Sun Of York']
    """

    def pa(s, l, t):
        return [func(tokn, *args) for tokn in t]

    func_name = getattr(func, "__name__", getattr(func, "__class__").__name__)
    pa.__name__ = func_name

    return pa


def autoname_elements() -> None:
    """
    Utility to simplify mass-naming of parser elements, for
    generating railroad diagram with named subdiagrams.
    """
    calling_frame = sys._getframe().f_back
    if calling_frame is None:
        return
    calling_frame = typing.cast(types.FrameType, calling_frame)
    for name, var in calling_frame.f_locals.items():
        if isinstance(var, ParserElement) and not var.customName:
            var.set_name(name)


dbl_quoted_string = Combine(
    Regex(r'"(?:[^"\n\r\\]|(?:"")|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*') + '"'
).set_name("string enclosed in double quotes")

sgl_quoted_string = Combine(
    Regex(r"'(?:[^'\n\r\\]|(?:'')|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*") + "'"
).set_name("string enclosed in single quotes")

quoted_string = Combine(
    (Regex(r'"(?:[^"\n\r\\]|(?:"")|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*') + '"').set_name(
        "double quoted string"
    )
    | (Regex(r"'(?:[^'\n\r\\]|(?:'')|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*") + "'").set_name(
        "single quoted string"
    )
).set_name("quoted string using single or double quotes")

python_quoted_string = Combine(
    (Regex(r'"""(?:[^"\\]|""(?!")|"(?!"")|\\.)*', flags=re.MULTILINE) + '"""').set_name(
        "multiline double quoted string"
    )
    ^ (
        Regex(r"'''(?:[^'\\]|''(?!')|'(?!'')|\\.)*", flags=re.MULTILINE) + "'''"
    ).set_name("multiline single quoted string")
    ^ (Regex(r'"(?:[^"\n\r\\]|(?:\\")|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*') + '"').set_name(
        "double quoted string"
    )
    ^ (Regex(r"'(?:[^'\n\r\\]|(?:\\')|(?:\\(?:[^x]|x[0-9a-fA-F]+)))*") + "'").set_name(
        "single quoted string"
    )
).set_name("Python quoted string")

unicode_string = Combine("u" + quoted_string.copy()).set_name("unicode string literal")


alphas8bit = srange(r"[\0xc0-\0xd6\0xd8-\0xf6\0xf8-\0xff]")
punc8bit = srange(r"[\0xa1-\0xbf\0xd7\0xf7]")

# build list of built-in expressions, for future reference if a global default value
# gets updated
_builtin_exprs: List[ParserElement] = [
    v for v in vars().values() if isinstance(v, ParserElement)
]

# backward compatibility names
# fmt: off
sglQuotedString = sgl_quoted_string
dblQuotedString = dbl_quoted_string
quotedString = quoted_string
unicodeString = unicode_string
lineStart = line_start
lineEnd = line_end
stringStart = string_start
stringEnd = string_end

@replaced_by_pep8(null_debug_action)
def nullDebugAction(): ...

@replaced_by_pep8(trace_parse_action)
def traceParseAction(): ...

@replaced_by_pep8(condition_as_parse_action)
def conditionAsParseAction(): ...

@replaced_by_pep8(token_map)
def tokenMap(): ...
# fmt: on

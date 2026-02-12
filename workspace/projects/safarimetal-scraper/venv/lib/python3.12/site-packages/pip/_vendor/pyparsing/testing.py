# testing.py

from contextlib import contextmanager
import typing

from .core import (
    ParserElement,
    ParseException,
    Keyword,
    __diag__,
    __compat__,
)


class pyparsing_test:
    """
    namespace class for classes useful in writing unit tests
    """

    class reset_pyparsing_context:
        """
        Context manager to be used when writing unit tests that modify pyparsing config values:
        - packrat parsing
        - bounded recursion parsing
        - default whitespace characters.
        - default keyword characters
        - literal string auto-conversion class
        - __diag__ settings

        Example::

            with reset_pyparsing_context():
                # test that literals used to construct a grammar are automatically suppressed
                ParserElement.inlineLiteralsUsing(Suppress)

                term = Word(alphas) | Word(nums)
                group = Group('(' + term[...] + ')')

                # assert that the '()' characters are not included in the parsed tokens
                self.assertParseAndCheckList(group, "(abc 123 def)", ['abc', '123', 'def'])

            # after exiting context manager, literals are converted to Literal expressions again
        """

        def __init__(self):
            self._save_context = {}

        def save(self):
            self._save_context["default_whitespace"] = ParserElement.DEFAULT_WHITE_CHARS
            self._save_context["default_keyword_chars"] = Keyword.DEFAULT_KEYWORD_CHARS

            self._save_context[
                "literal_string_class"
            ] = ParserElement._literalStringClass

            self._save_context["verbose_stacktrace"] = ParserElement.verbose_stacktrace

            self._save_context["packrat_enabled"] = ParserElement._packratEnabled
            if ParserElement._packratEnabled:
                self._save_context[
                    "packrat_cache_size"
                ] = ParserElement.packrat_cache.size
            else:
                self._save_context["packrat_cache_size"] = None
            self._save_context["packrat_parse"] = ParserElement._parse
            self._save_context[
                "recursion_enabled"
            ] = ParserElement._left_recursion_enabled

            self._save_context["__diag__"] = {
                name: getattr(__diag__, name) for name in __diag__._all_names
            }

            self._save_context["__compat__"] = {
                "collect_all_And_tokens": __compat__.collect_all_And_tokens
            }

            return self

        def restore(self):
            # reset pyparsing global state
            if (
                ParserElement.DEFAULT_WHITE_CHARS
                != self._save_context["default_whitespace"]
            ):
                ParserElement.set_default_whitespace_chars(
                    self._save_context["default_whitespace"]
                )

            ParserElement.verbose_stacktrace = self._save_context["verbose_stacktrace"]

            Keyword.DEFAULT_KEYWORD_CHARS = self._save_context["default_keyword_chars"]
            ParserElement.inlineLiteralsUsing(
                self._save_context["literal_string_class"]
            )

            for name, value in self._save_context["__diag__"].items():
                (__diag__.enable if value else __diag__.disable)(name)

            ParserElement._packratEnabled = False
            if self._save_context["packrat_enabled"]:
                ParserElement.enable_packrat(self._save_context["packrat_cache_size"])
            else:
                ParserElement._parse = self._save_context["packrat_parse"]
            ParserElement._left_recursion_enabled = self._save_context[
                "recursion_enabled"
            ]

            __compat__.collect_all_And_tokens = self._save_context["__compat__"]

            return self

        def copy(self):
            ret = type(self)()
            ret._save_context.update(self._save_context)
            return ret

        def __enter__(self):
            return self.save()

        def __exit__(self, *args):
            self.restore()

    class TestParseResultsAsserts:
        """
        A mixin class to add parse results assertion methods to normal unittest.TestCase classes.
        """

        def assertParseResultsEquals(
            self, result, expected_list=None, expected_dict=None, msg=None
        ):
            """
            Unit test assertion to compare a :class:`ParseResults` object with an optional ``expected_list``,
            and compare any defined results names with an optional ``expected_dict``.
            """
            if expected_list is not None:
                self.assertEqual(expected_list, result.as_list(), msg=msg)
            if expected_dict is not None:
                self.assertEqual(expected_dict, result.as_dict(), msg=msg)

        def assertParseAndCheckList(
            self, expr, test_string, expected_list, msg=None, verbose=True
        ):
            """
            Convenience wrapper assert to test a parser element and input string, and assert that
            the resulting ``ParseResults.asList()`` is equal to the ``expected_list``.
            """
            result = expr.parse_string(test_string, parse_all=True)
            if verbose:
                print(result.dump())
            else:
                print(result.as_list())
            self.assertParseResultsEquals(result, expected_list=expected_list, msg=msg)

        def assertParseAndCheckDict(
            self, expr, test_string, expected_dict, msg=None, verbose=True
        ):
            """
            Convenience wrapper assert to test a parser element and input string, and assert that
            the resulting ``ParseResults.asDict()`` is equal to the ``expected_dict``.
            """
            result = expr.parse_string(test_string, parseAll=True)
            if verbose:
                print(result.dump())
            else:
                print(result.as_list())
            self.assertParseResultsEquals(result, expected_dict=expected_dict, msg=msg)

        def assertRunTestResults(
            self, run_tests_report, expected_parse_results=None, msg=None
        ):
            """
            Unit test assertion to evaluate output of ``ParserElement.runTests()``. If a list of
            list-dict tuples is given as the ``expected_parse_results`` argument, then these are zipped
            with the report tuples returned by ``runTests`` and evaluated using ``assertParseResultsEquals``.
            Finally, asserts that the overall ``runTests()`` success value is ``True``.

            :param run_tests_report: tuple(bool, [tuple(str, ParseResults or Exception)]) returned from runTests
            :param expected_parse_results (optional): [tuple(str, list, dict, Exception)]
            """
            run_test_success, run_test_results = run_tests_report

            if expected_parse_results is not None:
                merged = [
                    (*rpt, expected)
                    for rpt, expected in zip(run_test_results, expected_parse_results)
                ]
                for test_string, result, expected in merged:
                    # expected should be a tuple containing a list and/or a dict or an exception,
                    # and optional failure message string
                    # an empty tuple will skip any result validation
                    fail_msg = next(
                        (exp for exp in expected if isinstance(exp, str)), None
                    )
                    expected_exception = next(
                        (
                            exp
                            for exp in expected
                            if isinstance(exp, type) and issubclass(exp, Exception)
                        ),
                        None,
                    )
                    if expected_exception is not None:
                        with self.assertRaises(
                            expected_exception=expected_exception, msg=fail_msg or msg
                        ):
                            if isinstance(result, Exception):
                                raise result
                    else:
                        expected_list = next(
                            (exp for exp in expected if isinstance(exp, list)), None
                        )
                        expected_dict = next(
                            (exp for exp in expected if isinstance(exp, dict)), None
                        )
                        if (expected_list, expected_dict) != (None, None):
                            self.assertParseResultsEquals(
                                result,
                                expected_list=expected_list,
                                expected_dict=expected_dict,
                                msg=fail_msg or msg,
                            )
                        else:
                            # warning here maybe?
                            print(f"no validation for {test_string!r}")

            # do this last, in case some specific test results can be reported instead
            self.assertTrue(
                run_test_success, msg=msg if msg is not None else "failed runTests"
            )

        @contextmanager
        def assertRaisesParseException(self, exc_type=ParseException, msg=None):
            with self.assertRaises(exc_type, msg=msg):
                yield

    @staticmethod
    def with_line_numbers(
        s: str,
        start_line: typing.Optional[int] = None,
        end_line: typing.Optional[int] = None,
        expand_tabs: bool = True,
        eol_mark: str = "|",
        mark_spaces: typing.Optional[str] = None,
        mark_control: typing.Optional[str] = None,
    ) -> str:
        """
        Helpful method for debugging a parser - prints a string with line and column numbers.
        (Line and column numbers are 1-based.)

        :param s: tuple(bool, str - string to be printed with line and column numbers
        :param start_line: int - (optional) starting line number in s to print (default=1)
        :param end_line: int - (optional) ending line number in s to print (default=len(s))
        :param expand_tabs: bool - (optional) expand tabs to spaces, to match the pyparsing default
        :param eol_mark: str - (optional) string to mark the end of lines, helps visualize trailing spaces (default="|")
        :param mark_spaces: str - (optional) special character to display in place of spaces
        :param mark_control: str - (optional) convert non-printing control characters to a placeholding
                                 character; valid values:
                                 - "unicode" - replaces control chars with Unicode symbols, such as "␍" and "␊"
                                 - any single character string - replace control characters with given string
                                 - None (default) - string is displayed as-is

        :return: str - input string with leading line numbers and column number headers
        """
        if expand_tabs:
            s = s.expandtabs()
        if mark_control is not None:
            mark_control = typing.cast(str, mark_control)
            if mark_control == "unicode":
                transtable_map = {
                    c: u for c, u in zip(range(0, 33), range(0x2400, 0x2433))
                }
                transtable_map[127] = 0x2421
                tbl = str.maketrans(transtable_map)
                eol_mark = ""
            else:
                ord_mark_control = ord(mark_control)
                tbl = str.maketrans(
                    {c: ord_mark_control for c in list(range(0, 32)) + [127]}
                )
            s = s.translate(tbl)
        if mark_spaces is not None and mark_spaces != " ":
            if mark_spaces == "unicode":
                tbl = str.maketrans({9: 0x2409, 32: 0x2423})
                s = s.translate(tbl)
            else:
                s = s.replace(" ", mark_spaces)
        if start_line is None:
            start_line = 1
        if end_line is None:
            end_line = len(s)
        end_line = min(end_line, len(s))
        start_line = min(max(1, start_line), end_line)

        if mark_control != "unicode":
            s_lines = s.splitlines()[start_line - 1 : end_line]
        else:
            s_lines = [line + "␊" for line in s.split("␊")[start_line - 1 : end_line]]
        if not s_lines:
            return ""

        lineno_width = len(str(end_line))
        max_line_len = max(len(line) for line in s_lines)
        lead = " " * (lineno_width + 1)
        if max_line_len >= 99:
            header0 = (
                lead
                + "".join(
                    f"{' ' * 99}{(i + 1) % 100}"
                    for i in range(max(max_line_len // 100, 1))
                )
                + "\n"
            )
        else:
            header0 = ""
        header1 = (
            header0
            + lead
            + "".join(f"         {(i + 1) % 10}" for i in range(-(-max_line_len // 10)))
            + "\n"
        )
        header2 = lead + "1234567890" * (-(-max_line_len // 10)) + "\n"
        return (
            header1
            + header2
            + "\n".join(
                f"{i:{lineno_width}d}:{line}{eol_mark}"
                for i, line in enumerate(s_lines, start=start_line)
            )
            + "\n"
        )

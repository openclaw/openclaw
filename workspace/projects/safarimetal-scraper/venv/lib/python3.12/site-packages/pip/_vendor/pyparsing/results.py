# results.py
from collections.abc import (
    MutableMapping,
    Mapping,
    MutableSequence,
    Iterator,
    Sequence,
    Container,
)
import pprint
from typing import Tuple, Any, Dict, Set, List

str_type: Tuple[type, ...] = (str, bytes)
_generator_type = type((_ for _ in ()))


class _ParseResultsWithOffset:
    tup: Tuple["ParseResults", int]
    __slots__ = ["tup"]

    def __init__(self, p1: "ParseResults", p2: int):
        self.tup: Tuple[ParseResults, int] = (p1, p2)

    def __getitem__(self, i):
        return self.tup[i]

    def __getstate__(self):
        return self.tup

    def __setstate__(self, *args):
        self.tup = args[0]


class ParseResults:
    """Structured parse results, to provide multiple means of access to
    the parsed data:

    - as a list (``len(results)``)
    - by list index (``results[0], results[1]``, etc.)
    - by attribute (``results.<results_name>`` - see :class:`ParserElement.set_results_name`)

    Example::

        integer = Word(nums)
        date_str = (integer.set_results_name("year") + '/'
                    + integer.set_results_name("month") + '/'
                    + integer.set_results_name("day"))
        # equivalent form:
        # date_str = (integer("year") + '/'
        #             + integer("month") + '/'
        #             + integer("day"))

        # parse_string returns a ParseResults object
        result = date_str.parse_string("1999/12/31")

        def test(s, fn=repr):
            print(f"{s} -> {fn(eval(s))}")
        test("list(result)")
        test("result[0]")
        test("result['month']")
        test("result.day")
        test("'month' in result")
        test("'minutes' in result")
        test("result.dump()", str)

    prints::

        list(result) -> ['1999', '/', '12', '/', '31']
        result[0] -> '1999'
        result['month'] -> '12'
        result.day -> '31'
        'month' in result -> True
        'minutes' in result -> False
        result.dump() -> ['1999', '/', '12', '/', '31']
        - day: '31'
        - month: '12'
        - year: '1999'
    """

    _null_values: Tuple[Any, ...] = (None, [], ())

    _name: str
    _parent: "ParseResults"
    _all_names: Set[str]
    _modal: bool
    _toklist: List[Any]
    _tokdict: Dict[str, Any]

    __slots__ = (
        "_name",
        "_parent",
        "_all_names",
        "_modal",
        "_toklist",
        "_tokdict",
    )

    class List(list):
        """
        Simple wrapper class to distinguish parsed list results that should be preserved
        as actual Python lists, instead of being converted to :class:`ParseResults`::

            LBRACK, RBRACK = map(pp.Suppress, "[]")
            element = pp.Forward()
            item = ppc.integer
            element_list = LBRACK + pp.DelimitedList(element) + RBRACK

            # add parse actions to convert from ParseResults to actual Python collection types
            def as_python_list(t):
                return pp.ParseResults.List(t.as_list())
            element_list.add_parse_action(as_python_list)

            element <<= item | element_list

            element.run_tests('''
                100
                [2,3,4]
                [[2, 1],3,4]
                [(2, 1),3,4]
                (2,3,4)
                ''', post_parse=lambda s, r: (r[0], type(r[0])))

        prints::

            100
            (100, <class 'int'>)

            [2,3,4]
            ([2, 3, 4], <class 'list'>)

            [[2, 1],3,4]
            ([[2, 1], 3, 4], <class 'list'>)

        (Used internally by :class:`Group` when `aslist=True`.)
        """

        def __new__(cls, contained=None):
            if contained is None:
                contained = []

            if not isinstance(contained, list):
                raise TypeError(
                    f"{cls.__name__} may only be constructed with a list, not {type(contained).__name__}"
                )

            return list.__new__(cls)

    def __new__(cls, toklist=None, name=None, **kwargs):
        if isinstance(toklist, ParseResults):
            return toklist
        self = object.__new__(cls)
        self._name = None
        self._parent = None
        self._all_names = set()

        if toklist is None:
            self._toklist = []
        elif isinstance(toklist, (list, _generator_type)):
            self._toklist = (
                [toklist[:]]
                if isinstance(toklist, ParseResults.List)
                else list(toklist)
            )
        else:
            self._toklist = [toklist]
        self._tokdict = dict()
        return self

    # Performance tuning: we construct a *lot* of these, so keep this
    # constructor as small and fast as possible
    def __init__(
        self, toklist=None, name=None, asList=True, modal=True, isinstance=isinstance
    ):
        self._tokdict: Dict[str, _ParseResultsWithOffset]
        self._modal = modal
        if name is not None and name != "":
            if isinstance(name, int):
                name = str(name)
            if not modal:
                self._all_names = {name}
            self._name = name
            if toklist not in self._null_values:
                if isinstance(toklist, (str_type, type)):
                    toklist = [toklist]
                if asList:
                    if isinstance(toklist, ParseResults):
                        self[name] = _ParseResultsWithOffset(
                            ParseResults(toklist._toklist), 0
                        )
                    else:
                        self[name] = _ParseResultsWithOffset(
                            ParseResults(toklist[0]), 0
                        )
                    self[name]._name = name
                else:
                    try:
                        self[name] = toklist[0]
                    except (KeyError, TypeError, IndexError):
                        if toklist is not self:
                            self[name] = toklist
                        else:
                            self._name = name

    def __getitem__(self, i):
        if isinstance(i, (int, slice)):
            return self._toklist[i]
        else:
            if i not in self._all_names:
                return self._tokdict[i][-1][0]
            else:
                return ParseResults([v[0] for v in self._tokdict[i]])

    def __setitem__(self, k, v, isinstance=isinstance):
        if isinstance(v, _ParseResultsWithOffset):
            self._tokdict[k] = self._tokdict.get(k, list()) + [v]
            sub = v[0]
        elif isinstance(k, (int, slice)):
            self._toklist[k] = v
            sub = v
        else:
            self._tokdict[k] = self._tokdict.get(k, list()) + [
                _ParseResultsWithOffset(v, 0)
            ]
            sub = v
        if isinstance(sub, ParseResults):
            sub._parent = self

    def __delitem__(self, i):
        if isinstance(i, (int, slice)):
            mylen = len(self._toklist)
            del self._toklist[i]

            # convert int to slice
            if isinstance(i, int):
                if i < 0:
                    i += mylen
                i = slice(i, i + 1)
            # get removed indices
            removed = list(range(*i.indices(mylen)))
            removed.reverse()
            # fixup indices in token dictionary
            for name, occurrences in self._tokdict.items():
                for j in removed:
                    for k, (value, position) in enumerate(occurrences):
                        occurrences[k] = _ParseResultsWithOffset(
                            value, position - (position > j)
                        )
        else:
            del self._tokdict[i]

    def __contains__(self, k) -> bool:
        return k in self._tokdict

    def __len__(self) -> int:
        return len(self._toklist)

    def __bool__(self) -> bool:
        return not not (self._toklist or self._tokdict)

    def __iter__(self) -> Iterator:
        return iter(self._toklist)

    def __reversed__(self) -> Iterator:
        return iter(self._toklist[::-1])

    def keys(self):
        return iter(self._tokdict)

    def values(self):
        return (self[k] for k in self.keys())

    def items(self):
        return ((k, self[k]) for k in self.keys())

    def haskeys(self) -> bool:
        """
        Since ``keys()`` returns an iterator, this method is helpful in bypassing
        code that looks for the existence of any defined results names."""
        return not not self._tokdict

    def pop(self, *args, **kwargs):
        """
        Removes and returns item at specified index (default= ``last``).
        Supports both ``list`` and ``dict`` semantics for ``pop()``. If
        passed no argument or an integer argument, it will use ``list``
        semantics and pop tokens from the list of parsed tokens. If passed
        a non-integer argument (most likely a string), it will use ``dict``
        semantics and pop the corresponding value from any defined results
        names. A second default return value argument is supported, just as in
        ``dict.pop()``.

        Example::

            numlist = Word(nums)[...]
            print(numlist.parse_string("0 123 321")) # -> ['0', '123', '321']

            def remove_first(tokens):
                tokens.pop(0)
            numlist.add_parse_action(remove_first)
            print(numlist.parse_string("0 123 321")) # -> ['123', '321']

            label = Word(alphas)
            patt = label("LABEL") + Word(nums)[1, ...]
            print(patt.parse_string("AAB 123 321").dump())

            # Use pop() in a parse action to remove named result (note that corresponding value is not
            # removed from list form of results)
            def remove_LABEL(tokens):
                tokens.pop("LABEL")
                return tokens
            patt.add_parse_action(remove_LABEL)
            print(patt.parse_string("AAB 123 321").dump())

        prints::

            ['AAB', '123', '321']
            - LABEL: 'AAB'

            ['AAB', '123', '321']
        """
        if not args:
            args = [-1]
        for k, v in kwargs.items():
            if k == "default":
                args = (args[0], v)
            else:
                raise TypeError(f"pop() got an unexpected keyword argument {k!r}")
        if isinstance(args[0], int) or len(args) == 1 or args[0] in self:
            index = args[0]
            ret = self[index]
            del self[index]
            return ret
        else:
            defaultvalue = args[1]
            return defaultvalue

    def get(self, key, default_value=None):
        """
        Returns named result matching the given key, or if there is no
        such name, then returns the given ``default_value`` or ``None`` if no
        ``default_value`` is specified.

        Similar to ``dict.get()``.

        Example::

            integer = Word(nums)
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")

            result = date_str.parse_string("1999/12/31")
            print(result.get("year")) # -> '1999'
            print(result.get("hour", "not specified")) # -> 'not specified'
            print(result.get("hour")) # -> None
        """
        if key in self:
            return self[key]
        else:
            return default_value

    def insert(self, index, ins_string):
        """
        Inserts new element at location index in the list of parsed tokens.

        Similar to ``list.insert()``.

        Example::

            numlist = Word(nums)[...]
            print(numlist.parse_string("0 123 321")) # -> ['0', '123', '321']

            # use a parse action to insert the parse location in the front of the parsed results
            def insert_locn(locn, tokens):
                tokens.insert(0, locn)
            numlist.add_parse_action(insert_locn)
            print(numlist.parse_string("0 123 321")) # -> [0, '0', '123', '321']
        """
        self._toklist.insert(index, ins_string)
        # fixup indices in token dictionary
        for name, occurrences in self._tokdict.items():
            for k, (value, position) in enumerate(occurrences):
                occurrences[k] = _ParseResultsWithOffset(
                    value, position + (position > index)
                )

    def append(self, item):
        """
        Add single element to end of ``ParseResults`` list of elements.

        Example::

            numlist = Word(nums)[...]
            print(numlist.parse_string("0 123 321")) # -> ['0', '123', '321']

            # use a parse action to compute the sum of the parsed integers, and add it to the end
            def append_sum(tokens):
                tokens.append(sum(map(int, tokens)))
            numlist.add_parse_action(append_sum)
            print(numlist.parse_string("0 123 321")) # -> ['0', '123', '321', 444]
        """
        self._toklist.append(item)

    def extend(self, itemseq):
        """
        Add sequence of elements to end of ``ParseResults`` list of elements.

        Example::

            patt = Word(alphas)[1, ...]

            # use a parse action to append the reverse of the matched strings, to make a palindrome
            def make_palindrome(tokens):
                tokens.extend(reversed([t[::-1] for t in tokens]))
                return ''.join(tokens)
            patt.add_parse_action(make_palindrome)
            print(patt.parse_string("lskdj sdlkjf lksd")) # -> 'lskdjsdlkjflksddsklfjkldsjdksl'
        """
        if isinstance(itemseq, ParseResults):
            self.__iadd__(itemseq)
        else:
            self._toklist.extend(itemseq)

    def clear(self):
        """
        Clear all elements and results names.
        """
        del self._toklist[:]
        self._tokdict.clear()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            if name.startswith("__"):
                raise AttributeError(name)
            return ""

    def __add__(self, other: "ParseResults") -> "ParseResults":
        ret = self.copy()
        ret += other
        return ret

    def __iadd__(self, other: "ParseResults") -> "ParseResults":
        if not other:
            return self

        if other._tokdict:
            offset = len(self._toklist)
            addoffset = lambda a: offset if a < 0 else a + offset
            otheritems = other._tokdict.items()
            otherdictitems = [
                (k, _ParseResultsWithOffset(v[0], addoffset(v[1])))
                for k, vlist in otheritems
                for v in vlist
            ]
            for k, v in otherdictitems:
                self[k] = v
                if isinstance(v[0], ParseResults):
                    v[0]._parent = self

        self._toklist += other._toklist
        self._all_names |= other._all_names
        return self

    def __radd__(self, other) -> "ParseResults":
        if isinstance(other, int) and other == 0:
            # useful for merging many ParseResults using sum() builtin
            return self.copy()
        else:
            # this may raise a TypeError - so be it
            return other + self

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._toklist!r}, {self.as_dict()})"

    def __str__(self) -> str:
        return (
            "["
            + ", ".join(
                [
                    str(i) if isinstance(i, ParseResults) else repr(i)
                    for i in self._toklist
                ]
            )
            + "]"
        )

    def _asStringList(self, sep=""):
        out = []
        for item in self._toklist:
            if out and sep:
                out.append(sep)
            if isinstance(item, ParseResults):
                out += item._asStringList()
            else:
                out.append(str(item))
        return out

    def as_list(self) -> list:
        """
        Returns the parse results as a nested list of matching tokens, all converted to strings.

        Example::

            patt = Word(alphas)[1, ...]
            result = patt.parse_string("sldkj lsdkj sldkj")
            # even though the result prints in string-like form, it is actually a pyparsing ParseResults
            print(type(result), result) # -> <class 'pyparsing.ParseResults'> ['sldkj', 'lsdkj', 'sldkj']

            # Use as_list() to create an actual list
            result_list = result.as_list()
            print(type(result_list), result_list) # -> <class 'list'> ['sldkj', 'lsdkj', 'sldkj']
        """
        return [
            res.as_list() if isinstance(res, ParseResults) else res
            for res in self._toklist
        ]

    def as_dict(self) -> dict:
        """
        Returns the named parse results as a nested dictionary.

        Example::

            integer = Word(nums)
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")

            result = date_str.parse_string('12/31/1999')
            print(type(result), repr(result)) # -> <class 'pyparsing.ParseResults'> (['12', '/', '31', '/', '1999'], {'day': [('1999', 4)], 'year': [('12', 0)], 'month': [('31', 2)]})

            result_dict = result.as_dict()
            print(type(result_dict), repr(result_dict)) # -> <class 'dict'> {'day': '1999', 'year': '12', 'month': '31'}

            # even though a ParseResults supports dict-like access, sometime you just need to have a dict
            import json
            print(json.dumps(result)) # -> Exception: TypeError: ... is not JSON serializable
            print(json.dumps(result.as_dict())) # -> {"month": "31", "day": "1999", "year": "12"}
        """

        def to_item(obj):
            if isinstance(obj, ParseResults):
                return obj.as_dict() if obj.haskeys() else [to_item(v) for v in obj]
            else:
                return obj

        return dict((k, to_item(v)) for k, v in self.items())

    def copy(self) -> "ParseResults":
        """
        Returns a new shallow copy of a :class:`ParseResults` object. `ParseResults`
        items contained within the source are shared with the copy. Use
        :class:`ParseResults.deepcopy()` to create a copy with its own separate
        content values.
        """
        ret = ParseResults(self._toklist)
        ret._tokdict = self._tokdict.copy()
        ret._parent = self._parent
        ret._all_names |= self._all_names
        ret._name = self._name
        return ret

    def deepcopy(self) -> "ParseResults":
        """
        Returns a new deep copy of a :class:`ParseResults` object.
        """
        ret = self.copy()
        # replace values with copies if they are of known mutable types
        for i, obj in enumerate(self._toklist):
            if isinstance(obj, ParseResults):
                self._toklist[i] = obj.deepcopy()
            elif isinstance(obj, (str, bytes)):
                pass
            elif isinstance(obj, MutableMapping):
                self._toklist[i] = dest = type(obj)()
                for k, v in obj.items():
                    dest[k] = v.deepcopy() if isinstance(v, ParseResults) else v
            elif isinstance(obj, Container):
                self._toklist[i] = type(obj)(
                    v.deepcopy() if isinstance(v, ParseResults) else v for v in obj
                )
        return ret

    def get_name(self):
        r"""
        Returns the results name for this token expression. Useful when several
        different expressions might match at a particular location.

        Example::

            integer = Word(nums)
            ssn_expr = Regex(r"\d\d\d-\d\d-\d\d\d\d")
            house_number_expr = Suppress('#') + Word(nums, alphanums)
            user_data = (Group(house_number_expr)("house_number")
                        | Group(ssn_expr)("ssn")
                        | Group(integer)("age"))
            user_info = user_data[1, ...]

            result = user_info.parse_string("22 111-22-3333 #221B")
            for item in result:
                print(item.get_name(), ':', item[0])

        prints::

            age : 22
            ssn : 111-22-3333
            house_number : 221B
        """
        if self._name:
            return self._name
        elif self._parent:
            par: "ParseResults" = self._parent
            parent_tokdict_items = par._tokdict.items()
            return next(
                (
                    k
                    for k, vlist in parent_tokdict_items
                    for v, loc in vlist
                    if v is self
                ),
                None,
            )
        elif (
            len(self) == 1
            and len(self._tokdict) == 1
            and next(iter(self._tokdict.values()))[0][1] in (0, -1)
        ):
            return next(iter(self._tokdict.keys()))
        else:
            return None

    def dump(self, indent="", full=True, include_list=True, _depth=0) -> str:
        """
        Diagnostic method for listing out the contents of
        a :class:`ParseResults`. Accepts an optional ``indent`` argument so
        that this string can be embedded in a nested display of other data.

        Example::

            integer = Word(nums)
            date_str = integer("year") + '/' + integer("month") + '/' + integer("day")

            result = date_str.parse_string('1999/12/31')
            print(result.dump())

        prints::

            ['1999', '/', '12', '/', '31']
            - day: '31'
            - month: '12'
            - year: '1999'
        """
        out = []
        NL = "\n"
        out.append(indent + str(self.as_list()) if include_list else "")

        if full:
            if self.haskeys():
                items = sorted((str(k), v) for k, v in self.items())
                for k, v in items:
                    if out:
                        out.append(NL)
                    out.append(f"{indent}{('  ' * _depth)}- {k}: ")
                    if isinstance(v, ParseResults):
                        if v:
                            out.append(
                                v.dump(
                                    indent=indent,
                                    full=full,
                                    include_list=include_list,
                                    _depth=_depth + 1,
                                )
                            )
                        else:
                            out.append(str(v))
                    else:
                        out.append(repr(v))
            if any(isinstance(vv, ParseResults) for vv in self):
                v = self
                for i, vv in enumerate(v):
                    if isinstance(vv, ParseResults):
                        out.append(
                            "\n{}{}[{}]:\n{}{}{}".format(
                                indent,
                                ("  " * (_depth)),
                                i,
                                indent,
                                ("  " * (_depth + 1)),
                                vv.dump(
                                    indent=indent,
                                    full=full,
                                    include_list=include_list,
                                    _depth=_depth + 1,
                                ),
                            )
                        )
                    else:
                        out.append(
                            "\n%s%s[%d]:\n%s%s%s"
                            % (
                                indent,
                                ("  " * (_depth)),
                                i,
                                indent,
                                ("  " * (_depth + 1)),
                                str(vv),
                            )
                        )

        return "".join(out)

    def pprint(self, *args, **kwargs):
        """
        Pretty-printer for parsed results as a list, using the
        `pprint <https://docs.python.org/3/library/pprint.html>`_ module.
        Accepts additional positional or keyword args as defined for
        `pprint.pprint <https://docs.python.org/3/library/pprint.html#pprint.pprint>`_ .

        Example::

            ident = Word(alphas, alphanums)
            num = Word(nums)
            func = Forward()
            term = ident | num | Group('(' + func + ')')
            func <<= ident + Group(Optional(DelimitedList(term)))
            result = func.parse_string("fna a,b,(fnb c,d,200),100")
            result.pprint(width=40)

        prints::

            ['fna',
             ['a',
              'b',
              ['(', 'fnb', ['c', 'd', '200'], ')'],
              '100']]
        """
        pprint.pprint(self.as_list(), *args, **kwargs)

    # add support for pickle protocol
    def __getstate__(self):
        return (
            self._toklist,
            (
                self._tokdict.copy(),
                None,
                self._all_names,
                self._name,
            ),
        )

    def __setstate__(self, state):
        self._toklist, (self._tokdict, par, inAccumNames, self._name) = state
        self._all_names = set(inAccumNames)
        self._parent = None

    def __getnewargs__(self):
        return self._toklist, self._name

    def __dir__(self):
        return dir(type(self)) + list(self.keys())

    @classmethod
    def from_dict(cls, other, name=None) -> "ParseResults":
        """
        Helper classmethod to construct a ``ParseResults`` from a ``dict``, preserving the
        name-value relations as results names. If an optional ``name`` argument is
        given, a nested ``ParseResults`` will be returned.
        """

        def is_iterable(obj):
            try:
                iter(obj)
            except Exception:
                return False
            # str's are iterable, but in pyparsing, we don't want to iterate over them
            else:
                return not isinstance(obj, str_type)

        ret = cls([])
        for k, v in other.items():
            if isinstance(v, Mapping):
                ret += cls.from_dict(v, name=k)
            else:
                ret += cls([v], name=k, asList=is_iterable(v))
        if name is not None:
            ret = cls([ret], name=name)
        return ret

    asList = as_list
    """Deprecated - use :class:`as_list`"""
    asDict = as_dict
    """Deprecated - use :class:`as_dict`"""
    getName = get_name
    """Deprecated - use :class:`get_name`"""


MutableMapping.register(ParseResults)
MutableSequence.register(ParseResults)

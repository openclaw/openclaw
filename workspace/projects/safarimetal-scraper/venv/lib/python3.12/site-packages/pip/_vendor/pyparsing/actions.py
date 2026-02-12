# actions.py

from .exceptions import ParseException
from .util import col, replaced_by_pep8


class OnlyOnce:
    """
    Wrapper for parse actions, to ensure they are only called once.
    """

    def __init__(self, method_call):
        from .core import _trim_arity

        self.callable = _trim_arity(method_call)
        self.called = False

    def __call__(self, s, l, t):
        if not self.called:
            results = self.callable(s, l, t)
            self.called = True
            return results
        raise ParseException(s, l, "OnlyOnce obj called multiple times w/out reset")

    def reset(self):
        """
        Allow the associated parse action to be called once more.
        """

        self.called = False


def match_only_at_col(n):
    """
    Helper method for defining parse actions that require matching at
    a specific column in the input text.
    """

    def verify_col(strg, locn, toks):
        if col(locn, strg) != n:
            raise ParseException(strg, locn, f"matched token not at column {n}")

    return verify_col


def replace_with(repl_str):
    """
    Helper method for common parse actions that simply return
    a literal value.  Especially useful when used with
    :class:`transform_string<ParserElement.transform_string>` ().

    Example::

        num = Word(nums).set_parse_action(lambda toks: int(toks[0]))
        na = one_of("N/A NA").set_parse_action(replace_with(math.nan))
        term = na | num

        term[1, ...].parse_string("324 234 N/A 234") # -> [324, 234, nan, 234]
    """
    return lambda s, l, t: [repl_str]


def remove_quotes(s, l, t):
    """
    Helper parse action for removing quotation marks from parsed
    quoted strings.

    Example::

        # by default, quotation marks are included in parsed results
        quoted_string.parse_string("'Now is the Winter of our Discontent'") # -> ["'Now is the Winter of our Discontent'"]

        # use remove_quotes to strip quotation marks from parsed results
        quoted_string.set_parse_action(remove_quotes)
        quoted_string.parse_string("'Now is the Winter of our Discontent'") # -> ["Now is the Winter of our Discontent"]
    """
    return t[0][1:-1]


def with_attribute(*args, **attr_dict):
    """
    Helper to create a validating parse action to be used with start
    tags created with :class:`make_xml_tags` or
    :class:`make_html_tags`. Use ``with_attribute`` to qualify
    a starting tag with a required attribute value, to avoid false
    matches on common tags such as ``<TD>`` or ``<DIV>``.

    Call ``with_attribute`` with a series of attribute names and
    values. Specify the list of filter attributes names and values as:

    - keyword arguments, as in ``(align="right")``, or
    - as an explicit dict with ``**`` operator, when an attribute
      name is also a Python reserved word, as in ``**{"class":"Customer", "align":"right"}``
    - a list of name-value tuples, as in ``(("ns1:class", "Customer"), ("ns2:align", "right"))``

    For attribute names with a namespace prefix, you must use the second
    form.  Attribute names are matched insensitive to upper/lower case.

    If just testing for ``class`` (with or without a namespace), use
    :class:`with_class`.

    To verify that the attribute exists, but without specifying a value,
    pass ``with_attribute.ANY_VALUE`` as the value.

    Example::

        html = '''
            <div>
            Some text
            <div type="grid">1 4 0 1 0</div>
            <div type="graph">1,3 2,3 1,1</div>
            <div>this has no type</div>
            </div>

        '''
        div,div_end = make_html_tags("div")

        # only match div tag having a type attribute with value "grid"
        div_grid = div().set_parse_action(with_attribute(type="grid"))
        grid_expr = div_grid + SkipTo(div | div_end)("body")
        for grid_header in grid_expr.search_string(html):
            print(grid_header.body)

        # construct a match with any div tag having a type attribute, regardless of the value
        div_any_type = div().set_parse_action(with_attribute(type=with_attribute.ANY_VALUE))
        div_expr = div_any_type + SkipTo(div | div_end)("body")
        for div_header in div_expr.search_string(html):
            print(div_header.body)

    prints::

        1 4 0 1 0

        1 4 0 1 0
        1,3 2,3 1,1
    """
    if args:
        attrs = args[:]
    else:
        attrs = attr_dict.items()
    attrs = [(k, v) for k, v in attrs]

    def pa(s, l, tokens):
        for attrName, attrValue in attrs:
            if attrName not in tokens:
                raise ParseException(s, l, "no matching attribute " + attrName)
            if attrValue != with_attribute.ANY_VALUE and tokens[attrName] != attrValue:
                raise ParseException(
                    s,
                    l,
                    f"attribute {attrName!r} has value {tokens[attrName]!r}, must be {attrValue!r}",
                )

    return pa


with_attribute.ANY_VALUE = object()  # type: ignore [attr-defined]


def with_class(classname, namespace=""):
    """
    Simplified version of :class:`with_attribute` when
    matching on a div class - made difficult because ``class`` is
    a reserved word in Python.

    Example::

        html = '''
            <div>
            Some text
            <div class="grid">1 4 0 1 0</div>
            <div class="graph">1,3 2,3 1,1</div>
            <div>this &lt;div&gt; has no class</div>
            </div>

        '''
        div,div_end = make_html_tags("div")
        div_grid = div().set_parse_action(with_class("grid"))

        grid_expr = div_grid + SkipTo(div | div_end)("body")
        for grid_header in grid_expr.search_string(html):
            print(grid_header.body)

        div_any_type = div().set_parse_action(with_class(withAttribute.ANY_VALUE))
        div_expr = div_any_type + SkipTo(div | div_end)("body")
        for div_header in div_expr.search_string(html):
            print(div_header.body)

    prints::

        1 4 0 1 0

        1 4 0 1 0
        1,3 2,3 1,1
    """
    classattr = f"{namespace}:class" if namespace else "class"
    return with_attribute(**{classattr: classname})


# pre-PEP8 compatibility symbols
# fmt: off
@replaced_by_pep8(replace_with)
def replaceWith(): ...

@replaced_by_pep8(remove_quotes)
def removeQuotes(): ...

@replaced_by_pep8(with_attribute)
def withAttribute(): ...

@replaced_by_pep8(with_class)
def withClass(): ...

@replaced_by_pep8(match_only_at_col)
def matchOnlyAtCol(): ...

# fmt: on

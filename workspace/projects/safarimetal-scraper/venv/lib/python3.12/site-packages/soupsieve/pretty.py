"""
Format a pretty string of a `SoupSieve` object for easy debugging.

This won't necessarily support all types and such, and definitely
not support custom outputs.

It is mainly geared towards our types as the `SelectorList`
object is a beast to look at without some indentation and newlines.
The format and various output types is fairly known (though it
hasn't been tested extensively to make sure we aren't missing corners).

Example:
-------
```
>>> import soupsieve as sv
>>> sv.compile('this > that.class[name=value]').selectors.pretty()
SelectorList(
    selectors=(
        Selector(
            tag=SelectorTag(
                name='that',
                prefix=None),
            ids=(),
            classes=(
                'class',
                ),
            attributes=(
                SelectorAttribute(
                    attribute='name',
                    prefix='',
                    pattern=re.compile(
                        '^value$'),
                    xml_type_pattern=None),
                ),
            nth=(),
            selectors=(),
            relation=SelectorList(
                selectors=(
                    Selector(
                        tag=SelectorTag(
                            name='this',
                            prefix=None),
                        ids=(),
                        classes=(),
                        attributes=(),
                        nth=(),
                        selectors=(),
                        relation=SelectorList(
                            selectors=(),
                            is_not=False,
                            is_html=False),
                        rel_type='>',
                        contains=(),
                        lang=(),
                        flags=0),
                    ),
                is_not=False,
                is_html=False),
            rel_type=None,
            contains=(),
            lang=(),
            flags=0),
        ),
    is_not=False,
    is_html=False)
```

"""
from __future__ import annotations
import re
from typing import Any

RE_CLASS = re.compile(r'(?i)[a-z_][_a-z\d.]+\(')
RE_PARAM = re.compile(r'(?i)[_a-z][_a-z\d]+=')
RE_EMPTY = re.compile(r'\(\)|\[\]|\{\}')
RE_LSTRT = re.compile(r'\[')
RE_DSTRT = re.compile(r'\{')
RE_TSTRT = re.compile(r'\(')
RE_LEND = re.compile(r'\]')
RE_DEND = re.compile(r'\}')
RE_TEND = re.compile(r'\)')
RE_INT = re.compile(r'\d+')
RE_KWORD = re.compile(r'(?i)[_a-z][_a-z\d.]+')
RE_DQSTR = re.compile(r'"(?:\\.|[^"\\])*"')
RE_SQSTR = re.compile(r"'(?:\\.|[^'\\])*'")
RE_SEP = re.compile(r'\s*(,)\s*')
RE_DSEP = re.compile(r'\s*(:)\s*')
RE_PSEP = re.compile(r'\s*(\|)\s*')

TOKENS = {
    'class': RE_CLASS,
    'param': RE_PARAM,
    'empty': RE_EMPTY,
    'lstrt': RE_LSTRT,
    'dstrt': RE_DSTRT,
    'tstrt': RE_TSTRT,
    'lend': RE_LEND,
    'dend': RE_DEND,
    'tend': RE_TEND,
    'sqstr': RE_SQSTR,
    'sep': RE_SEP,
    'dsep': RE_DSEP,
    'psep': RE_PSEP,
    'int': RE_INT,
    'kword': RE_KWORD,
    'dqstr': RE_DQSTR
}


def pretty(obj: Any) -> str:  # pragma: no cover
    """Make the object output string pretty."""

    sel = str(obj)
    index = 0
    end = len(sel) - 1
    indent = 0
    output = []

    while index <= end:
        m = None
        for k, v in TOKENS.items():
            m = v.match(sel, index)

            if m:
                name = k
                index = m.end(0)
                if name in ('class', 'lstrt', 'dstrt', 'tstrt'):
                    indent += 4
                    output.append(f'{m.group(0)}\n{" " * indent}')
                elif name in ('param', 'int', 'kword', 'sqstr', 'dqstr', 'empty'):
                    output.append(m.group(0))
                elif name in ('lend', 'dend', 'tend'):
                    indent -= 4
                    output.append(m.group(0))
                elif name in ('sep',):
                    output.append(f'{m.group(1)}\n{" " * indent}')
                elif name in ('dsep',):
                    output.append(f'{m.group(1)} ')
                elif name in ('psep'):
                    output.append(f' {m.group(1)} ')
                break

        # We shouldn't hit this, but if we do, store unrecognized character
        if m is None:  # pragma: no cover
            output.append(sel[index])
            index += 1

    return ''.join(output)

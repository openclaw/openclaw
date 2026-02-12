"""
    pygments.formatters.latex
    ~~~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for LaTeX fancyvrb output.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from io import StringIO

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.lexer import Lexer, do_insertions
from pip._vendor.pygments.token import Token, STANDARD_TYPES
from pip._vendor.pygments.util import get_bool_opt, get_int_opt


__all__ = ['LatexFormatter']


def escape_tex(text, commandprefix):
    return text.replace('\\', '\x00'). \
                replace('{', '\x01'). \
                replace('}', '\x02'). \
                replace('\x00', r'\%sZbs{}' % commandprefix). \
                replace('\x01', r'\%sZob{}' % commandprefix). \
                replace('\x02', r'\%sZcb{}' % commandprefix). \
                replace('^', r'\%sZca{}' % commandprefix). \
                replace('_', r'\%sZus{}' % commandprefix). \
                replace('&', r'\%sZam{}' % commandprefix). \
                replace('<', r'\%sZlt{}' % commandprefix). \
                replace('>', r'\%sZgt{}' % commandprefix). \
                replace('#', r'\%sZsh{}' % commandprefix). \
                replace('%', r'\%sZpc{}' % commandprefix). \
                replace('$', r'\%sZdl{}' % commandprefix). \
                replace('-', r'\%sZhy{}' % commandprefix). \
                replace("'", r'\%sZsq{}' % commandprefix). \
                replace('"', r'\%sZdq{}' % commandprefix). \
                replace('~', r'\%sZti{}' % commandprefix)


DOC_TEMPLATE = r'''
\documentclass{%(docclass)s}
\usepackage{fancyvrb}
\usepackage{color}
\usepackage[%(encoding)s]{inputenc}
%(preamble)s

%(styledefs)s

\begin{document}

\section*{%(title)s}

%(code)s
\end{document}
'''

## Small explanation of the mess below :)
#
# The previous version of the LaTeX formatter just assigned a command to
# each token type defined in the current style.  That obviously is
# problematic if the highlighted code is produced for a different style
# than the style commands themselves.
#
# This version works much like the HTML formatter which assigns multiple
# CSS classes to each <span> tag, from the most specific to the least
# specific token type, thus falling back to the parent token type if one
# is not defined.  Here, the classes are there too and use the same short
# forms given in token.STANDARD_TYPES.
#
# Highlighted code now only uses one custom command, which by default is
# \PY and selectable by the commandprefix option (and in addition the
# escapes \PYZat, \PYZlb and \PYZrb which haven't been renamed for
# backwards compatibility purposes).
#
# \PY has two arguments: the classes, separated by +, and the text to
# render in that style.  The classes are resolved into the respective
# style commands by magic, which serves to ignore unknown classes.
#
# The magic macros are:
# * \PY@it, \PY@bf, etc. are unconditionally wrapped around the text
#   to render in \PY@do.  Their definition determines the style.
# * \PY@reset resets \PY@it etc. to do nothing.
# * \PY@toks parses the list of classes, using magic inspired by the
#   keyval package (but modified to use plusses instead of commas
#   because fancyvrb redefines commas inside its environments).
# * \PY@tok processes one class, calling the \PY@tok@classname command
#   if it exists.
# * \PY@tok@classname sets the \PY@it etc. to reflect the chosen style
#   for its class.
# * \PY resets the style, parses the classnames and then calls \PY@do.
#
# Tip: to read this code, print it out in substituted form using e.g.
# >>> print STYLE_TEMPLATE % {'cp': 'PY'}

STYLE_TEMPLATE = r'''
\makeatletter
\def\%(cp)s@reset{\let\%(cp)s@it=\relax \let\%(cp)s@bf=\relax%%
    \let\%(cp)s@ul=\relax \let\%(cp)s@tc=\relax%%
    \let\%(cp)s@bc=\relax \let\%(cp)s@ff=\relax}
\def\%(cp)s@tok#1{\csname %(cp)s@tok@#1\endcsname}
\def\%(cp)s@toks#1+{\ifx\relax#1\empty\else%%
    \%(cp)s@tok{#1}\expandafter\%(cp)s@toks\fi}
\def\%(cp)s@do#1{\%(cp)s@bc{\%(cp)s@tc{\%(cp)s@ul{%%
    \%(cp)s@it{\%(cp)s@bf{\%(cp)s@ff{#1}}}}}}}
\def\%(cp)s#1#2{\%(cp)s@reset\%(cp)s@toks#1+\relax+\%(cp)s@do{#2}}

%(styles)s

\def\%(cp)sZbs{\char`\\}
\def\%(cp)sZus{\char`\_}
\def\%(cp)sZob{\char`\{}
\def\%(cp)sZcb{\char`\}}
\def\%(cp)sZca{\char`\^}
\def\%(cp)sZam{\char`\&}
\def\%(cp)sZlt{\char`\<}
\def\%(cp)sZgt{\char`\>}
\def\%(cp)sZsh{\char`\#}
\def\%(cp)sZpc{\char`\%%}
\def\%(cp)sZdl{\char`\$}
\def\%(cp)sZhy{\char`\-}
\def\%(cp)sZsq{\char`\'}
\def\%(cp)sZdq{\char`\"}
\def\%(cp)sZti{\char`\~}
%% for compatibility with earlier versions
\def\%(cp)sZat{@}
\def\%(cp)sZlb{[}
\def\%(cp)sZrb{]}
\makeatother
'''


def _get_ttype_name(ttype):
    fname = STANDARD_TYPES.get(ttype)
    if fname:
        return fname
    aname = ''
    while fname is None:
        aname = ttype[-1] + aname
        ttype = ttype.parent
        fname = STANDARD_TYPES.get(ttype)
    return fname + aname


class LatexFormatter(Formatter):
    r"""
    Format tokens as LaTeX code. This needs the `fancyvrb` and `color`
    standard packages.

    Without the `full` option, code is formatted as one ``Verbatim``
    environment, like this:

    .. sourcecode:: latex

        \begin{Verbatim}[commandchars=\\\{\}]
        \PY{k}{def }\PY{n+nf}{foo}(\PY{n}{bar}):
            \PY{k}{pass}
        \end{Verbatim}

    Wrapping can be disabled using the `nowrap` option.

    The special command used here (``\PY``) and all the other macros it needs
    are output by the `get_style_defs` method.

    With the `full` option, a complete LaTeX document is output, including
    the command definitions in the preamble.

    The `get_style_defs()` method of a `LatexFormatter` returns a string
    containing ``\def`` commands defining the macros needed inside the
    ``Verbatim`` environments.

    Additional options accepted:

    `nowrap`
        If set to ``True``, don't wrap the tokens at all, not even inside a
        ``\begin{Verbatim}`` environment. This disables most other options
        (default: ``False``).

    `style`
        The style to use, can be a string or a Style subclass (default:
        ``'default'``).

    `full`
        Tells the formatter to output a "full" document, i.e. a complete
        self-contained document (default: ``False``).

    `title`
        If `full` is true, the title that should be used to caption the
        document (default: ``''``).

    `docclass`
        If the `full` option is enabled, this is the document class to use
        (default: ``'article'``).

    `preamble`
        If the `full` option is enabled, this can be further preamble commands,
        e.g. ``\usepackage`` (default: ``''``).

    `linenos`
        If set to ``True``, output line numbers (default: ``False``).

    `linenostart`
        The line number for the first line (default: ``1``).

    `linenostep`
        If set to a number n > 1, only every nth line number is printed.

    `verboptions`
        Additional options given to the Verbatim environment (see the *fancyvrb*
        docs for possible values) (default: ``''``).

    `commandprefix`
        The LaTeX commands used to produce colored output are constructed
        using this prefix and some letters (default: ``'PY'``).

        .. versionadded:: 0.7
        .. versionchanged:: 0.10
           The default is now ``'PY'`` instead of ``'C'``.

    `texcomments`
        If set to ``True``, enables LaTeX comment lines.  That is, LaTex markup
        in comment tokens is not escaped so that LaTeX can render it (default:
        ``False``).

        .. versionadded:: 1.2

    `mathescape`
        If set to ``True``, enables LaTeX math mode escape in comments. That
        is, ``'$...$'`` inside a comment will trigger math mode (default:
        ``False``).

        .. versionadded:: 1.2

    `escapeinside`
        If set to a string of length 2, enables escaping to LaTeX. Text
        delimited by these 2 characters is read as LaTeX code and
        typeset accordingly. It has no effect in string literals. It has
        no effect in comments if `texcomments` or `mathescape` is
        set. (default: ``''``).

        .. versionadded:: 2.0

    `envname`
        Allows you to pick an alternative environment name replacing Verbatim.
        The alternate environment still has to support Verbatim's option syntax.
        (default: ``'Verbatim'``).

        .. versionadded:: 2.0
    """
    name = 'LaTeX'
    aliases = ['latex', 'tex']
    filenames = ['*.tex']

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        self.nowrap = get_bool_opt(options, 'nowrap', False)
        self.docclass = options.get('docclass', 'article')
        self.preamble = options.get('preamble', '')
        self.linenos = get_bool_opt(options, 'linenos', False)
        self.linenostart = abs(get_int_opt(options, 'linenostart', 1))
        self.linenostep = abs(get_int_opt(options, 'linenostep', 1))
        self.verboptions = options.get('verboptions', '')
        self.nobackground = get_bool_opt(options, 'nobackground', False)
        self.commandprefix = options.get('commandprefix', 'PY')
        self.texcomments = get_bool_opt(options, 'texcomments', False)
        self.mathescape = get_bool_opt(options, 'mathescape', False)
        self.escapeinside = options.get('escapeinside', '')
        if len(self.escapeinside) == 2:
            self.left = self.escapeinside[0]
            self.right = self.escapeinside[1]
        else:
            self.escapeinside = ''
        self.envname = options.get('envname', 'Verbatim')

        self._create_stylesheet()

    def _create_stylesheet(self):
        t2n = self.ttype2name = {Token: ''}
        c2d = self.cmd2def = {}
        cp = self.commandprefix

        def rgbcolor(col):
            if col:
                return ','.join(['%.2f' % (int(col[i] + col[i + 1], 16) / 255.0)
                                 for i in (0, 2, 4)])
            else:
                return '1,1,1'

        for ttype, ndef in self.style:
            name = _get_ttype_name(ttype)
            cmndef = ''
            if ndef['bold']:
                cmndef += r'\let\$$@bf=\textbf'
            if ndef['italic']:
                cmndef += r'\let\$$@it=\textit'
            if ndef['underline']:
                cmndef += r'\let\$$@ul=\underline'
            if ndef['roman']:
                cmndef += r'\let\$$@ff=\textrm'
            if ndef['sans']:
                cmndef += r'\let\$$@ff=\textsf'
            if ndef['mono']:
                cmndef += r'\let\$$@ff=\textsf'
            if ndef['color']:
                cmndef += (r'\def\$$@tc##1{\textcolor[rgb]{%s}{##1}}' %
                           rgbcolor(ndef['color']))
            if ndef['border']:
                cmndef += (r'\def\$$@bc##1{{\setlength{\fboxsep}{\string -\fboxrule}'
                           r'\fcolorbox[rgb]{%s}{%s}{\strut ##1}}}' %
                           (rgbcolor(ndef['border']),
                            rgbcolor(ndef['bgcolor'])))
            elif ndef['bgcolor']:
                cmndef += (r'\def\$$@bc##1{{\setlength{\fboxsep}{0pt}'
                           r'\colorbox[rgb]{%s}{\strut ##1}}}' %
                           rgbcolor(ndef['bgcolor']))
            if cmndef == '':
                continue
            cmndef = cmndef.replace('$$', cp)
            t2n[ttype] = name
            c2d[name] = cmndef

    def get_style_defs(self, arg=''):
        """
        Return the command sequences needed to define the commands
        used to format text in the verbatim environment. ``arg`` is ignored.
        """
        cp = self.commandprefix
        styles = []
        for name, definition in self.cmd2def.items():
            styles.append(r'\@namedef{%s@tok@%s}{%s}' % (cp, name, definition))
        return STYLE_TEMPLATE % {'cp': self.commandprefix,
                                 'styles': '\n'.join(styles)}

    def format_unencoded(self, tokensource, outfile):
        # TODO: add support for background colors
        t2n = self.ttype2name
        cp = self.commandprefix

        if self.full:
            realoutfile = outfile
            outfile = StringIO()

        if not self.nowrap:
            outfile.write('\\begin{' + self.envname + '}[commandchars=\\\\\\{\\}')
            if self.linenos:
                start, step = self.linenostart, self.linenostep
                outfile.write(',numbers=left' +
                              (start and ',firstnumber=%d' % start or '') +
                              (step and ',stepnumber=%d' % step or ''))
            if self.mathescape or self.texcomments or self.escapeinside:
                outfile.write(',codes={\\catcode`\\$=3\\catcode`\\^=7'
                              '\\catcode`\\_=8\\relax}')
            if self.verboptions:
                outfile.write(',' + self.verboptions)
            outfile.write(']\n')

        for ttype, value in tokensource:
            if ttype in Token.Comment:
                if self.texcomments:
                    # Try to guess comment starting lexeme and escape it ...
                    start = value[0:1]
                    for i in range(1, len(value)):
                        if start[0] != value[i]:
                            break
                        start += value[i]

                    value = value[len(start):]
                    start = escape_tex(start, cp)

                    # ... but do not escape inside comment.
                    value = start + value
                elif self.mathescape:
                    # Only escape parts not inside a math environment.
                    parts = value.split('$')
                    in_math = False
                    for i, part in enumerate(parts):
                        if not in_math:
                            parts[i] = escape_tex(part, cp)
                        in_math = not in_math
                    value = '$'.join(parts)
                elif self.escapeinside:
                    text = value
                    value = ''
                    while text:
                        a, sep1, text = text.partition(self.left)
                        if sep1:
                            b, sep2, text = text.partition(self.right)
                            if sep2:
                                value += escape_tex(a, cp) + b
                            else:
                                value += escape_tex(a + sep1 + b, cp)
                        else:
                            value += escape_tex(a, cp)
                else:
                    value = escape_tex(value, cp)
            elif ttype not in Token.Escape:
                value = escape_tex(value, cp)
            styles = []
            while ttype is not Token:
                try:
                    styles.append(t2n[ttype])
                except KeyError:
                    # not in current style
                    styles.append(_get_ttype_name(ttype))
                ttype = ttype.parent
            styleval = '+'.join(reversed(styles))
            if styleval:
                spl = value.split('\n')
                for line in spl[:-1]:
                    if line:
                        outfile.write("\\%s{%s}{%s}" % (cp, styleval, line))
                    outfile.write('\n')
                if spl[-1]:
                    outfile.write("\\%s{%s}{%s}" % (cp, styleval, spl[-1]))
            else:
                outfile.write(value)

        if not self.nowrap:
            outfile.write('\\end{' + self.envname + '}\n')

        if self.full:
            encoding = self.encoding or 'utf8'
            # map known existings encodings from LaTeX distribution
            encoding = {
                'utf_8': 'utf8',
                'latin_1': 'latin1',
                'iso_8859_1': 'latin1',
            }.get(encoding.replace('-', '_'), encoding)
            realoutfile.write(DOC_TEMPLATE %
                dict(docclass  = self.docclass,
                     preamble  = self.preamble,
                     title     = self.title,
                     encoding  = encoding,
                     styledefs = self.get_style_defs(),
                     code      = outfile.getvalue()))


class LatexEmbeddedLexer(Lexer):
    """
    This lexer takes one lexer as argument, the lexer for the language
    being formatted, and the left and right delimiters for escaped text.

    First everything is scanned using the language lexer to obtain
    strings and comments. All other consecutive tokens are merged and
    the resulting text is scanned for escaped segments, which are given
    the Token.Escape type. Finally text that is not escaped is scanned
    again with the language lexer.
    """
    def __init__(self, left, right, lang, **options):
        self.left = left
        self.right = right
        self.lang = lang
        Lexer.__init__(self, **options)

    def get_tokens_unprocessed(self, text):
        # find and remove all the escape tokens (replace with an empty string)
        # this is very similar to DelegatingLexer.get_tokens_unprocessed.
        buffered = ''
        insertions = []
        insertion_buf = []
        for i, t, v in self._find_safe_escape_tokens(text):
            if t is None:
                if insertion_buf:
                    insertions.append((len(buffered), insertion_buf))
                    insertion_buf = []
                buffered += v
            else:
                insertion_buf.append((i, t, v))
        if insertion_buf:
            insertions.append((len(buffered), insertion_buf))
        return do_insertions(insertions,
                             self.lang.get_tokens_unprocessed(buffered))

    def _find_safe_escape_tokens(self, text):
        """ find escape tokens that are not in strings or comments """
        for i, t, v in self._filter_to(
            self.lang.get_tokens_unprocessed(text),
            lambda t: t in Token.Comment or t in Token.String
        ):
            if t is None:
                for i2, t2, v2 in self._find_escape_tokens(v):
                    yield i + i2, t2, v2
            else:
                yield i, None, v

    def _filter_to(self, it, pred):
        """ Keep only the tokens that match `pred`, merge the others together """
        buf = ''
        idx = 0
        for i, t, v in it:
            if pred(t):
                if buf:
                    yield idx, None, buf
                    buf = ''
                yield i, t, v
            else:
                if not buf:
                    idx = i
                buf += v
        if buf:
            yield idx, None, buf

    def _find_escape_tokens(self, text):
        """ Find escape tokens within text, give token=None otherwise """
        index = 0
        while text:
            a, sep1, text = text.partition(self.left)
            if a:
                yield index, None, a
                index += len(a)
            if sep1:
                b, sep2, text = text.partition(self.right)
                if sep2:
                    yield index + len(sep1), Token.Escape, b
                    index += len(sep1) + len(b) + len(sep2)
                else:
                    yield index, Token.Error, sep1
                    index += len(sep1)
                    text = b

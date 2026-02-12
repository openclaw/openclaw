"""
    pygments.formatters.terminal
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for terminal output with ANSI sequences.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.token import Keyword, Name, Comment, String, Error, \
    Number, Operator, Generic, Token, Whitespace
from pip._vendor.pygments.console import ansiformat
from pip._vendor.pygments.util import get_choice_opt


__all__ = ['TerminalFormatter']


#: Map token types to a tuple of color values for light and dark
#: backgrounds.
TERMINAL_COLORS = {
    Token:              ('',            ''),

    Whitespace:         ('gray',   'brightblack'),
    Comment:            ('gray',   'brightblack'),
    Comment.Preproc:    ('cyan',        'brightcyan'),
    Keyword:            ('blue',    'brightblue'),
    Keyword.Type:       ('cyan',        'brightcyan'),
    Operator.Word:      ('magenta',      'brightmagenta'),
    Name.Builtin:       ('cyan',        'brightcyan'),
    Name.Function:      ('green',   'brightgreen'),
    Name.Namespace:     ('_cyan_',      '_brightcyan_'),
    Name.Class:         ('_green_', '_brightgreen_'),
    Name.Exception:     ('cyan',        'brightcyan'),
    Name.Decorator:     ('brightblack',    'gray'),
    Name.Variable:      ('red',     'brightred'),
    Name.Constant:      ('red',     'brightred'),
    Name.Attribute:     ('cyan',        'brightcyan'),
    Name.Tag:           ('brightblue',        'brightblue'),
    String:             ('yellow',       'yellow'),
    Number:             ('blue',    'brightblue'),

    Generic.Deleted:    ('brightred',        'brightred'),
    Generic.Inserted:   ('green',  'brightgreen'),
    Generic.Heading:    ('**',         '**'),
    Generic.Subheading: ('*magenta*',   '*brightmagenta*'),
    Generic.Prompt:     ('**',         '**'),
    Generic.Error:      ('brightred',        'brightred'),

    Error:              ('_brightred_',      '_brightred_'),
}


class TerminalFormatter(Formatter):
    r"""
    Format tokens with ANSI color sequences, for output in a text console.
    Color sequences are terminated at newlines, so that paging the output
    works correctly.

    The `get_style_defs()` method doesn't do anything special since there is
    no support for common styles.

    Options accepted:

    `bg`
        Set to ``"light"`` or ``"dark"`` depending on the terminal's background
        (default: ``"light"``).

    `colorscheme`
        A dictionary mapping token types to (lightbg, darkbg) color names or
        ``None`` (default: ``None`` = use builtin colorscheme).

    `linenos`
        Set to ``True`` to have line numbers on the terminal output as well
        (default: ``False`` = no line numbers).
    """
    name = 'Terminal'
    aliases = ['terminal', 'console']
    filenames = []

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        self.darkbg = get_choice_opt(options, 'bg',
                                     ['light', 'dark'], 'light') == 'dark'
        self.colorscheme = options.get('colorscheme', None) or TERMINAL_COLORS
        self.linenos = options.get('linenos', False)
        self._lineno = 0

    def format(self, tokensource, outfile):
        return Formatter.format(self, tokensource, outfile)

    def _write_lineno(self, outfile):
        self._lineno += 1
        outfile.write("%s%04d: " % (self._lineno != 1 and '\n' or '', self._lineno))

    def _get_color(self, ttype):
        # self.colorscheme is a dict containing usually generic types, so we
        # have to walk the tree of dots.  The base Token type must be a key,
        # even if it's empty string, as in the default above.
        colors = self.colorscheme.get(ttype)
        while colors is None:
            ttype = ttype.parent
            colors = self.colorscheme.get(ttype)
        return colors[self.darkbg]

    def format_unencoded(self, tokensource, outfile):
        if self.linenos:
            self._write_lineno(outfile)

        for ttype, value in tokensource:
            color = self._get_color(ttype)

            for line in value.splitlines(True):
                if color:
                    outfile.write(ansiformat(color, line.rstrip('\n')))
                else:
                    outfile.write(line.rstrip('\n'))
                if line.endswith('\n'):
                    if self.linenos:
                        self._write_lineno(outfile)
                    else:
                        outfile.write('\n')

        if self.linenos:
            outfile.write("\n")

"""
    pygments.formatters.irc
    ~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for IRC output

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.token import Keyword, Name, Comment, String, Error, \
    Number, Operator, Generic, Token, Whitespace
from pip._vendor.pygments.util import get_choice_opt


__all__ = ['IRCFormatter']


#: Map token types to a tuple of color values for light and dark
#: backgrounds.
IRC_COLORS = {
    Token:              ('',            ''),

    Whitespace:         ('gray',   'brightblack'),
    Comment:            ('gray',   'brightblack'),
    Comment.Preproc:    ('cyan',        'brightcyan'),
    Keyword:            ('blue',    'brightblue'),
    Keyword.Type:       ('cyan',        'brightcyan'),
    Operator.Word:      ('magenta',      'brightcyan'),
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
    Generic.Error:      ('brightred',        'brightred'),

    Error:              ('_brightred_',      '_brightred_'),
}


IRC_COLOR_MAP = {
    'white': 0,
    'black': 1,
    'blue': 2,
    'brightgreen': 3,
    'brightred': 4,
    'yellow': 5,
    'magenta': 6,
    'orange': 7,
    'green': 7, #compat w/ ansi
    'brightyellow': 8,
    'lightgreen': 9,
    'brightcyan': 9, # compat w/ ansi
    'cyan': 10,
    'lightblue': 11,
    'red': 11, # compat w/ ansi
    'brightblue': 12,
    'brightmagenta': 13,
    'brightblack': 14,
    'gray': 15,
}

def ircformat(color, text):
    if len(color) < 1:
        return text
    add = sub = ''
    if '_' in color: # italic
        add += '\x1D'
        sub = '\x1D' + sub
        color = color.strip('_')
    if '*' in color: # bold
        add += '\x02'
        sub = '\x02' + sub
        color = color.strip('*')
    # underline (\x1F) not supported
    # backgrounds (\x03FF,BB) not supported
    if len(color) > 0: # actual color - may have issues with ircformat("red", "blah")+"10" type stuff
        add += '\x03' + str(IRC_COLOR_MAP[color]).zfill(2)
        sub = '\x03' + sub
    return add + text + sub
    return '<'+add+'>'+text+'</'+sub+'>'


class IRCFormatter(Formatter):
    r"""
    Format tokens with IRC color sequences

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
        Set to ``True`` to have line numbers in the output as well
        (default: ``False`` = no line numbers).
    """
    name = 'IRC'
    aliases = ['irc', 'IRC']
    filenames = []

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        self.darkbg = get_choice_opt(options, 'bg',
                                     ['light', 'dark'], 'light') == 'dark'
        self.colorscheme = options.get('colorscheme', None) or IRC_COLORS
        self.linenos = options.get('linenos', False)
        self._lineno = 0

    def _write_lineno(self, outfile):
        if self.linenos:
            self._lineno += 1
            outfile.write("%04d: " % self._lineno)

    def format_unencoded(self, tokensource, outfile):
        self._write_lineno(outfile)

        for ttype, value in tokensource:
            color = self.colorscheme.get(ttype)
            while color is None:
                ttype = ttype[:-1]
                color = self.colorscheme.get(ttype)
            if color:
                color = color[self.darkbg]
                spl = value.split('\n')
                for line in spl[:-1]:
                    if line:
                        outfile.write(ircformat(color, line))
                    outfile.write('\n')
                    self._write_lineno(outfile)
                if spl[-1]:
                    outfile.write(ircformat(color, spl[-1]))
            else:
                outfile.write(value)

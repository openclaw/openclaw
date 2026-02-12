"""
    pygments.formatters.groff
    ~~~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for groff output.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

import math
from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.util import get_bool_opt, get_int_opt

__all__ = ['GroffFormatter']


class GroffFormatter(Formatter):
    """
    Format tokens with groff escapes to change their color and font style.

    .. versionadded:: 2.11

    Additional options accepted:

    `style`
        The style to use, can be a string or a Style subclass (default:
        ``'default'``).

    `monospaced`
        If set to true, monospace font will be used (default: ``true``).

    `linenos`
        If set to true, print the line numbers (default: ``false``).

    `wrap`
        Wrap lines to the specified number of characters. Disabled if set to 0
        (default: ``0``).
    """

    name = 'groff'
    aliases = ['groff','troff','roff']
    filenames = []

    def __init__(self, **options):
        Formatter.__init__(self, **options)

        self.monospaced = get_bool_opt(options, 'monospaced', True)
        self.linenos = get_bool_opt(options, 'linenos', False)
        self._lineno = 0
        self.wrap = get_int_opt(options, 'wrap', 0)
        self._linelen = 0

        self.styles = {}
        self._make_styles()


    def _make_styles(self):
        regular = '\\f[CR]' if self.monospaced else '\\f[R]'
        bold = '\\f[CB]' if self.monospaced else '\\f[B]'
        italic = '\\f[CI]' if self.monospaced else '\\f[I]'

        for ttype, ndef in self.style:
            start = end = ''
            if ndef['color']:
                start += '\\m[%s]' % ndef['color']
                end = '\\m[]' + end
            if ndef['bold']:
                start += bold
                end = regular + end
            if ndef['italic']:
                start += italic
                end = regular + end
            if ndef['bgcolor']:
                start += '\\M[%s]' % ndef['bgcolor']
                end = '\\M[]' + end

            self.styles[ttype] = start, end


    def _define_colors(self, outfile):
        colors = set()
        for _, ndef in self.style:
            if ndef['color'] is not None:
                colors.add(ndef['color'])

        for color in sorted(colors):
            outfile.write('.defcolor ' + color + ' rgb #' + color + '\n')


    def _write_lineno(self, outfile):
        self._lineno += 1
        outfile.write("%s% 4d " % (self._lineno != 1 and '\n' or '', self._lineno))


    def _wrap_line(self, line):
        length = len(line.rstrip('\n'))
        space = '     ' if self.linenos else ''
        newline = ''

        if length > self.wrap:
            for i in range(0, math.floor(length / self.wrap)):
                chunk = line[i*self.wrap:i*self.wrap+self.wrap]
                newline += (chunk + '\n' + space)
            remainder = length % self.wrap
            if remainder > 0:
                newline += line[-remainder-1:]
                self._linelen = remainder
        elif self._linelen + length > self.wrap:
            newline = ('\n' + space) + line
            self._linelen = length
        else:
            newline = line
            self._linelen += length

        return newline


    def _escape_chars(self, text):
        text = text.replace('\\', '\\[u005C]'). \
                    replace('.', '\\[char46]'). \
                    replace('\'', '\\[u0027]'). \
                    replace('`', '\\[u0060]'). \
                    replace('~', '\\[u007E]')
        copy = text

        for char in copy:
            if len(char) != len(char.encode()):
                uni = char.encode('unicode_escape') \
                    .decode()[1:] \
                    .replace('x', 'u00') \
                    .upper()
                text = text.replace(char, '\\[u' + uni[1:] + ']')

        return text


    def format_unencoded(self, tokensource, outfile):
        self._define_colors(outfile)

        outfile.write('.nf\n\\f[CR]\n')

        if self.linenos:
            self._write_lineno(outfile)

        for ttype, value in tokensource:
            while ttype not in self.styles:
                ttype = ttype.parent
            start, end = self.styles[ttype]

            for line in value.splitlines(True):
                if self.wrap > 0:
                    line = self._wrap_line(line)

                if start and end:
                    text = self._escape_chars(line.rstrip('\n'))
                    if text != '':
                        outfile.write(''.join((start, text, end)))
                else:
                    outfile.write(self._escape_chars(line.rstrip('\n')))

                if line.endswith('\n'):
                    if self.linenos:
                        self._write_lineno(outfile)
                        self._linelen = 0
                    else:
                        outfile.write('\n')
                        self._linelen = 0

        outfile.write('\n.fi')

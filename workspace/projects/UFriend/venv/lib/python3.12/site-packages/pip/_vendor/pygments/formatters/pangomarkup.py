"""
    pygments.formatters.pangomarkup
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for Pango markup output.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.formatter import Formatter


__all__ = ['PangoMarkupFormatter']


_escape_table = {
    ord('&'): '&amp;',
    ord('<'): '&lt;',
}


def escape_special_chars(text, table=_escape_table):
    """Escape & and < for Pango Markup."""
    return text.translate(table)


class PangoMarkupFormatter(Formatter):
    """
    Format tokens as Pango Markup code. It can then be rendered to an SVG.

    .. versionadded:: 2.9
    """

    name = 'Pango Markup'
    aliases = ['pango', 'pangomarkup']
    filenames = []

    def __init__(self, **options):
        Formatter.__init__(self, **options)

        self.styles = {}

        for token, style in self.style:
            start = ''
            end = ''
            if style['color']:
                start += '<span fgcolor="#%s">' % style['color']
                end = '</span>' + end
            if style['bold']:
                start += '<b>'
                end = '</b>' + end
            if style['italic']:
                start += '<i>'
                end = '</i>' + end
            if style['underline']:
                start += '<u>'
                end = '</u>' + end
            self.styles[token] = (start, end)

    def format_unencoded(self, tokensource, outfile):
        lastval = ''
        lasttype = None

        outfile.write('<tt>')

        for ttype, value in tokensource:
            while ttype not in self.styles:
                ttype = ttype.parent
            if ttype == lasttype:
                lastval += escape_special_chars(value)
            else:
                if lastval:
                    stylebegin, styleend = self.styles[lasttype]
                    outfile.write(stylebegin + lastval + styleend)
                lastval = escape_special_chars(value)
                lasttype = ttype

        if lastval:
            stylebegin, styleend = self.styles[lasttype]
            outfile.write(stylebegin + lastval + styleend)

        outfile.write('</tt>')

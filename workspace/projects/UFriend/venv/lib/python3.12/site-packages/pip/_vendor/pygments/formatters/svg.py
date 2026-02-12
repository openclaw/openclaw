"""
    pygments.formatters.svg
    ~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for SVG output.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.token import Comment
from pip._vendor.pygments.util import get_bool_opt, get_int_opt

__all__ = ['SvgFormatter']


def escape_html(text):
    """Escape &, <, > as well as single and double quotes for HTML."""
    return text.replace('&', '&amp;').  \
                replace('<', '&lt;').   \
                replace('>', '&gt;').   \
                replace('"', '&quot;'). \
                replace("'", '&#39;')


class2style = {}

class SvgFormatter(Formatter):
    """
    Format tokens as an SVG graphics file.  This formatter is still experimental.
    Each line of code is a ``<text>`` element with explicit ``x`` and ``y``
    coordinates containing ``<tspan>`` elements with the individual token styles.

    By default, this formatter outputs a full SVG document including doctype
    declaration and the ``<svg>`` root element.

    .. versionadded:: 0.9

    Additional options accepted:

    `nowrap`
        Don't wrap the SVG ``<text>`` elements in ``<svg><g>`` elements and
        don't add a XML declaration and a doctype.  If true, the `fontfamily`
        and `fontsize` options are ignored.  Defaults to ``False``.

    `fontfamily`
        The value to give the wrapping ``<g>`` element's ``font-family``
        attribute, defaults to ``"monospace"``.

    `fontsize`
        The value to give the wrapping ``<g>`` element's ``font-size``
        attribute, defaults to ``"14px"``.

    `linenos`
        If ``True``, add line numbers (default: ``False``).

    `linenostart`
        The line number for the first line (default: ``1``).

    `linenostep`
        If set to a number n > 1, only every nth line number is printed.
        
    `linenowidth`
        Maximum width devoted to line numbers (default: ``3*ystep``, sufficient
        for up to 4-digit line numbers. Increase width for longer code blocks).  
        
    `xoffset`
        Starting offset in X direction, defaults to ``0``.

    `yoffset`
        Starting offset in Y direction, defaults to the font size if it is given
        in pixels, or ``20`` else.  (This is necessary since text coordinates
        refer to the text baseline, not the top edge.)

    `ystep`
        Offset to add to the Y coordinate for each subsequent line.  This should
        roughly be the text size plus 5.  It defaults to that value if the text
        size is given in pixels, or ``25`` else.

    `spacehack`
        Convert spaces in the source to ``&#160;``, which are non-breaking
        spaces.  SVG provides the ``xml:space`` attribute to control how
        whitespace inside tags is handled, in theory, the ``preserve`` value
        could be used to keep all whitespace as-is.  However, many current SVG
        viewers don't obey that rule, so this option is provided as a workaround
        and defaults to ``True``.
    """
    name = 'SVG'
    aliases = ['svg']
    filenames = ['*.svg']

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        self.nowrap = get_bool_opt(options, 'nowrap', False)
        self.fontfamily = options.get('fontfamily', 'monospace')
        self.fontsize = options.get('fontsize', '14px')
        self.xoffset = get_int_opt(options, 'xoffset', 0)
        fs = self.fontsize.strip()
        if fs.endswith('px'): fs = fs[:-2].strip()
        try:
            int_fs = int(fs)
        except:
            int_fs = 20
        self.yoffset = get_int_opt(options, 'yoffset', int_fs)
        self.ystep = get_int_opt(options, 'ystep', int_fs + 5)
        self.spacehack = get_bool_opt(options, 'spacehack', True)
        self.linenos = get_bool_opt(options,'linenos',False)
        self.linenostart = get_int_opt(options,'linenostart',1)
        self.linenostep = get_int_opt(options,'linenostep',1)
        self.linenowidth = get_int_opt(options,'linenowidth', 3*self.ystep)
        self._stylecache = {}

    def format_unencoded(self, tokensource, outfile):
        """
        Format ``tokensource``, an iterable of ``(tokentype, tokenstring)``
        tuples and write it into ``outfile``.

        For our implementation we put all lines in their own 'line group'.
        """
        x = self.xoffset
        y = self.yoffset
        if not self.nowrap:
            if self.encoding:
                outfile.write('<?xml version="1.0" encoding="%s"?>\n' %
                              self.encoding)
            else:
                outfile.write('<?xml version="1.0"?>\n')
            outfile.write('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" '
                          '"http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/'
                          'svg10.dtd">\n')
            outfile.write('<svg xmlns="http://www.w3.org/2000/svg">\n')
            outfile.write('<g font-family="%s" font-size="%s">\n' %
                          (self.fontfamily, self.fontsize))
        
        counter = self.linenostart 
        counter_step = self.linenostep
        counter_style = self._get_style(Comment)
        line_x = x
        
        if self.linenos:
            if counter % counter_step == 0:
                outfile.write('<text x="%s" y="%s" %s text-anchor="end">%s</text>' %
                    (x+self.linenowidth,y,counter_style,counter))
            line_x += self.linenowidth + self.ystep
            counter += 1

        outfile.write('<text x="%s" y="%s" xml:space="preserve">' % (line_x, y))
        for ttype, value in tokensource:
            style = self._get_style(ttype)
            tspan = style and '<tspan' + style + '>' or ''
            tspanend = tspan and '</tspan>' or ''
            value = escape_html(value)
            if self.spacehack:
                value = value.expandtabs().replace(' ', '&#160;')
            parts = value.split('\n')
            for part in parts[:-1]:
                outfile.write(tspan + part + tspanend)
                y += self.ystep
                outfile.write('</text>\n')
                if self.linenos and counter % counter_step == 0:
                    outfile.write('<text x="%s" y="%s" text-anchor="end" %s>%s</text>' %
                        (x+self.linenowidth,y,counter_style,counter))
                
                counter += 1
                outfile.write('<text x="%s" y="%s" ' 'xml:space="preserve">' % (line_x,y))
            outfile.write(tspan + parts[-1] + tspanend)
        outfile.write('</text>')

        if not self.nowrap:
            outfile.write('</g></svg>\n')

    def _get_style(self, tokentype):
        if tokentype in self._stylecache:
            return self._stylecache[tokentype]
        otokentype = tokentype
        while not self.style.styles_token(tokentype):
            tokentype = tokentype.parent
        value = self.style.style_for_token(tokentype)
        result = ''
        if value['color']:
            result = ' fill="#' + value['color'] + '"'
        if value['bold']:
            result += ' font-weight="bold"'
        if value['italic']:
            result += ' font-style="italic"'
        self._stylecache[otokentype] = result
        return result

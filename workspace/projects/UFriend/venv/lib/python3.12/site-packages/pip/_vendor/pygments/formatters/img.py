"""
    pygments.formatters.img
    ~~~~~~~~~~~~~~~~~~~~~~~

    Formatter for Pixmap output.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

import os
import sys

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.util import get_bool_opt, get_int_opt, get_list_opt, \
    get_choice_opt

import subprocess

# Import this carefully
try:
    from PIL import Image, ImageDraw, ImageFont
    pil_available = True
except ImportError:
    pil_available = False

try:
    import _winreg
except ImportError:
    try:
        import winreg as _winreg
    except ImportError:
        _winreg = None

__all__ = ['ImageFormatter', 'GifImageFormatter', 'JpgImageFormatter',
           'BmpImageFormatter']


# For some unknown reason every font calls it something different
STYLES = {
    'NORMAL':     ['', 'Roman', 'Book', 'Normal', 'Regular', 'Medium'],
    'ITALIC':     ['Oblique', 'Italic'],
    'BOLD':       ['Bold'],
    'BOLDITALIC': ['Bold Oblique', 'Bold Italic'],
}

# A sane default for modern systems
DEFAULT_FONT_NAME_NIX = 'DejaVu Sans Mono'
DEFAULT_FONT_NAME_WIN = 'Courier New'
DEFAULT_FONT_NAME_MAC = 'Menlo'


class PilNotAvailable(ImportError):
    """When Python imaging library is not available"""


class FontNotFound(Exception):
    """When there are no usable fonts specified"""


class FontManager:
    """
    Manages a set of fonts: normal, italic, bold, etc...
    """

    def __init__(self, font_name, font_size=14):
        self.font_name = font_name
        self.font_size = font_size
        self.fonts = {}
        self.encoding = None
        if sys.platform.startswith('win'):
            if not font_name:
                self.font_name = DEFAULT_FONT_NAME_WIN
            self._create_win()
        elif sys.platform.startswith('darwin'):
            if not font_name:
                self.font_name = DEFAULT_FONT_NAME_MAC
            self._create_mac()
        else:
            if not font_name:
                self.font_name = DEFAULT_FONT_NAME_NIX
            self._create_nix()

    def _get_nix_font_path(self, name, style):
        proc = subprocess.Popen(['fc-list', "%s:style=%s" % (name, style), 'file'],
                                stdout=subprocess.PIPE, stderr=None)
        stdout, _ = proc.communicate()
        if proc.returncode == 0:
            lines = stdout.splitlines()
            for line in lines:
                if line.startswith(b'Fontconfig warning:'):
                    continue
                path = line.decode().strip().strip(':')
                if path:
                    return path
            return None

    def _create_nix(self):
        for name in STYLES['NORMAL']:
            path = self._get_nix_font_path(self.font_name, name)
            if path is not None:
                self.fonts['NORMAL'] = ImageFont.truetype(path, self.font_size)
                break
        else:
            raise FontNotFound('No usable fonts named: "%s"' %
                               self.font_name)
        for style in ('ITALIC', 'BOLD', 'BOLDITALIC'):
            for stylename in STYLES[style]:
                path = self._get_nix_font_path(self.font_name, stylename)
                if path is not None:
                    self.fonts[style] = ImageFont.truetype(path, self.font_size)
                    break
            else:
                if style == 'BOLDITALIC':
                    self.fonts[style] = self.fonts['BOLD']
                else:
                    self.fonts[style] = self.fonts['NORMAL']

    def _get_mac_font_path(self, font_map, name, style):
        return font_map.get((name + ' ' + style).strip().lower())

    def _create_mac(self):
        font_map = {}
        for font_dir in (os.path.join(os.getenv("HOME"), 'Library/Fonts/'),
                         '/Library/Fonts/', '/System/Library/Fonts/'):
            font_map.update(
                (os.path.splitext(f)[0].lower(), os.path.join(font_dir, f))
                for f in os.listdir(font_dir)
                if f.lower().endswith(('ttf', 'ttc')))

        for name in STYLES['NORMAL']:
            path = self._get_mac_font_path(font_map, self.font_name, name)
            if path is not None:
                self.fonts['NORMAL'] = ImageFont.truetype(path, self.font_size)
                break
        else:
            raise FontNotFound('No usable fonts named: "%s"' %
                               self.font_name)
        for style in ('ITALIC', 'BOLD', 'BOLDITALIC'):
            for stylename in STYLES[style]:
                path = self._get_mac_font_path(font_map, self.font_name, stylename)
                if path is not None:
                    self.fonts[style] = ImageFont.truetype(path, self.font_size)
                    break
            else:
                if style == 'BOLDITALIC':
                    self.fonts[style] = self.fonts['BOLD']
                else:
                    self.fonts[style] = self.fonts['NORMAL']

    def _lookup_win(self, key, basename, styles, fail=False):
        for suffix in ('', ' (TrueType)'):
            for style in styles:
                try:
                    valname = '%s%s%s' % (basename, style and ' '+style, suffix)
                    val, _ = _winreg.QueryValueEx(key, valname)
                    return val
                except OSError:
                    continue
        else:
            if fail:
                raise FontNotFound('Font %s (%s) not found in registry' %
                                   (basename, styles[0]))
            return None

    def _create_win(self):
        lookuperror = None
        keynames = [ (_winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows NT\CurrentVersion\Fonts'),
                     (_winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Fonts'),
                     (_winreg.HKEY_LOCAL_MACHINE, r'Software\Microsoft\Windows NT\CurrentVersion\Fonts'),
                     (_winreg.HKEY_LOCAL_MACHINE, r'Software\Microsoft\Windows\CurrentVersion\Fonts') ]
        for keyname in keynames:
            try:
                key = _winreg.OpenKey(*keyname)
                try:
                    path = self._lookup_win(key, self.font_name, STYLES['NORMAL'], True)
                    self.fonts['NORMAL'] = ImageFont.truetype(path, self.font_size)
                    for style in ('ITALIC', 'BOLD', 'BOLDITALIC'):
                        path = self._lookup_win(key, self.font_name, STYLES[style])
                        if path:
                            self.fonts[style] = ImageFont.truetype(path, self.font_size)
                        else:
                            if style == 'BOLDITALIC':
                                self.fonts[style] = self.fonts['BOLD']
                            else:
                                self.fonts[style] = self.fonts['NORMAL']
                    return
                except FontNotFound as err:
                    lookuperror = err
                finally:
                    _winreg.CloseKey(key)
            except OSError:
                pass
        else:
            # If we get here, we checked all registry keys and had no luck
            # We can be in one of two situations now:
            # * All key lookups failed. In this case lookuperror is None and we
            #   will raise a generic error
            # * At least one lookup failed with a FontNotFound error. In this
            #   case, we will raise that as a more specific error
            if lookuperror:
                raise lookuperror
            raise FontNotFound('Can\'t open Windows font registry key')

    def get_char_size(self):
        """
        Get the character size.
        """
        return self.get_text_size('M')

    def get_text_size(self, text):
        """
        Get the text size (width, height).
        """
        font = self.fonts['NORMAL']
        if hasattr(font, 'getbbox'):  # Pillow >= 9.2.0
            return font.getbbox(text)[2:4]
        else:
            return font.getsize(text)

    def get_font(self, bold, oblique):
        """
        Get the font based on bold and italic flags.
        """
        if bold and oblique:
            return self.fonts['BOLDITALIC']
        elif bold:
            return self.fonts['BOLD']
        elif oblique:
            return self.fonts['ITALIC']
        else:
            return self.fonts['NORMAL']


class ImageFormatter(Formatter):
    """
    Create a PNG image from source code. This uses the Python Imaging Library to
    generate a pixmap from the source code.

    .. versionadded:: 0.10

    Additional options accepted:

    `image_format`
        An image format to output to that is recognised by PIL, these include:

        * "PNG" (default)
        * "JPEG"
        * "BMP"
        * "GIF"

    `line_pad`
        The extra spacing (in pixels) between each line of text.

        Default: 2

    `font_name`
        The font name to be used as the base font from which others, such as
        bold and italic fonts will be generated.  This really should be a
        monospace font to look sane.

        Default: "Courier New" on Windows, "Menlo" on Mac OS, and
                 "DejaVu Sans Mono" on \\*nix

    `font_size`
        The font size in points to be used.

        Default: 14

    `image_pad`
        The padding, in pixels to be used at each edge of the resulting image.

        Default: 10

    `line_numbers`
        Whether line numbers should be shown: True/False

        Default: True

    `line_number_start`
        The line number of the first line.

        Default: 1

    `line_number_step`
        The step used when printing line numbers.

        Default: 1

    `line_number_bg`
        The background colour (in "#123456" format) of the line number bar, or
        None to use the style background color.

        Default: "#eed"

    `line_number_fg`
        The text color of the line numbers (in "#123456"-like format).

        Default: "#886"

    `line_number_chars`
        The number of columns of line numbers allowable in the line number
        margin.

        Default: 2

    `line_number_bold`
        Whether line numbers will be bold: True/False

        Default: False

    `line_number_italic`
        Whether line numbers will be italicized: True/False

        Default: False

    `line_number_separator`
        Whether a line will be drawn between the line number area and the
        source code area: True/False

        Default: True

    `line_number_pad`
        The horizontal padding (in pixels) between the line number margin, and
        the source code area.

        Default: 6

    `hl_lines`
        Specify a list of lines to be highlighted.

        .. versionadded:: 1.2

        Default: empty list

    `hl_color`
        Specify the color for highlighting lines.

        .. versionadded:: 1.2

        Default: highlight color of the selected style
    """

    # Required by the pygments mapper
    name = 'img'
    aliases = ['img', 'IMG', 'png']
    filenames = ['*.png']

    unicodeoutput = False

    default_image_format = 'png'

    def __init__(self, **options):
        """
        See the class docstring for explanation of options.
        """
        if not pil_available:
            raise PilNotAvailable(
                'Python Imaging Library is required for this formatter')
        Formatter.__init__(self, **options)
        self.encoding = 'latin1'  # let pygments.format() do the right thing
        # Read the style
        self.styles = dict(self.style)
        if self.style.background_color is None:
            self.background_color = '#fff'
        else:
            self.background_color = self.style.background_color
        # Image options
        self.image_format = get_choice_opt(
            options, 'image_format', ['png', 'jpeg', 'gif', 'bmp'],
            self.default_image_format, normcase=True)
        self.image_pad = get_int_opt(options, 'image_pad', 10)
        self.line_pad = get_int_opt(options, 'line_pad', 2)
        # The fonts
        fontsize = get_int_opt(options, 'font_size', 14)
        self.fonts = FontManager(options.get('font_name', ''), fontsize)
        self.fontw, self.fonth = self.fonts.get_char_size()
        # Line number options
        self.line_number_fg = options.get('line_number_fg', '#886')
        self.line_number_bg = options.get('line_number_bg', '#eed')
        self.line_number_chars = get_int_opt(options,
                                             'line_number_chars', 2)
        self.line_number_bold = get_bool_opt(options,
                                             'line_number_bold', False)
        self.line_number_italic = get_bool_opt(options,
                                               'line_number_italic', False)
        self.line_number_pad = get_int_opt(options, 'line_number_pad', 6)
        self.line_numbers = get_bool_opt(options, 'line_numbers', True)
        self.line_number_separator = get_bool_opt(options,
                                                  'line_number_separator', True)
        self.line_number_step = get_int_opt(options, 'line_number_step', 1)
        self.line_number_start = get_int_opt(options, 'line_number_start', 1)
        if self.line_numbers:
            self.line_number_width = (self.fontw * self.line_number_chars +
                                      self.line_number_pad * 2)
        else:
            self.line_number_width = 0
        self.hl_lines = []
        hl_lines_str = get_list_opt(options, 'hl_lines', [])
        for line in hl_lines_str:
            try:
                self.hl_lines.append(int(line))
            except ValueError:
                pass
        self.hl_color = options.get('hl_color',
                                    self.style.highlight_color) or '#f90'
        self.drawables = []

    def get_style_defs(self, arg=''):
        raise NotImplementedError('The -S option is meaningless for the image '
                                  'formatter. Use -O style=<stylename> instead.')

    def _get_line_height(self):
        """
        Get the height of a line.
        """
        return self.fonth + self.line_pad

    def _get_line_y(self, lineno):
        """
        Get the Y coordinate of a line number.
        """
        return lineno * self._get_line_height() + self.image_pad

    def _get_char_width(self):
        """
        Get the width of a character.
        """
        return self.fontw

    def _get_char_x(self, linelength):
        """
        Get the X coordinate of a character position.
        """
        return linelength + self.image_pad + self.line_number_width

    def _get_text_pos(self, linelength, lineno):
        """
        Get the actual position for a character and line position.
        """
        return self._get_char_x(linelength), self._get_line_y(lineno)

    def _get_linenumber_pos(self, lineno):
        """
        Get the actual position for the start of a line number.
        """
        return (self.image_pad, self._get_line_y(lineno))

    def _get_text_color(self, style):
        """
        Get the correct color for the token from the style.
        """
        if style['color'] is not None:
            fill = '#' + style['color']
        else:
            fill = '#000'
        return fill

    def _get_text_bg_color(self, style):
        """
        Get the correct background color for the token from the style.
        """
        if style['bgcolor'] is not None:
            bg_color = '#' + style['bgcolor']
        else:
            bg_color = None
        return bg_color

    def _get_style_font(self, style):
        """
        Get the correct font for the style.
        """
        return self.fonts.get_font(style['bold'], style['italic'])

    def _get_image_size(self, maxlinelength, maxlineno):
        """
        Get the required image size.
        """
        return (self._get_char_x(maxlinelength) + self.image_pad,
                self._get_line_y(maxlineno + 0) + self.image_pad)

    def _draw_linenumber(self, posno, lineno):
        """
        Remember a line number drawable to paint later.
        """
        self._draw_text(
            self._get_linenumber_pos(posno),
            str(lineno).rjust(self.line_number_chars),
            font=self.fonts.get_font(self.line_number_bold,
                                     self.line_number_italic),
            text_fg=self.line_number_fg,
            text_bg=None,
        )

    def _draw_text(self, pos, text, font, text_fg, text_bg):
        """
        Remember a single drawable tuple to paint later.
        """
        self.drawables.append((pos, text, font, text_fg, text_bg))

    def _create_drawables(self, tokensource):
        """
        Create drawables for the token content.
        """
        lineno = charno = maxcharno = 0
        maxlinelength = linelength = 0
        for ttype, value in tokensource:
            while ttype not in self.styles:
                ttype = ttype.parent
            style = self.styles[ttype]
            # TODO: make sure tab expansion happens earlier in the chain.  It
            # really ought to be done on the input, as to do it right here is
            # quite complex.
            value = value.expandtabs(4)
            lines = value.splitlines(True)
            # print lines
            for i, line in enumerate(lines):
                temp = line.rstrip('\n')
                if temp:
                    self._draw_text(
                        self._get_text_pos(linelength, lineno),
                        temp,
                        font = self._get_style_font(style),
                        text_fg = self._get_text_color(style),
                        text_bg = self._get_text_bg_color(style),
                    )
                    temp_width, _ = self.fonts.get_text_size(temp)
                    linelength += temp_width
                    maxlinelength = max(maxlinelength, linelength)
                    charno += len(temp)
                    maxcharno = max(maxcharno, charno)
                if line.endswith('\n'):
                    # add a line for each extra line in the value
                    linelength = 0
                    charno = 0
                    lineno += 1
        self.maxlinelength = maxlinelength
        self.maxcharno = maxcharno
        self.maxlineno = lineno

    def _draw_line_numbers(self):
        """
        Create drawables for the line numbers.
        """
        if not self.line_numbers:
            return
        for p in range(self.maxlineno):
            n = p + self.line_number_start
            if (n % self.line_number_step) == 0:
                self._draw_linenumber(p, n)

    def _paint_line_number_bg(self, im):
        """
        Paint the line number background on the image.
        """
        if not self.line_numbers:
            return
        if self.line_number_fg is None:
            return
        draw = ImageDraw.Draw(im)
        recth = im.size[-1]
        rectw = self.image_pad + self.line_number_width - self.line_number_pad
        draw.rectangle([(0, 0), (rectw, recth)],
                       fill=self.line_number_bg)
        if self.line_number_separator:
            draw.line([(rectw, 0), (rectw, recth)], fill=self.line_number_fg)
        del draw

    def format(self, tokensource, outfile):
        """
        Format ``tokensource``, an iterable of ``(tokentype, tokenstring)``
        tuples and write it into ``outfile``.

        This implementation calculates where it should draw each token on the
        pixmap, then calculates the required pixmap size and draws the items.
        """
        self._create_drawables(tokensource)
        self._draw_line_numbers()
        im = Image.new(
            'RGB',
            self._get_image_size(self.maxlinelength, self.maxlineno),
            self.background_color
        )
        self._paint_line_number_bg(im)
        draw = ImageDraw.Draw(im)
        # Highlight
        if self.hl_lines:
            x = self.image_pad + self.line_number_width - self.line_number_pad + 1
            recth = self._get_line_height()
            rectw = im.size[0] - x
            for linenumber in self.hl_lines:
                y = self._get_line_y(linenumber - 1)
                draw.rectangle([(x, y), (x + rectw, y + recth)],
                               fill=self.hl_color)
        for pos, value, font, text_fg, text_bg in self.drawables:
            if text_bg:
                text_size = draw.textsize(text=value, font=font)
                draw.rectangle([pos[0], pos[1], pos[0] + text_size[0], pos[1] + text_size[1]], fill=text_bg)
            draw.text(pos, value, font=font, fill=text_fg)
        im.save(outfile, self.image_format.upper())


# Add one formatter per format, so that the "-f gif" option gives the correct result
# when used in pygmentize.

class GifImageFormatter(ImageFormatter):
    """
    Create a GIF image from source code. This uses the Python Imaging Library to
    generate a pixmap from the source code.

    .. versionadded:: 1.0
    """

    name = 'img_gif'
    aliases = ['gif']
    filenames = ['*.gif']
    default_image_format = 'gif'


class JpgImageFormatter(ImageFormatter):
    """
    Create a JPEG image from source code. This uses the Python Imaging Library to
    generate a pixmap from the source code.

    .. versionadded:: 1.0
    """

    name = 'img_jpg'
    aliases = ['jpg', 'jpeg']
    filenames = ['*.jpg']
    default_image_format = 'jpeg'


class BmpImageFormatter(ImageFormatter):
    """
    Create a bitmap image from source code. This uses the Python Imaging Library to
    generate a pixmap from the source code.

    .. versionadded:: 1.0
    """

    name = 'img_bmp'
    aliases = ['bmp', 'bitmap']
    filenames = ['*.bmp']
    default_image_format = 'bmp'

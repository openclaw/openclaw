"""
    pygments.formatters.other
    ~~~~~~~~~~~~~~~~~~~~~~~~~

    Other formatters: NullFormatter, RawTokenFormatter.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

from pip._vendor.pygments.formatter import Formatter
from pip._vendor.pygments.util import get_choice_opt
from pip._vendor.pygments.token import Token
from pip._vendor.pygments.console import colorize

__all__ = ['NullFormatter', 'RawTokenFormatter', 'TestcaseFormatter']


class NullFormatter(Formatter):
    """
    Output the text unchanged without any formatting.
    """
    name = 'Text only'
    aliases = ['text', 'null']
    filenames = ['*.txt']

    def format(self, tokensource, outfile):
        enc = self.encoding
        for ttype, value in tokensource:
            if enc:
                outfile.write(value.encode(enc))
            else:
                outfile.write(value)


class RawTokenFormatter(Formatter):
    r"""
    Format tokens as a raw representation for storing token streams.

    The format is ``tokentype<TAB>repr(tokenstring)\n``. The output can later
    be converted to a token stream with the `RawTokenLexer`, described in the
    :doc:`lexer list <lexers>`.

    Only two options are accepted:

    `compress`
        If set to ``'gz'`` or ``'bz2'``, compress the output with the given
        compression algorithm after encoding (default: ``''``).
    `error_color`
        If set to a color name, highlight error tokens using that color.  If
        set but with no value, defaults to ``'red'``.

        .. versionadded:: 0.11

    """
    name = 'Raw tokens'
    aliases = ['raw', 'tokens']
    filenames = ['*.raw']

    unicodeoutput = False

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        # We ignore self.encoding if it is set, since it gets set for lexer
        # and formatter if given with -Oencoding on the command line.
        # The RawTokenFormatter outputs only ASCII. Override here.
        self.encoding = 'ascii'  # let pygments.format() do the right thing
        self.compress = get_choice_opt(options, 'compress',
                                       ['', 'none', 'gz', 'bz2'], '')
        self.error_color = options.get('error_color', None)
        if self.error_color is True:
            self.error_color = 'red'
        if self.error_color is not None:
            try:
                colorize(self.error_color, '')
            except KeyError:
                raise ValueError("Invalid color %r specified" %
                                 self.error_color)

    def format(self, tokensource, outfile):
        try:
            outfile.write(b'')
        except TypeError:
            raise TypeError('The raw tokens formatter needs a binary '
                            'output file')
        if self.compress == 'gz':
            import gzip
            outfile = gzip.GzipFile('', 'wb', 9, outfile)

            write = outfile.write
            flush = outfile.close
        elif self.compress == 'bz2':
            import bz2
            compressor = bz2.BZ2Compressor(9)

            def write(text):
                outfile.write(compressor.compress(text))

            def flush():
                outfile.write(compressor.flush())
                outfile.flush()
        else:
            write = outfile.write
            flush = outfile.flush

        if self.error_color:
            for ttype, value in tokensource:
                line = b"%r\t%r\n" % (ttype, value)
                if ttype is Token.Error:
                    write(colorize(self.error_color, line))
                else:
                    write(line)
        else:
            for ttype, value in tokensource:
                write(b"%r\t%r\n" % (ttype, value))
        flush()


TESTCASE_BEFORE = '''\
    def testNeedsName(lexer):
        fragment = %r
        tokens = [
'''
TESTCASE_AFTER = '''\
        ]
        assert list(lexer.get_tokens(fragment)) == tokens
'''


class TestcaseFormatter(Formatter):
    """
    Format tokens as appropriate for a new testcase.

    .. versionadded:: 2.0
    """
    name = 'Testcase'
    aliases = ['testcase']

    def __init__(self, **options):
        Formatter.__init__(self, **options)
        if self.encoding is not None and self.encoding != 'utf-8':
            raise ValueError("Only None and utf-8 are allowed encodings.")

    def format(self, tokensource, outfile):
        indentation = ' ' * 12
        rawbuf = []
        outbuf = []
        for ttype, value in tokensource:
            rawbuf.append(value)
            outbuf.append('%s(%s, %r),\n' % (indentation, ttype, value))

        before = TESTCASE_BEFORE % (''.join(rawbuf),)
        during = ''.join(outbuf)
        after = TESTCASE_AFTER
        if self.encoding is None:
            outfile.write(before + during + after)
        else:
            outfile.write(before.encode('utf-8'))
            outfile.write(during.encode('utf-8'))
            outfile.write(after.encode('utf-8'))
        outfile.flush()

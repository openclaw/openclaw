# coding: utf-8
"""

    webencodings.x_user_defined
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~

    An implementation of the x-user-defined encoding.

    :copyright: Copyright 2012 by Simon Sapin
    :license: BSD, see LICENSE for details.

"""

from __future__ import unicode_literals

import codecs


### Codec APIs

class Codec(codecs.Codec):

    def encode(self, input, errors='strict'):
        return codecs.charmap_encode(input, errors, encoding_table)

    def decode(self, input, errors='strict'):
        return codecs.charmap_decode(input, errors, decoding_table)


class IncrementalEncoder(codecs.IncrementalEncoder):
    def encode(self, input, final=False):
        return codecs.charmap_encode(input, self.errors, encoding_table)[0]


class IncrementalDecoder(codecs.IncrementalDecoder):
    def decode(self, input, final=False):
        return codecs.charmap_decode(input, self.errors, decoding_table)[0]


class StreamWriter(Codec, codecs.StreamWriter):
    pass


class StreamReader(Codec, codecs.StreamReader):
    pass


### encodings module API

codec_info = codecs.CodecInfo(
    name='x-user-defined',
    encode=Codec().encode,
    decode=Codec().decode,
    incrementalencoder=IncrementalEncoder,
    incrementaldecoder=IncrementalDecoder,
    streamreader=StreamReader,
    streamwriter=StreamWriter,
)


### Decoding Table

# Python 3:
# for c in range(256): print('    %r' % chr(c if c < 128 else c + 0xF700))
decoding_table = (
    '\x00'
    '\x01'
    '\x02'
    '\x03'
    '\x04'
    '\x05'
    '\x06'
    '\x07'
    '\x08'
    '\t'
    '\n'
    '\x0b'
    '\x0c'
    '\r'
    '\x0e'
    '\x0f'
    '\x10'
    '\x11'
    '\x12'
    '\x13'
    '\x14'
    '\x15'
    '\x16'
    '\x17'
    '\x18'
    '\x19'
    '\x1a'
    '\x1b'
    '\x1c'
    '\x1d'
    '\x1e'
    '\x1f'
    ' '
    '!'
    '"'
    '#'
    '$'
    '%'
    '&'
    "'"
    '('
    ')'
    '*'
    '+'
    ','
    '-'
    '.'
    '/'
    '0'
    '1'
    '2'
    '3'
    '4'
    '5'
    '6'
    '7'
    '8'
    '9'
    ':'
    ';'
    '<'
    '='
    '>'
    '?'
    '@'
    'A'
    'B'
    'C'
    'D'
    'E'
    'F'
    'G'
    'H'
    'I'
    'J'
    'K'
    'L'
    'M'
    'N'
    'O'
    'P'
    'Q'
    'R'
    'S'
    'T'
    'U'
    'V'
    'W'
    'X'
    'Y'
    'Z'
    '['
    '\\'
    ']'
    '^'
    '_'
    '`'
    'a'
    'b'
    'c'
    'd'
    'e'
    'f'
    'g'
    'h'
    'i'
    'j'
    'k'
    'l'
    'm'
    'n'
    'o'
    'p'
    'q'
    'r'
    's'
    't'
    'u'
    'v'
    'w'
    'x'
    'y'
    'z'
    '{'
    '|'
    '}'
    '~'
    '\x7f'
    '\uf780'
    '\uf781'
    '\uf782'
    '\uf783'
    '\uf784'
    '\uf785'
    '\uf786'
    '\uf787'
    '\uf788'
    '\uf789'
    '\uf78a'
    '\uf78b'
    '\uf78c'
    '\uf78d'
    '\uf78e'
    '\uf78f'
    '\uf790'
    '\uf791'
    '\uf792'
    '\uf793'
    '\uf794'
    '\uf795'
    '\uf796'
    '\uf797'
    '\uf798'
    '\uf799'
    '\uf79a'
    '\uf79b'
    '\uf79c'
    '\uf79d'
    '\uf79e'
    '\uf79f'
    '\uf7a0'
    '\uf7a1'
    '\uf7a2'
    '\uf7a3'
    '\uf7a4'
    '\uf7a5'
    '\uf7a6'
    '\uf7a7'
    '\uf7a8'
    '\uf7a9'
    '\uf7aa'
    '\uf7ab'
    '\uf7ac'
    '\uf7ad'
    '\uf7ae'
    '\uf7af'
    '\uf7b0'
    '\uf7b1'
    '\uf7b2'
    '\uf7b3'
    '\uf7b4'
    '\uf7b5'
    '\uf7b6'
    '\uf7b7'
    '\uf7b8'
    '\uf7b9'
    '\uf7ba'
    '\uf7bb'
    '\uf7bc'
    '\uf7bd'
    '\uf7be'
    '\uf7bf'
    '\uf7c0'
    '\uf7c1'
    '\uf7c2'
    '\uf7c3'
    '\uf7c4'
    '\uf7c5'
    '\uf7c6'
    '\uf7c7'
    '\uf7c8'
    '\uf7c9'
    '\uf7ca'
    '\uf7cb'
    '\uf7cc'
    '\uf7cd'
    '\uf7ce'
    '\uf7cf'
    '\uf7d0'
    '\uf7d1'
    '\uf7d2'
    '\uf7d3'
    '\uf7d4'
    '\uf7d5'
    '\uf7d6'
    '\uf7d7'
    '\uf7d8'
    '\uf7d9'
    '\uf7da'
    '\uf7db'
    '\uf7dc'
    '\uf7dd'
    '\uf7de'
    '\uf7df'
    '\uf7e0'
    '\uf7e1'
    '\uf7e2'
    '\uf7e3'
    '\uf7e4'
    '\uf7e5'
    '\uf7e6'
    '\uf7e7'
    '\uf7e8'
    '\uf7e9'
    '\uf7ea'
    '\uf7eb'
    '\uf7ec'
    '\uf7ed'
    '\uf7ee'
    '\uf7ef'
    '\uf7f0'
    '\uf7f1'
    '\uf7f2'
    '\uf7f3'
    '\uf7f4'
    '\uf7f5'
    '\uf7f6'
    '\uf7f7'
    '\uf7f8'
    '\uf7f9'
    '\uf7fa'
    '\uf7fb'
    '\uf7fc'
    '\uf7fd'
    '\uf7fe'
    '\uf7ff'
)

### Encoding table
encoding_table = codecs.charmap_build(decoding_table)

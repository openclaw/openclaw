# coding: utf-8
"""

    webencodings
    ~~~~~~~~~~~~

    This is a Python implementation of the `WHATWG Encoding standard
    <http://encoding.spec.whatwg.org/>`. See README for details.

    :copyright: Copyright 2012 by Simon Sapin
    :license: BSD, see LICENSE for details.

"""

from __future__ import unicode_literals

import codecs

from .labels import LABELS


VERSION = '0.5.1'


# Some names in Encoding are not valid Python aliases. Remap these.
PYTHON_NAMES = {
    'iso-8859-8-i': 'iso-8859-8',
    'x-mac-cyrillic': 'mac-cyrillic',
    'macintosh': 'mac-roman',
    'windows-874': 'cp874'}

CACHE = {}


def ascii_lower(string):
    r"""Transform (only) ASCII letters to lower case: A-Z is mapped to a-z.

    :param string: An Unicode string.
    :returns: A new Unicode string.

    This is used for `ASCII case-insensitive
    <http://encoding.spec.whatwg.org/#ascii-case-insensitive>`_
    matching of encoding labels.
    The same matching is also used, among other things,
    for `CSS keywords <http://dev.w3.org/csswg/css-values/#keywords>`_.

    This is different from the :meth:`~py:str.lower` method of Unicode strings
    which also affect non-ASCII characters,
    sometimes mapping them into the ASCII range:

        >>> keyword = u'Bac\N{KELVIN SIGN}ground'
        >>> assert keyword.lower() == u'background'
        >>> assert ascii_lower(keyword) != keyword.lower()
        >>> assert ascii_lower(keyword) == u'bac\N{KELVIN SIGN}ground'

    """
    # This turns out to be faster than unicode.translate()
    return string.encode('utf8').lower().decode('utf8')


def lookup(label):
    """
    Look for an encoding by its label.
    This is the spec’s `get an encoding
    <http://encoding.spec.whatwg.org/#concept-encoding-get>`_ algorithm.
    Supported labels are listed there.

    :param label: A string.
    :returns:
        An :class:`Encoding` object, or :obj:`None` for an unknown label.

    """
    # Only strip ASCII whitespace: U+0009, U+000A, U+000C, U+000D, and U+0020.
    label = ascii_lower(label.strip('\t\n\f\r '))
    name = LABELS.get(label)
    if name is None:
        return None
    encoding = CACHE.get(name)
    if encoding is None:
        if name == 'x-user-defined':
            from .x_user_defined import codec_info
        else:
            python_name = PYTHON_NAMES.get(name, name)
            # Any python_name value that gets to here should be valid.
            codec_info = codecs.lookup(python_name)
        encoding = Encoding(name, codec_info)
        CACHE[name] = encoding
    return encoding


def _get_encoding(encoding_or_label):
    """
    Accept either an encoding object or label.

    :param encoding: An :class:`Encoding` object or a label string.
    :returns: An :class:`Encoding` object.
    :raises: :exc:`~exceptions.LookupError` for an unknown label.

    """
    if hasattr(encoding_or_label, 'codec_info'):
        return encoding_or_label

    encoding = lookup(encoding_or_label)
    if encoding is None:
        raise LookupError('Unknown encoding label: %r' % encoding_or_label)
    return encoding


class Encoding(object):
    """Reresents a character encoding such as UTF-8,
    that can be used for decoding or encoding.

    .. attribute:: name

        Canonical name of the encoding

    .. attribute:: codec_info

        The actual implementation of the encoding,
        a stdlib :class:`~codecs.CodecInfo` object.
        See :func:`codecs.register`.

    """
    def __init__(self, name, codec_info):
        self.name = name
        self.codec_info = codec_info

    def __repr__(self):
        return '<Encoding %s>' % self.name


#: The UTF-8 encoding. Should be used for new content and formats.
UTF8 = lookup('utf-8')

_UTF16LE = lookup('utf-16le')
_UTF16BE = lookup('utf-16be')


def decode(input, fallback_encoding, errors='replace'):
    """
    Decode a single string.

    :param input: A byte string
    :param fallback_encoding:
        An :class:`Encoding` object or a label string.
        The encoding to use if :obj:`input` does note have a BOM.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.
    :return:
        A ``(output, encoding)`` tuple of an Unicode string
        and an :obj:`Encoding`.

    """
    # Fail early if `encoding` is an invalid label.
    fallback_encoding = _get_encoding(fallback_encoding)
    bom_encoding, input = _detect_bom(input)
    encoding = bom_encoding or fallback_encoding
    return encoding.codec_info.decode(input, errors)[0], encoding


def _detect_bom(input):
    """Return (bom_encoding, input), with any BOM removed from the input."""
    if input.startswith(b'\xFF\xFE'):
        return _UTF16LE, input[2:]
    if input.startswith(b'\xFE\xFF'):
        return _UTF16BE, input[2:]
    if input.startswith(b'\xEF\xBB\xBF'):
        return UTF8, input[3:]
    return None, input


def encode(input, encoding=UTF8, errors='strict'):
    """
    Encode a single string.

    :param input: An Unicode string.
    :param encoding: An :class:`Encoding` object or a label string.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.
    :return: A byte string.

    """
    return _get_encoding(encoding).codec_info.encode(input, errors)[0]


def iter_decode(input, fallback_encoding, errors='replace'):
    """
    "Pull"-based decoder.

    :param input:
        An iterable of byte strings.

        The input is first consumed just enough to determine the encoding
        based on the precense of a BOM,
        then consumed on demand when the return value is.
    :param fallback_encoding:
        An :class:`Encoding` object or a label string.
        The encoding to use if :obj:`input` does note have a BOM.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.
    :returns:
        An ``(output, encoding)`` tuple.
        :obj:`output` is an iterable of Unicode strings,
        :obj:`encoding` is the :obj:`Encoding` that is being used.

    """

    decoder = IncrementalDecoder(fallback_encoding, errors)
    generator = _iter_decode_generator(input, decoder)
    encoding = next(generator)
    return generator, encoding


def _iter_decode_generator(input, decoder):
    """Return a generator that first yields the :obj:`Encoding`,
    then yields output chukns as Unicode strings.

    """
    decode = decoder.decode
    input = iter(input)
    for chunck in input:
        output = decode(chunck)
        if output:
            assert decoder.encoding is not None
            yield decoder.encoding
            yield output
            break
    else:
        # Input exhausted without determining the encoding
        output = decode(b'', final=True)
        assert decoder.encoding is not None
        yield decoder.encoding
        if output:
            yield output
        return

    for chunck in input:
        output = decode(chunck)
        if output:
            yield output
    output = decode(b'', final=True)
    if output:
        yield output


def iter_encode(input, encoding=UTF8, errors='strict'):
    """
    “Pull”-based encoder.

    :param input: An iterable of Unicode strings.
    :param encoding: An :class:`Encoding` object or a label string.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.
    :returns: An iterable of byte strings.

    """
    # Fail early if `encoding` is an invalid label.
    encode = IncrementalEncoder(encoding, errors).encode
    return _iter_encode_generator(input, encode)


def _iter_encode_generator(input, encode):
    for chunck in input:
        output = encode(chunck)
        if output:
            yield output
    output = encode('', final=True)
    if output:
        yield output


class IncrementalDecoder(object):
    """
    “Push”-based decoder.

    :param fallback_encoding:
        An :class:`Encoding` object or a label string.
        The encoding to use if :obj:`input` does note have a BOM.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.

    """
    def __init__(self, fallback_encoding, errors='replace'):
        # Fail early if `encoding` is an invalid label.
        self._fallback_encoding = _get_encoding(fallback_encoding)
        self._errors = errors
        self._buffer = b''
        self._decoder = None
        #: The actual :class:`Encoding` that is being used,
        #: or :obj:`None` if that is not determined yet.
        #: (Ie. if there is not enough input yet to determine
        #: if there is a BOM.)
        self.encoding = None  # Not known yet.

    def decode(self, input, final=False):
        """Decode one chunk of the input.

        :param input: A byte string.
        :param final:
            Indicate that no more input is available.
            Must be :obj:`True` if this is the last call.
        :returns: An Unicode string.

        """
        decoder = self._decoder
        if decoder is not None:
            return decoder(input, final)

        input = self._buffer + input
        encoding, input = _detect_bom(input)
        if encoding is None:
            if len(input) < 3 and not final:  # Not enough data yet.
                self._buffer = input
                return ''
            else:  # No BOM
                encoding = self._fallback_encoding
        decoder = encoding.codec_info.incrementaldecoder(self._errors).decode
        self._decoder = decoder
        self.encoding = encoding
        return decoder(input, final)


class IncrementalEncoder(object):
    """
    “Push”-based encoder.

    :param encoding: An :class:`Encoding` object or a label string.
    :param errors: Type of error handling. See :func:`codecs.register`.
    :raises: :exc:`~exceptions.LookupError` for an unknown encoding label.

    .. method:: encode(input, final=False)

        :param input: An Unicode string.
        :param final:
            Indicate that no more input is available.
            Must be :obj:`True` if this is the last call.
        :returns: A byte string.

    """
    def __init__(self, encoding=UTF8, errors='strict'):
        encoding = _get_encoding(encoding)
        self.encode = encoding.codec_info.incrementalencoder(errors).encode

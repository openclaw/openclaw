# coding: utf-8
"""

    webencodings.tests
    ~~~~~~~~~~~~~~~~~~

    A basic test suite for Encoding.

    :copyright: Copyright 2012 by Simon Sapin
    :license: BSD, see LICENSE for details.

"""

from __future__ import unicode_literals

from . import (lookup, LABELS, decode, encode, iter_decode, iter_encode,
               IncrementalDecoder, IncrementalEncoder, UTF8)


def assert_raises(exception, function, *args, **kwargs):
    try:
        function(*args, **kwargs)
    except exception:
        return
    else:  # pragma: no cover
        raise AssertionError('Did not raise %s.' % exception)


def test_labels():
    assert lookup('utf-8').name == 'utf-8'
    assert lookup('Utf-8').name == 'utf-8'
    assert lookup('UTF-8').name == 'utf-8'
    assert lookup('utf8').name == 'utf-8'
    assert lookup('utf8').name == 'utf-8'
    assert lookup('utf8 ').name == 'utf-8'
    assert lookup(' \r\nutf8\t').name == 'utf-8'
    assert lookup('u8') is None  # Python label.
    assert lookup('utf-8 ') is None  # Non-ASCII white space.

    assert lookup('US-ASCII').name == 'windows-1252'
    assert lookup('iso-8859-1').name == 'windows-1252'
    assert lookup('latin1').name == 'windows-1252'
    assert lookup('LATIN1').name == 'windows-1252'
    assert lookup('latin-1') is None
    assert lookup('LATİN1') is None  # ASCII-only case insensitivity.


def test_all_labels():
    for label in LABELS:
        assert decode(b'', label) == ('', lookup(label))
        assert encode('', label) == b''
        for repeat in [0, 1, 12]:
            output, _ = iter_decode([b''] * repeat, label)
            assert list(output) == []
            assert list(iter_encode([''] * repeat, label)) == []
        decoder = IncrementalDecoder(label)
        assert decoder.decode(b'') == ''
        assert decoder.decode(b'', final=True) == ''
        encoder = IncrementalEncoder(label)
        assert encoder.encode('') == b''
        assert encoder.encode('', final=True) == b''
    # All encoding names are valid labels too:
    for name in set(LABELS.values()):
        assert lookup(name).name == name


def test_invalid_label():
    assert_raises(LookupError, decode, b'\xEF\xBB\xBF\xc3\xa9', 'invalid')
    assert_raises(LookupError, encode, 'é', 'invalid')
    assert_raises(LookupError, iter_decode, [], 'invalid')
    assert_raises(LookupError, iter_encode, [], 'invalid')
    assert_raises(LookupError, IncrementalDecoder, 'invalid')
    assert_raises(LookupError, IncrementalEncoder, 'invalid')


def test_decode():
    assert decode(b'\x80', 'latin1') == ('€', lookup('latin1'))
    assert decode(b'\x80', lookup('latin1')) == ('€', lookup('latin1'))
    assert decode(b'\xc3\xa9', 'utf8') == ('é', lookup('utf8'))
    assert decode(b'\xc3\xa9', UTF8) == ('é', lookup('utf8'))
    assert decode(b'\xc3\xa9', 'ascii') == ('Ã©', lookup('ascii'))
    assert decode(b'\xEF\xBB\xBF\xc3\xa9', 'ascii') == ('é', lookup('utf8'))  # UTF-8 with BOM

    assert decode(b'\xFE\xFF\x00\xe9', 'ascii') == ('é', lookup('utf-16be'))  # UTF-16-BE with BOM
    assert decode(b'\xFF\xFE\xe9\x00', 'ascii') == ('é', lookup('utf-16le'))  # UTF-16-LE with BOM
    assert decode(b'\xFE\xFF\xe9\x00', 'ascii') == ('\ue900', lookup('utf-16be'))
    assert decode(b'\xFF\xFE\x00\xe9', 'ascii') == ('\ue900', lookup('utf-16le'))

    assert decode(b'\x00\xe9', 'UTF-16BE') == ('é', lookup('utf-16be'))
    assert decode(b'\xe9\x00', 'UTF-16LE') == ('é', lookup('utf-16le'))
    assert decode(b'\xe9\x00', 'UTF-16') == ('é', lookup('utf-16le'))

    assert decode(b'\xe9\x00', 'UTF-16BE') == ('\ue900', lookup('utf-16be'))
    assert decode(b'\x00\xe9', 'UTF-16LE') == ('\ue900', lookup('utf-16le'))
    assert decode(b'\x00\xe9', 'UTF-16') == ('\ue900', lookup('utf-16le'))


def test_encode():
    assert encode('é', 'latin1') == b'\xe9'
    assert encode('é', 'utf8') == b'\xc3\xa9'
    assert encode('é', 'utf8') == b'\xc3\xa9'
    assert encode('é', 'utf-16') == b'\xe9\x00'
    assert encode('é', 'utf-16le') == b'\xe9\x00'
    assert encode('é', 'utf-16be') == b'\x00\xe9'


def test_iter_decode():
    def iter_decode_to_string(input, fallback_encoding):
        output, _encoding = iter_decode(input, fallback_encoding)
        return ''.join(output)
    assert iter_decode_to_string([], 'latin1') == ''
    assert iter_decode_to_string([b''], 'latin1') == ''
    assert iter_decode_to_string([b'\xe9'], 'latin1') == 'é'
    assert iter_decode_to_string([b'hello'], 'latin1') == 'hello'
    assert iter_decode_to_string([b'he', b'llo'], 'latin1') == 'hello'
    assert iter_decode_to_string([b'hell', b'o'], 'latin1') == 'hello'
    assert iter_decode_to_string([b'\xc3\xa9'], 'latin1') == 'Ã©'
    assert iter_decode_to_string([b'\xEF\xBB\xBF\xc3\xa9'], 'latin1') == 'é'
    assert iter_decode_to_string([
        b'\xEF\xBB\xBF', b'\xc3', b'\xa9'], 'latin1') == 'é'
    assert iter_decode_to_string([
        b'\xEF\xBB\xBF', b'a', b'\xc3'], 'latin1') == 'a\uFFFD'
    assert iter_decode_to_string([
        b'', b'\xEF', b'', b'', b'\xBB\xBF\xc3', b'\xa9'], 'latin1') == 'é'
    assert iter_decode_to_string([b'\xEF\xBB\xBF'], 'latin1') == ''
    assert iter_decode_to_string([b'\xEF\xBB'], 'latin1') == 'ï»'
    assert iter_decode_to_string([b'\xFE\xFF\x00\xe9'], 'latin1') == 'é'
    assert iter_decode_to_string([b'\xFF\xFE\xe9\x00'], 'latin1') == 'é'
    assert iter_decode_to_string([
        b'', b'\xFF', b'', b'', b'\xFE\xe9', b'\x00'], 'latin1') == 'é'
    assert iter_decode_to_string([
        b'', b'h\xe9', b'llo'], 'x-user-defined') == 'h\uF7E9llo'


def test_iter_encode():
    assert b''.join(iter_encode([], 'latin1')) == b''
    assert b''.join(iter_encode([''], 'latin1')) == b''
    assert b''.join(iter_encode(['é'], 'latin1')) == b'\xe9'
    assert b''.join(iter_encode(['', 'é', '', ''], 'latin1')) == b'\xe9'
    assert b''.join(iter_encode(['', 'é', '', ''], 'utf-16')) == b'\xe9\x00'
    assert b''.join(iter_encode(['', 'é', '', ''], 'utf-16le')) == b'\xe9\x00'
    assert b''.join(iter_encode(['', 'é', '', ''], 'utf-16be')) == b'\x00\xe9'
    assert b''.join(iter_encode([
        '', 'h\uF7E9', '', 'llo'], 'x-user-defined')) == b'h\xe9llo'


def test_x_user_defined():
    encoded = b'2,\x0c\x0b\x1aO\xd9#\xcb\x0f\xc9\xbbt\xcf\xa8\xca'
    decoded = '2,\x0c\x0b\x1aO\uf7d9#\uf7cb\x0f\uf7c9\uf7bbt\uf7cf\uf7a8\uf7ca'
    encoded = b'aa'
    decoded = 'aa'
    assert decode(encoded, 'x-user-defined') == (decoded, lookup('x-user-defined'))
    assert encode(decoded, 'x-user-defined') == encoded

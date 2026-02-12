# unicode.py

import sys
from itertools import filterfalse
from typing import List, Tuple, Union


class _lazyclassproperty:
    def __init__(self, fn):
        self.fn = fn
        self.__doc__ = fn.__doc__
        self.__name__ = fn.__name__

    def __get__(self, obj, cls):
        if cls is None:
            cls = type(obj)
        if not hasattr(cls, "_intern") or any(
            cls._intern is getattr(superclass, "_intern", [])
            for superclass in cls.__mro__[1:]
        ):
            cls._intern = {}
        attrname = self.fn.__name__
        if attrname not in cls._intern:
            cls._intern[attrname] = self.fn(cls)
        return cls._intern[attrname]


UnicodeRangeList = List[Union[Tuple[int, int], Tuple[int]]]


class unicode_set:
    """
    A set of Unicode characters, for language-specific strings for
    ``alphas``, ``nums``, ``alphanums``, and ``printables``.
    A unicode_set is defined by a list of ranges in the Unicode character
    set, in a class attribute ``_ranges``. Ranges can be specified using
    2-tuples or a 1-tuple, such as::

        _ranges = [
            (0x0020, 0x007e),
            (0x00a0, 0x00ff),
            (0x0100,),
            ]

    Ranges are left- and right-inclusive. A 1-tuple of (x,) is treated as (x, x).

    A unicode set can also be defined using multiple inheritance of other unicode sets::

        class CJK(Chinese, Japanese, Korean):
            pass
    """

    _ranges: UnicodeRangeList = []

    @_lazyclassproperty
    def _chars_for_ranges(cls):
        ret = []
        for cc in cls.__mro__:
            if cc is unicode_set:
                break
            for rr in getattr(cc, "_ranges", ()):
                ret.extend(range(rr[0], rr[-1] + 1))
        return [chr(c) for c in sorted(set(ret))]

    @_lazyclassproperty
    def printables(cls):
        """all non-whitespace characters in this range"""
        return "".join(filterfalse(str.isspace, cls._chars_for_ranges))

    @_lazyclassproperty
    def alphas(cls):
        """all alphabetic characters in this range"""
        return "".join(filter(str.isalpha, cls._chars_for_ranges))

    @_lazyclassproperty
    def nums(cls):
        """all numeric digit characters in this range"""
        return "".join(filter(str.isdigit, cls._chars_for_ranges))

    @_lazyclassproperty
    def alphanums(cls):
        """all alphanumeric characters in this range"""
        return cls.alphas + cls.nums

    @_lazyclassproperty
    def identchars(cls):
        """all characters in this range that are valid identifier characters, plus underscore '_'"""
        return "".join(
            sorted(
                set(
                    "".join(filter(str.isidentifier, cls._chars_for_ranges))
                    + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzªµº"
                    + "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ"
                    + "_"
                )
            )
        )

    @_lazyclassproperty
    def identbodychars(cls):
        """
        all characters in this range that are valid identifier body characters,
        plus the digits 0-9, and · (Unicode MIDDLE DOT)
        """
        return "".join(
            sorted(
                set(
                    cls.identchars
                    + "0123456789·"
                    + "".join(
                        [c for c in cls._chars_for_ranges if ("_" + c).isidentifier()]
                    )
                )
            )
        )

    @_lazyclassproperty
    def identifier(cls):
        """
        a pyparsing Word expression for an identifier using this range's definitions for
        identchars and identbodychars
        """
        from pip._vendor.pyparsing import Word

        return Word(cls.identchars, cls.identbodychars)


class pyparsing_unicode(unicode_set):
    """
    A namespace class for defining common language unicode_sets.
    """

    # fmt: off

    # define ranges in language character sets
    _ranges: UnicodeRangeList = [
        (0x0020, sys.maxunicode),
    ]

    class BasicMultilingualPlane(unicode_set):
        """Unicode set for the Basic Multilingual Plane"""
        _ranges: UnicodeRangeList = [
            (0x0020, 0xFFFF),
        ]

    class Latin1(unicode_set):
        """Unicode set for Latin-1 Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0020, 0x007E),
            (0x00A0, 0x00FF),
        ]

    class LatinA(unicode_set):
        """Unicode set for Latin-A Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0100, 0x017F),
        ]

    class LatinB(unicode_set):
        """Unicode set for Latin-B Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0180, 0x024F),
        ]

    class Greek(unicode_set):
        """Unicode set for Greek Unicode Character Ranges"""
        _ranges: UnicodeRangeList = [
            (0x0342, 0x0345),
            (0x0370, 0x0377),
            (0x037A, 0x037F),
            (0x0384, 0x038A),
            (0x038C,),
            (0x038E, 0x03A1),
            (0x03A3, 0x03E1),
            (0x03F0, 0x03FF),
            (0x1D26, 0x1D2A),
            (0x1D5E,),
            (0x1D60,),
            (0x1D66, 0x1D6A),
            (0x1F00, 0x1F15),
            (0x1F18, 0x1F1D),
            (0x1F20, 0x1F45),
            (0x1F48, 0x1F4D),
            (0x1F50, 0x1F57),
            (0x1F59,),
            (0x1F5B,),
            (0x1F5D,),
            (0x1F5F, 0x1F7D),
            (0x1F80, 0x1FB4),
            (0x1FB6, 0x1FC4),
            (0x1FC6, 0x1FD3),
            (0x1FD6, 0x1FDB),
            (0x1FDD, 0x1FEF),
            (0x1FF2, 0x1FF4),
            (0x1FF6, 0x1FFE),
            (0x2129,),
            (0x2719, 0x271A),
            (0xAB65,),
            (0x10140, 0x1018D),
            (0x101A0,),
            (0x1D200, 0x1D245),
            (0x1F7A1, 0x1F7A7),
        ]

    class Cyrillic(unicode_set):
        """Unicode set for Cyrillic Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0400, 0x052F),
            (0x1C80, 0x1C88),
            (0x1D2B,),
            (0x1D78,),
            (0x2DE0, 0x2DFF),
            (0xA640, 0xA672),
            (0xA674, 0xA69F),
            (0xFE2E, 0xFE2F),
        ]

    class Chinese(unicode_set):
        """Unicode set for Chinese Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x2E80, 0x2E99),
            (0x2E9B, 0x2EF3),
            (0x31C0, 0x31E3),
            (0x3400, 0x4DB5),
            (0x4E00, 0x9FEF),
            (0xA700, 0xA707),
            (0xF900, 0xFA6D),
            (0xFA70, 0xFAD9),
            (0x16FE2, 0x16FE3),
            (0x1F210, 0x1F212),
            (0x1F214, 0x1F23B),
            (0x1F240, 0x1F248),
            (0x20000, 0x2A6D6),
            (0x2A700, 0x2B734),
            (0x2B740, 0x2B81D),
            (0x2B820, 0x2CEA1),
            (0x2CEB0, 0x2EBE0),
            (0x2F800, 0x2FA1D),
        ]

    class Japanese(unicode_set):
        """Unicode set for Japanese Unicode Character Range, combining Kanji, Hiragana, and Katakana ranges"""

        class Kanji(unicode_set):
            "Unicode set for Kanji Unicode Character Range"
            _ranges: UnicodeRangeList = [
                (0x4E00, 0x9FBF),
                (0x3000, 0x303F),
            ]

        class Hiragana(unicode_set):
            """Unicode set for Hiragana Unicode Character Range"""
            _ranges: UnicodeRangeList = [
                (0x3041, 0x3096),
                (0x3099, 0x30A0),
                (0x30FC,),
                (0xFF70,),
                (0x1B001,),
                (0x1B150, 0x1B152),
                (0x1F200,),
            ]

        class Katakana(unicode_set):
            """Unicode set for Katakana  Unicode Character Range"""
            _ranges: UnicodeRangeList = [
                (0x3099, 0x309C),
                (0x30A0, 0x30FF),
                (0x31F0, 0x31FF),
                (0x32D0, 0x32FE),
                (0xFF65, 0xFF9F),
                (0x1B000,),
                (0x1B164, 0x1B167),
                (0x1F201, 0x1F202),
                (0x1F213,),
            ]

        漢字 = Kanji
        カタカナ = Katakana
        ひらがな = Hiragana

        _ranges = (
            Kanji._ranges
            + Hiragana._ranges
            + Katakana._ranges
        )

    class Hangul(unicode_set):
        """Unicode set for Hangul (Korean) Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x1100, 0x11FF),
            (0x302E, 0x302F),
            (0x3131, 0x318E),
            (0x3200, 0x321C),
            (0x3260, 0x327B),
            (0x327E,),
            (0xA960, 0xA97C),
            (0xAC00, 0xD7A3),
            (0xD7B0, 0xD7C6),
            (0xD7CB, 0xD7FB),
            (0xFFA0, 0xFFBE),
            (0xFFC2, 0xFFC7),
            (0xFFCA, 0xFFCF),
            (0xFFD2, 0xFFD7),
            (0xFFDA, 0xFFDC),
        ]

    Korean = Hangul

    class CJK(Chinese, Japanese, Hangul):
        """Unicode set for combined Chinese, Japanese, and Korean (CJK) Unicode Character Range"""

    class Thai(unicode_set):
        """Unicode set for Thai Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0E01, 0x0E3A),
            (0x0E3F, 0x0E5B)
        ]

    class Arabic(unicode_set):
        """Unicode set for Arabic Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0600, 0x061B),
            (0x061E, 0x06FF),
            (0x0700, 0x077F),
        ]

    class Hebrew(unicode_set):
        """Unicode set for Hebrew Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0591, 0x05C7),
            (0x05D0, 0x05EA),
            (0x05EF, 0x05F4),
            (0xFB1D, 0xFB36),
            (0xFB38, 0xFB3C),
            (0xFB3E,),
            (0xFB40, 0xFB41),
            (0xFB43, 0xFB44),
            (0xFB46, 0xFB4F),
        ]

    class Devanagari(unicode_set):
        """Unicode set for Devanagari Unicode Character Range"""
        _ranges: UnicodeRangeList = [
            (0x0900, 0x097F),
            (0xA8E0, 0xA8FF)
        ]

    BMP = BasicMultilingualPlane

    # add language identifiers using language Unicode
    العربية = Arabic
    中文 = Chinese
    кириллица = Cyrillic
    Ελληνικά = Greek
    עִברִית = Hebrew
    日本語 = Japanese
    한국어 = Korean
    ไทย = Thai
    देवनागरी = Devanagari

    # fmt: on

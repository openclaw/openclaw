######################## BEGIN LICENSE BLOCK ########################
# The Original Code is Mozilla Universal charset detector code.
#
# The Initial Developer of the Original Code is
# Netscape Communications Corporation.
# Portions created by the Initial Developer are Copyright (C) 2001
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Mark Pilgrim - port to Python
#   Shy Shalom - original C code
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2.1 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the Free Software
# Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
# 02110-1301  USA
######################### END LICENSE BLOCK #########################

import logging
import re
from typing import Optional, Union

from .enums import LanguageFilter, ProbingState

INTERNATIONAL_WORDS_PATTERN = re.compile(
    b"[a-zA-Z]*[\x80-\xFF]+[a-zA-Z]*[^a-zA-Z\x80-\xFF]?"
)


class CharSetProber:

    SHORTCUT_THRESHOLD = 0.95

    def __init__(self, lang_filter: LanguageFilter = LanguageFilter.NONE) -> None:
        self._state = ProbingState.DETECTING
        self.active = True
        self.lang_filter = lang_filter
        self.logger = logging.getLogger(__name__)

    def reset(self) -> None:
        self._state = ProbingState.DETECTING

    @property
    def charset_name(self) -> Optional[str]:
        return None

    @property
    def language(self) -> Optional[str]:
        raise NotImplementedError

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        raise NotImplementedError

    @property
    def state(self) -> ProbingState:
        return self._state

    def get_confidence(self) -> float:
        return 0.0

    @staticmethod
    def filter_high_byte_only(buf: Union[bytes, bytearray]) -> bytes:
        buf = re.sub(b"([\x00-\x7F])+", b" ", buf)
        return buf

    @staticmethod
    def filter_international_words(buf: Union[bytes, bytearray]) -> bytearray:
        """
        We define three types of bytes:
        alphabet: english alphabets [a-zA-Z]
        international: international characters [\x80-\xFF]
        marker: everything else [^a-zA-Z\x80-\xFF]
        The input buffer can be thought to contain a series of words delimited
        by markers. This function works to filter all words that contain at
        least one international character. All contiguous sequences of markers
        are replaced by a single space ascii character.
        This filter applies to all scripts which do not use English characters.
        """
        filtered = bytearray()

        # This regex expression filters out only words that have at-least one
        # international character. The word may include one marker character at
        # the end.
        words = INTERNATIONAL_WORDS_PATTERN.findall(buf)

        for word in words:
            filtered.extend(word[:-1])

            # If the last character in the word is a marker, replace it with a
            # space as markers shouldn't affect our analysis (they are used
            # similarly across all languages and may thus have similar
            # frequencies).
            last_char = word[-1:]
            if not last_char.isalpha() and last_char < b"\x80":
                last_char = b" "
            filtered.extend(last_char)

        return filtered

    @staticmethod
    def remove_xml_tags(buf: Union[bytes, bytearray]) -> bytes:
        """
        Returns a copy of ``buf`` that retains only the sequences of English
        alphabet and high byte characters that are not between <> characters.
        This filter can be applied to all scripts which contain both English
        characters and extended ASCII characters, but is currently only used by
        ``Latin1Prober``.
        """
        filtered = bytearray()
        in_tag = False
        prev = 0
        buf = memoryview(buf).cast("c")

        for curr, buf_char in enumerate(buf):
            # Check if we're coming out of or entering an XML tag

            # https://github.com/python/typeshed/issues/8182
            if buf_char == b">":  # type: ignore[comparison-overlap]
                prev = curr + 1
                in_tag = False
            # https://github.com/python/typeshed/issues/8182
            elif buf_char == b"<":  # type: ignore[comparison-overlap]
                if curr > prev and not in_tag:
                    # Keep everything after last non-extended-ASCII,
                    # non-alphabetic character
                    filtered.extend(buf[prev:curr])
                    # Output a space to delimit stretch we kept
                    filtered.extend(b" ")
                in_tag = True

        # If we're not in a tag...
        if not in_tag:
            # Keep everything after last non-extended-ASCII, non-alphabetic
            # character
            filtered.extend(buf[prev:])

        return filtered

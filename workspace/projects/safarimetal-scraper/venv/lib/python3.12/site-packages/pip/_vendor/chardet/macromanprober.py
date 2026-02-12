######################## BEGIN LICENSE BLOCK ########################
# This code was modified from latin1prober.py by Rob Speer <rob@lumino.so>.
# The Original Code is Mozilla Universal charset detector code.
#
# The Initial Developer of the Original Code is
# Netscape Communications Corporation.
# Portions created by the Initial Developer are Copyright (C) 2001
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Rob Speer - adapt to MacRoman encoding
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

from typing import List, Union

from .charsetprober import CharSetProber
from .enums import ProbingState

FREQ_CAT_NUM = 4

UDF = 0  # undefined
OTH = 1  # other
ASC = 2  # ascii capital letter
ASS = 3  # ascii small letter
ACV = 4  # accent capital vowel
ACO = 5  # accent capital other
ASV = 6  # accent small vowel
ASO = 7  # accent small other
ODD = 8  # character that is unlikely to appear
CLASS_NUM = 9  # total classes

# The change from Latin1 is that we explicitly look for extended characters
# that are infrequently-occurring symbols, and consider them to always be
# improbable. This should let MacRoman get out of the way of more likely
# encodings in most situations.

# fmt: off
MacRoman_CharToClass = (
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 00 - 07
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 08 - 0F
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 10 - 17
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 18 - 1F
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 20 - 27
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 28 - 2F
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 30 - 37
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # 38 - 3F
    OTH, ASC, ASC, ASC, ASC, ASC, ASC, ASC,  # 40 - 47
    ASC, ASC, ASC, ASC, ASC, ASC, ASC, ASC,  # 48 - 4F
    ASC, ASC, ASC, ASC, ASC, ASC, ASC, ASC,  # 50 - 57
    ASC, ASC, ASC, OTH, OTH, OTH, OTH, OTH,  # 58 - 5F
    OTH, ASS, ASS, ASS, ASS, ASS, ASS, ASS,  # 60 - 67
    ASS, ASS, ASS, ASS, ASS, ASS, ASS, ASS,  # 68 - 6F
    ASS, ASS, ASS, ASS, ASS, ASS, ASS, ASS,  # 70 - 77
    ASS, ASS, ASS, OTH, OTH, OTH, OTH, OTH,  # 78 - 7F
    ACV, ACV, ACO, ACV, ACO, ACV, ACV, ASV,  # 80 - 87
    ASV, ASV, ASV, ASV, ASV, ASO, ASV, ASV,  # 88 - 8F
    ASV, ASV, ASV, ASV, ASV, ASV, ASO, ASV,  # 90 - 97
    ASV, ASV, ASV, ASV, ASV, ASV, ASV, ASV,  # 98 - 9F
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, ASO,  # A0 - A7
    OTH, OTH, ODD, ODD, OTH, OTH, ACV, ACV,  # A8 - AF
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, OTH,  # B0 - B7
    OTH, OTH, OTH, OTH, OTH, OTH, ASV, ASV,  # B8 - BF
    OTH, OTH, ODD, OTH, ODD, OTH, OTH, OTH,  # C0 - C7
    OTH, OTH, OTH, ACV, ACV, ACV, ACV, ASV,  # C8 - CF
    OTH, OTH, OTH, OTH, OTH, OTH, OTH, ODD,  # D0 - D7
    ASV, ACV, ODD, OTH, OTH, OTH, OTH, OTH,  # D8 - DF
    OTH, OTH, OTH, OTH, OTH, ACV, ACV, ACV,  # E0 - E7
    ACV, ACV, ACV, ACV, ACV, ACV, ACV, ACV,  # E8 - EF
    ODD, ACV, ACV, ACV, ACV, ASV, ODD, ODD,  # F0 - F7
    ODD, ODD, ODD, ODD, ODD, ODD, ODD, ODD,  # F8 - FF
)

# 0 : illegal
# 1 : very unlikely
# 2 : normal
# 3 : very likely
MacRomanClassModel = (
# UDF OTH ASC ASS ACV ACO ASV ASO ODD
    0,  0,  0,  0,  0,  0,  0,  0,  0,  # UDF
    0,  3,  3,  3,  3,  3,  3,  3,  1,  # OTH
    0,  3,  3,  3,  3,  3,  3,  3,  1,  # ASC
    0,  3,  3,  3,  1,  1,  3,  3,  1,  # ASS
    0,  3,  3,  3,  1,  2,  1,  2,  1,  # ACV
    0,  3,  3,  3,  3,  3,  3,  3,  1,  # ACO
    0,  3,  1,  3,  1,  1,  1,  3,  1,  # ASV
    0,  3,  1,  3,  1,  1,  3,  3,  1,  # ASO
    0,  1,  1,  1,  1,  1,  1,  1,  1,  # ODD
)
# fmt: on


class MacRomanProber(CharSetProber):
    def __init__(self) -> None:
        super().__init__()
        self._last_char_class = OTH
        self._freq_counter: List[int] = []
        self.reset()

    def reset(self) -> None:
        self._last_char_class = OTH
        self._freq_counter = [0] * FREQ_CAT_NUM

        # express the prior that MacRoman is a somewhat rare encoding;
        # this can be done by starting out in a slightly improbable state
        # that must be overcome
        self._freq_counter[2] = 10

        super().reset()

    @property
    def charset_name(self) -> str:
        return "MacRoman"

    @property
    def language(self) -> str:
        return ""

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        byte_str = self.remove_xml_tags(byte_str)
        for c in byte_str:
            char_class = MacRoman_CharToClass[c]
            freq = MacRomanClassModel[(self._last_char_class * CLASS_NUM) + char_class]
            if freq == 0:
                self._state = ProbingState.NOT_ME
                break
            self._freq_counter[freq] += 1
            self._last_char_class = char_class

        return self.state

    def get_confidence(self) -> float:
        if self.state == ProbingState.NOT_ME:
            return 0.01

        total = sum(self._freq_counter)
        confidence = (
            0.0
            if total < 0.01
            else (self._freq_counter[3] - self._freq_counter[1] * 20.0) / total
        )
        confidence = max(confidence, 0.0)
        # lower the confidence of MacRoman so that other more accurate
        # detector can take priority.
        confidence *= 0.73
        return confidence

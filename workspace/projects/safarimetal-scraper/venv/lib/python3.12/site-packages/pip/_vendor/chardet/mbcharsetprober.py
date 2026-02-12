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
#   Proofpoint, Inc.
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

from typing import Optional, Union

from .chardistribution import CharDistributionAnalysis
from .charsetprober import CharSetProber
from .codingstatemachine import CodingStateMachine
from .enums import LanguageFilter, MachineState, ProbingState


class MultiByteCharSetProber(CharSetProber):
    """
    MultiByteCharSetProber
    """

    def __init__(self, lang_filter: LanguageFilter = LanguageFilter.NONE) -> None:
        super().__init__(lang_filter=lang_filter)
        self.distribution_analyzer: Optional[CharDistributionAnalysis] = None
        self.coding_sm: Optional[CodingStateMachine] = None
        self._last_char = bytearray(b"\0\0")

    def reset(self) -> None:
        super().reset()
        if self.coding_sm:
            self.coding_sm.reset()
        if self.distribution_analyzer:
            self.distribution_analyzer.reset()
        self._last_char = bytearray(b"\0\0")

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        assert self.coding_sm is not None
        assert self.distribution_analyzer is not None

        for i, byte in enumerate(byte_str):
            coding_state = self.coding_sm.next_state(byte)
            if coding_state == MachineState.ERROR:
                self.logger.debug(
                    "%s %s prober hit error at byte %s",
                    self.charset_name,
                    self.language,
                    i,
                )
                self._state = ProbingState.NOT_ME
                break
            if coding_state == MachineState.ITS_ME:
                self._state = ProbingState.FOUND_IT
                break
            if coding_state == MachineState.START:
                char_len = self.coding_sm.get_current_charlen()
                if i == 0:
                    self._last_char[1] = byte
                    self.distribution_analyzer.feed(self._last_char, char_len)
                else:
                    self.distribution_analyzer.feed(byte_str[i - 1 : i + 1], char_len)

        self._last_char[0] = byte_str[-1]

        if self.state == ProbingState.DETECTING:
            if self.distribution_analyzer.got_enough_data() and (
                self.get_confidence() > self.SHORTCUT_THRESHOLD
            ):
                self._state = ProbingState.FOUND_IT

        return self.state

    def get_confidence(self) -> float:
        assert self.distribution_analyzer is not None
        return self.distribution_analyzer.get_confidence()

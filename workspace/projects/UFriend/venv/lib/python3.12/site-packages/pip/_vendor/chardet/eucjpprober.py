######################## BEGIN LICENSE BLOCK ########################
# The Original Code is mozilla.org code.
#
# The Initial Developer of the Original Code is
# Netscape Communications Corporation.
# Portions created by the Initial Developer are Copyright (C) 1998
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Mark Pilgrim - port to Python
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

from typing import Union

from .chardistribution import EUCJPDistributionAnalysis
from .codingstatemachine import CodingStateMachine
from .enums import MachineState, ProbingState
from .jpcntx import EUCJPContextAnalysis
from .mbcharsetprober import MultiByteCharSetProber
from .mbcssm import EUCJP_SM_MODEL


class EUCJPProber(MultiByteCharSetProber):
    def __init__(self) -> None:
        super().__init__()
        self.coding_sm = CodingStateMachine(EUCJP_SM_MODEL)
        self.distribution_analyzer = EUCJPDistributionAnalysis()
        self.context_analyzer = EUCJPContextAnalysis()
        self.reset()

    def reset(self) -> None:
        super().reset()
        self.context_analyzer.reset()

    @property
    def charset_name(self) -> str:
        return "EUC-JP"

    @property
    def language(self) -> str:
        return "Japanese"

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        assert self.coding_sm is not None
        assert self.distribution_analyzer is not None

        for i, byte in enumerate(byte_str):
            # PY3K: byte_str is a byte array, so byte is an int, not a byte
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
                    self.context_analyzer.feed(self._last_char, char_len)
                    self.distribution_analyzer.feed(self._last_char, char_len)
                else:
                    self.context_analyzer.feed(byte_str[i - 1 : i + 1], char_len)
                    self.distribution_analyzer.feed(byte_str[i - 1 : i + 1], char_len)

        self._last_char[0] = byte_str[-1]

        if self.state == ProbingState.DETECTING:
            if self.context_analyzer.got_enough_data() and (
                self.get_confidence() > self.SHORTCUT_THRESHOLD
            ):
                self._state = ProbingState.FOUND_IT

        return self.state

    def get_confidence(self) -> float:
        assert self.distribution_analyzer is not None

        context_conf = self.context_analyzer.get_confidence()
        distrib_conf = self.distribution_analyzer.get_confidence()
        return max(context_conf, distrib_conf)

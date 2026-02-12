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

import logging

from .codingstatemachinedict import CodingStateMachineDict
from .enums import MachineState


class CodingStateMachine:
    """
    A state machine to verify a byte sequence for a particular encoding. For
    each byte the detector receives, it will feed that byte to every active
    state machine available, one byte at a time. The state machine changes its
    state based on its previous state and the byte it receives. There are 3
    states in a state machine that are of interest to an auto-detector:

    START state: This is the state to start with, or a legal byte sequence
                 (i.e. a valid code point) for character has been identified.

    ME state:  This indicates that the state machine identified a byte sequence
               that is specific to the charset it is designed for and that
               there is no other possible encoding which can contain this byte
               sequence. This will to lead to an immediate positive answer for
               the detector.

    ERROR state: This indicates the state machine identified an illegal byte
                 sequence for that encoding. This will lead to an immediate
                 negative answer for this encoding. Detector will exclude this
                 encoding from consideration from here on.
    """

    def __init__(self, sm: CodingStateMachineDict) -> None:
        self._model = sm
        self._curr_byte_pos = 0
        self._curr_char_len = 0
        self._curr_state = MachineState.START
        self.active = True
        self.logger = logging.getLogger(__name__)
        self.reset()

    def reset(self) -> None:
        self._curr_state = MachineState.START

    def next_state(self, c: int) -> int:
        # for each byte we get its class
        # if it is first byte, we also get byte length
        byte_class = self._model["class_table"][c]
        if self._curr_state == MachineState.START:
            self._curr_byte_pos = 0
            self._curr_char_len = self._model["char_len_table"][byte_class]
        # from byte's class and state_table, we get its next state
        curr_state = self._curr_state * self._model["class_factor"] + byte_class
        self._curr_state = self._model["state_table"][curr_state]
        self._curr_byte_pos += 1
        return self._curr_state

    def get_current_charlen(self) -> int:
        return self._curr_char_len

    def get_coding_state_machine(self) -> str:
        return self._model["name"]

    @property
    def language(self) -> str:
        return self._model["language"]

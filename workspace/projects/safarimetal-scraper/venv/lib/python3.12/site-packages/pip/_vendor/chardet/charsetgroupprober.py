######################## BEGIN LICENSE BLOCK ########################
# The Original Code is Mozilla Communicator client code.
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

from typing import List, Optional, Union

from .charsetprober import CharSetProber
from .enums import LanguageFilter, ProbingState


class CharSetGroupProber(CharSetProber):
    def __init__(self, lang_filter: LanguageFilter = LanguageFilter.NONE) -> None:
        super().__init__(lang_filter=lang_filter)
        self._active_num = 0
        self.probers: List[CharSetProber] = []
        self._best_guess_prober: Optional[CharSetProber] = None

    def reset(self) -> None:
        super().reset()
        self._active_num = 0
        for prober in self.probers:
            prober.reset()
            prober.active = True
            self._active_num += 1
        self._best_guess_prober = None

    @property
    def charset_name(self) -> Optional[str]:
        if not self._best_guess_prober:
            self.get_confidence()
            if not self._best_guess_prober:
                return None
        return self._best_guess_prober.charset_name

    @property
    def language(self) -> Optional[str]:
        if not self._best_guess_prober:
            self.get_confidence()
            if not self._best_guess_prober:
                return None
        return self._best_guess_prober.language

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        for prober in self.probers:
            if not prober.active:
                continue
            state = prober.feed(byte_str)
            if not state:
                continue
            if state == ProbingState.FOUND_IT:
                self._best_guess_prober = prober
                self._state = ProbingState.FOUND_IT
                return self.state
            if state == ProbingState.NOT_ME:
                prober.active = False
                self._active_num -= 1
                if self._active_num <= 0:
                    self._state = ProbingState.NOT_ME
                    return self.state
        return self.state

    def get_confidence(self) -> float:
        state = self.state
        if state == ProbingState.FOUND_IT:
            return 0.99
        if state == ProbingState.NOT_ME:
            return 0.01
        best_conf = 0.0
        self._best_guess_prober = None
        for prober in self.probers:
            if not prober.active:
                self.logger.debug("%s not active", prober.charset_name)
                continue
            conf = prober.get_confidence()
            self.logger.debug(
                "%s %s confidence = %s", prober.charset_name, prober.language, conf
            )
            if best_conf < conf:
                best_conf = conf
                self._best_guess_prober = prober
        if not self._best_guess_prober:
            return 0.0
        return best_conf

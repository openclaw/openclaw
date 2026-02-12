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

from typing import Dict, List, NamedTuple, Optional, Union

from .charsetprober import CharSetProber
from .enums import CharacterCategory, ProbingState, SequenceLikelihood


class SingleByteCharSetModel(NamedTuple):
    charset_name: str
    language: str
    char_to_order_map: Dict[int, int]
    language_model: Dict[int, Dict[int, int]]
    typical_positive_ratio: float
    keep_ascii_letters: bool
    alphabet: str


class SingleByteCharSetProber(CharSetProber):
    SAMPLE_SIZE = 64
    SB_ENOUGH_REL_THRESHOLD = 1024  # 0.25 * SAMPLE_SIZE^2
    POSITIVE_SHORTCUT_THRESHOLD = 0.95
    NEGATIVE_SHORTCUT_THRESHOLD = 0.05

    def __init__(
        self,
        model: SingleByteCharSetModel,
        is_reversed: bool = False,
        name_prober: Optional[CharSetProber] = None,
    ) -> None:
        super().__init__()
        self._model = model
        # TRUE if we need to reverse every pair in the model lookup
        self._reversed = is_reversed
        # Optional auxiliary prober for name decision
        self._name_prober = name_prober
        self._last_order = 255
        self._seq_counters: List[int] = []
        self._total_seqs = 0
        self._total_char = 0
        self._control_char = 0
        self._freq_char = 0
        self.reset()

    def reset(self) -> None:
        super().reset()
        # char order of last character
        self._last_order = 255
        self._seq_counters = [0] * SequenceLikelihood.get_num_categories()
        self._total_seqs = 0
        self._total_char = 0
        self._control_char = 0
        # characters that fall in our sampling range
        self._freq_char = 0

    @property
    def charset_name(self) -> Optional[str]:
        if self._name_prober:
            return self._name_prober.charset_name
        return self._model.charset_name

    @property
    def language(self) -> Optional[str]:
        if self._name_prober:
            return self._name_prober.language
        return self._model.language

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        # TODO: Make filter_international_words keep things in self.alphabet
        if not self._model.keep_ascii_letters:
            byte_str = self.filter_international_words(byte_str)
        else:
            byte_str = self.remove_xml_tags(byte_str)
        if not byte_str:
            return self.state
        char_to_order_map = self._model.char_to_order_map
        language_model = self._model.language_model
        for char in byte_str:
            order = char_to_order_map.get(char, CharacterCategory.UNDEFINED)
            # XXX: This was SYMBOL_CAT_ORDER before, with a value of 250, but
            #      CharacterCategory.SYMBOL is actually 253, so we use CONTROL
            #      to make it closer to the original intent. The only difference
            #      is whether or not we count digits and control characters for
            #      _total_char purposes.
            if order < CharacterCategory.CONTROL:
                self._total_char += 1
            if order < self.SAMPLE_SIZE:
                self._freq_char += 1
                if self._last_order < self.SAMPLE_SIZE:
                    self._total_seqs += 1
                    if not self._reversed:
                        lm_cat = language_model[self._last_order][order]
                    else:
                        lm_cat = language_model[order][self._last_order]
                    self._seq_counters[lm_cat] += 1
            self._last_order = order

        charset_name = self._model.charset_name
        if self.state == ProbingState.DETECTING:
            if self._total_seqs > self.SB_ENOUGH_REL_THRESHOLD:
                confidence = self.get_confidence()
                if confidence > self.POSITIVE_SHORTCUT_THRESHOLD:
                    self.logger.debug(
                        "%s confidence = %s, we have a winner", charset_name, confidence
                    )
                    self._state = ProbingState.FOUND_IT
                elif confidence < self.NEGATIVE_SHORTCUT_THRESHOLD:
                    self.logger.debug(
                        "%s confidence = %s, below negative shortcut threshold %s",
                        charset_name,
                        confidence,
                        self.NEGATIVE_SHORTCUT_THRESHOLD,
                    )
                    self._state = ProbingState.NOT_ME

        return self.state

    def get_confidence(self) -> float:
        r = 0.01
        if self._total_seqs > 0:
            r = (
                (
                    self._seq_counters[SequenceLikelihood.POSITIVE]
                    + 0.25 * self._seq_counters[SequenceLikelihood.LIKELY]
                )
                / self._total_seqs
                / self._model.typical_positive_ratio
            )
            # The more control characters (proportionnaly to the size
            # of the text), the less confident we become in the current
            # charset.
            r = r * (self._total_char - self._control_char) / self._total_char
            r = r * self._freq_char / self._total_char
            if r >= 1.0:
                r = 0.99
        return r

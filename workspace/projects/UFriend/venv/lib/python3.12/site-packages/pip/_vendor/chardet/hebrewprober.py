######################## BEGIN LICENSE BLOCK ########################
# The Original Code is Mozilla Universal charset detector code.
#
# The Initial Developer of the Original Code is
#          Shy Shalom
# Portions created by the Initial Developer are Copyright (C) 2005
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

from typing import Optional, Union

from .charsetprober import CharSetProber
from .enums import ProbingState
from .sbcharsetprober import SingleByteCharSetProber

# This prober doesn't actually recognize a language or a charset.
# It is a helper prober for the use of the Hebrew model probers

### General ideas of the Hebrew charset recognition ###
#
# Four main charsets exist in Hebrew:
# "ISO-8859-8" - Visual Hebrew
# "windows-1255" - Logical Hebrew
# "ISO-8859-8-I" - Logical Hebrew
# "x-mac-hebrew" - ?? Logical Hebrew ??
#
# Both "ISO" charsets use a completely identical set of code points, whereas
# "windows-1255" and "x-mac-hebrew" are two different proper supersets of
# these code points. windows-1255 defines additional characters in the range
# 0x80-0x9F as some misc punctuation marks as well as some Hebrew-specific
# diacritics and additional 'Yiddish' ligature letters in the range 0xc0-0xd6.
# x-mac-hebrew defines similar additional code points but with a different
# mapping.
#
# As far as an average Hebrew text with no diacritics is concerned, all four
# charsets are identical with respect to code points. Meaning that for the
# main Hebrew alphabet, all four map the same values to all 27 Hebrew letters
# (including final letters).
#
# The dominant difference between these charsets is their directionality.
# "Visual" directionality means that the text is ordered as if the renderer is
# not aware of a BIDI rendering algorithm. The renderer sees the text and
# draws it from left to right. The text itself when ordered naturally is read
# backwards. A buffer of Visual Hebrew generally looks like so:
# "[last word of first line spelled backwards] [whole line ordered backwards
# and spelled backwards] [first word of first line spelled backwards]
# [end of line] [last word of second line] ... etc' "
# adding punctuation marks, numbers and English text to visual text is
# naturally also "visual" and from left to right.
#
# "Logical" directionality means the text is ordered "naturally" according to
# the order it is read. It is the responsibility of the renderer to display
# the text from right to left. A BIDI algorithm is used to place general
# punctuation marks, numbers and English text in the text.
#
# Texts in x-mac-hebrew are almost impossible to find on the Internet. From
# what little evidence I could find, it seems that its general directionality
# is Logical.
#
# To sum up all of the above, the Hebrew probing mechanism knows about two
# charsets:
# Visual Hebrew - "ISO-8859-8" - backwards text - Words and sentences are
#    backwards while line order is natural. For charset recognition purposes
#    the line order is unimportant (In fact, for this implementation, even
#    word order is unimportant).
# Logical Hebrew - "windows-1255" - normal, naturally ordered text.
#
# "ISO-8859-8-I" is a subset of windows-1255 and doesn't need to be
#    specifically identified.
# "x-mac-hebrew" is also identified as windows-1255. A text in x-mac-hebrew
#    that contain special punctuation marks or diacritics is displayed with
#    some unconverted characters showing as question marks. This problem might
#    be corrected using another model prober for x-mac-hebrew. Due to the fact
#    that x-mac-hebrew texts are so rare, writing another model prober isn't
#    worth the effort and performance hit.
#
#### The Prober ####
#
# The prober is divided between two SBCharSetProbers and a HebrewProber,
# all of which are managed, created, fed data, inquired and deleted by the
# SBCSGroupProber. The two SBCharSetProbers identify that the text is in
# fact some kind of Hebrew, Logical or Visual. The final decision about which
# one is it is made by the HebrewProber by combining final-letter scores
# with the scores of the two SBCharSetProbers to produce a final answer.
#
# The SBCSGroupProber is responsible for stripping the original text of HTML
# tags, English characters, numbers, low-ASCII punctuation characters, spaces
# and new lines. It reduces any sequence of such characters to a single space.
# The buffer fed to each prober in the SBCS group prober is pure text in
# high-ASCII.
# The two SBCharSetProbers (model probers) share the same language model:
# Win1255Model.
# The first SBCharSetProber uses the model normally as any other
# SBCharSetProber does, to recognize windows-1255, upon which this model was
# built. The second SBCharSetProber is told to make the pair-of-letter
# lookup in the language model backwards. This in practice exactly simulates
# a visual Hebrew model using the windows-1255 logical Hebrew model.
#
# The HebrewProber is not using any language model. All it does is look for
# final-letter evidence suggesting the text is either logical Hebrew or visual
# Hebrew. Disjointed from the model probers, the results of the HebrewProber
# alone are meaningless. HebrewProber always returns 0.00 as confidence
# since it never identifies a charset by itself. Instead, the pointer to the
# HebrewProber is passed to the model probers as a helper "Name Prober".
# When the Group prober receives a positive identification from any prober,
# it asks for the name of the charset identified. If the prober queried is a
# Hebrew model prober, the model prober forwards the call to the
# HebrewProber to make the final decision. In the HebrewProber, the
# decision is made according to the final-letters scores maintained and Both
# model probers scores. The answer is returned in the form of the name of the
# charset identified, either "windows-1255" or "ISO-8859-8".


class HebrewProber(CharSetProber):
    SPACE = 0x20
    # windows-1255 / ISO-8859-8 code points of interest
    FINAL_KAF = 0xEA
    NORMAL_KAF = 0xEB
    FINAL_MEM = 0xED
    NORMAL_MEM = 0xEE
    FINAL_NUN = 0xEF
    NORMAL_NUN = 0xF0
    FINAL_PE = 0xF3
    NORMAL_PE = 0xF4
    FINAL_TSADI = 0xF5
    NORMAL_TSADI = 0xF6

    # Minimum Visual vs Logical final letter score difference.
    # If the difference is below this, don't rely solely on the final letter score
    # distance.
    MIN_FINAL_CHAR_DISTANCE = 5

    # Minimum Visual vs Logical model score difference.
    # If the difference is below this, don't rely at all on the model score
    # distance.
    MIN_MODEL_DISTANCE = 0.01

    VISUAL_HEBREW_NAME = "ISO-8859-8"
    LOGICAL_HEBREW_NAME = "windows-1255"

    def __init__(self) -> None:
        super().__init__()
        self._final_char_logical_score = 0
        self._final_char_visual_score = 0
        self._prev = self.SPACE
        self._before_prev = self.SPACE
        self._logical_prober: Optional[SingleByteCharSetProber] = None
        self._visual_prober: Optional[SingleByteCharSetProber] = None
        self.reset()

    def reset(self) -> None:
        self._final_char_logical_score = 0
        self._final_char_visual_score = 0
        # The two last characters seen in the previous buffer,
        # mPrev and mBeforePrev are initialized to space in order to simulate
        # a word delimiter at the beginning of the data
        self._prev = self.SPACE
        self._before_prev = self.SPACE
        # These probers are owned by the group prober.

    def set_model_probers(
        self,
        logical_prober: SingleByteCharSetProber,
        visual_prober: SingleByteCharSetProber,
    ) -> None:
        self._logical_prober = logical_prober
        self._visual_prober = visual_prober

    def is_final(self, c: int) -> bool:
        return c in [
            self.FINAL_KAF,
            self.FINAL_MEM,
            self.FINAL_NUN,
            self.FINAL_PE,
            self.FINAL_TSADI,
        ]

    def is_non_final(self, c: int) -> bool:
        # The normal Tsadi is not a good Non-Final letter due to words like
        # 'lechotet' (to chat) containing an apostrophe after the tsadi. This
        # apostrophe is converted to a space in FilterWithoutEnglishLetters
        # causing the Non-Final tsadi to appear at an end of a word even
        # though this is not the case in the original text.
        # The letters Pe and Kaf rarely display a related behavior of not being
        # a good Non-Final letter. Words like 'Pop', 'Winamp' and 'Mubarak'
        # for example legally end with a Non-Final Pe or Kaf. However, the
        # benefit of these letters as Non-Final letters outweighs the damage
        # since these words are quite rare.
        return c in [self.NORMAL_KAF, self.NORMAL_MEM, self.NORMAL_NUN, self.NORMAL_PE]

    def feed(self, byte_str: Union[bytes, bytearray]) -> ProbingState:
        # Final letter analysis for logical-visual decision.
        # Look for evidence that the received buffer is either logical Hebrew
        # or visual Hebrew.
        # The following cases are checked:
        # 1) A word longer than 1 letter, ending with a final letter. This is
        #    an indication that the text is laid out "naturally" since the
        #    final letter really appears at the end. +1 for logical score.
        # 2) A word longer than 1 letter, ending with a Non-Final letter. In
        #    normal Hebrew, words ending with Kaf, Mem, Nun, Pe or Tsadi,
        #    should not end with the Non-Final form of that letter. Exceptions
        #    to this rule are mentioned above in isNonFinal(). This is an
        #    indication that the text is laid out backwards. +1 for visual
        #    score
        # 3) A word longer than 1 letter, starting with a final letter. Final
        #    letters should not appear at the beginning of a word. This is an
        #    indication that the text is laid out backwards. +1 for visual
        #    score.
        #
        # The visual score and logical score are accumulated throughout the
        # text and are finally checked against each other in GetCharSetName().
        # No checking for final letters in the middle of words is done since
        # that case is not an indication for either Logical or Visual text.
        #
        # We automatically filter out all 7-bit characters (replace them with
        # spaces) so the word boundary detection works properly. [MAP]

        if self.state == ProbingState.NOT_ME:
            # Both model probers say it's not them. No reason to continue.
            return ProbingState.NOT_ME

        byte_str = self.filter_high_byte_only(byte_str)

        for cur in byte_str:
            if cur == self.SPACE:
                # We stand on a space - a word just ended
                if self._before_prev != self.SPACE:
                    # next-to-last char was not a space so self._prev is not a
                    # 1 letter word
                    if self.is_final(self._prev):
                        # case (1) [-2:not space][-1:final letter][cur:space]
                        self._final_char_logical_score += 1
                    elif self.is_non_final(self._prev):
                        # case (2) [-2:not space][-1:Non-Final letter][
                        #  cur:space]
                        self._final_char_visual_score += 1
            else:
                # Not standing on a space
                if (
                    (self._before_prev == self.SPACE)
                    and (self.is_final(self._prev))
                    and (cur != self.SPACE)
                ):
                    # case (3) [-2:space][-1:final letter][cur:not space]
                    self._final_char_visual_score += 1
            self._before_prev = self._prev
            self._prev = cur

        # Forever detecting, till the end or until both model probers return
        # ProbingState.NOT_ME (handled above)
        return ProbingState.DETECTING

    @property
    def charset_name(self) -> str:
        assert self._logical_prober is not None
        assert self._visual_prober is not None

        # Make the decision: is it Logical or Visual?
        # If the final letter score distance is dominant enough, rely on it.
        finalsub = self._final_char_logical_score - self._final_char_visual_score
        if finalsub >= self.MIN_FINAL_CHAR_DISTANCE:
            return self.LOGICAL_HEBREW_NAME
        if finalsub <= -self.MIN_FINAL_CHAR_DISTANCE:
            return self.VISUAL_HEBREW_NAME

        # It's not dominant enough, try to rely on the model scores instead.
        modelsub = (
            self._logical_prober.get_confidence() - self._visual_prober.get_confidence()
        )
        if modelsub > self.MIN_MODEL_DISTANCE:
            return self.LOGICAL_HEBREW_NAME
        if modelsub < -self.MIN_MODEL_DISTANCE:
            return self.VISUAL_HEBREW_NAME

        # Still no good, back to final letter distance, maybe it'll save the
        # day.
        if finalsub < 0.0:
            return self.VISUAL_HEBREW_NAME

        # (finalsub > 0 - Logical) or (don't know what to do) default to
        # Logical.
        return self.LOGICAL_HEBREW_NAME

    @property
    def language(self) -> str:
        return "Hebrew"

    @property
    def state(self) -> ProbingState:
        assert self._logical_prober is not None
        assert self._visual_prober is not None

        # Remain active as long as any of the model probers are active.
        if (self._logical_prober.state == ProbingState.NOT_ME) and (
            self._visual_prober.state == ProbingState.NOT_ME
        ):
            return ProbingState.NOT_ME
        return ProbingState.DETECTING

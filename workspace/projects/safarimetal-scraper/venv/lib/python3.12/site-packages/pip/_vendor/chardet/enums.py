"""
All of the Enums that are used throughout the chardet package.

:author: Dan Blanchard (dan.blanchard@gmail.com)
"""

from enum import Enum, Flag


class InputState:
    """
    This enum represents the different states a universal detector can be in.
    """

    PURE_ASCII = 0
    ESC_ASCII = 1
    HIGH_BYTE = 2


class LanguageFilter(Flag):
    """
    This enum represents the different language filters we can apply to a
    ``UniversalDetector``.
    """

    NONE = 0x00
    CHINESE_SIMPLIFIED = 0x01
    CHINESE_TRADITIONAL = 0x02
    JAPANESE = 0x04
    KOREAN = 0x08
    NON_CJK = 0x10
    ALL = 0x1F
    CHINESE = CHINESE_SIMPLIFIED | CHINESE_TRADITIONAL
    CJK = CHINESE | JAPANESE | KOREAN


class ProbingState(Enum):
    """
    This enum represents the different states a prober can be in.
    """

    DETECTING = 0
    FOUND_IT = 1
    NOT_ME = 2


class MachineState:
    """
    This enum represents the different states a state machine can be in.
    """

    START = 0
    ERROR = 1
    ITS_ME = 2


class SequenceLikelihood:
    """
    This enum represents the likelihood of a character following the previous one.
    """

    NEGATIVE = 0
    UNLIKELY = 1
    LIKELY = 2
    POSITIVE = 3

    @classmethod
    def get_num_categories(cls) -> int:
        """:returns: The number of likelihood categories in the enum."""
        return 4


class CharacterCategory:
    """
    This enum represents the different categories language models for
    ``SingleByteCharsetProber`` put characters into.

    Anything less than CONTROL is considered a letter.
    """

    UNDEFINED = 255
    LINE_BREAK = 254
    SYMBOL = 253
    DIGIT = 252
    CONTROL = 251

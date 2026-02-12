from typing import TYPE_CHECKING, Tuple

if TYPE_CHECKING:
    # TypedDict was introduced in Python 3.8.
    #
    # TODO: Remove the else block and TYPE_CHECKING check when dropping support
    # for Python 3.7.
    from typing import TypedDict

    class CodingStateMachineDict(TypedDict, total=False):
        class_table: Tuple[int, ...]
        class_factor: int
        state_table: Tuple[int, ...]
        char_len_table: Tuple[int, ...]
        name: str
        language: str  # Optional key

else:
    CodingStateMachineDict = dict

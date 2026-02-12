from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    # TypedDict was introduced in Python 3.8.
    #
    # TODO: Remove the else block and TYPE_CHECKING check when dropping support
    # for Python 3.7.
    from typing import TypedDict

    class ResultDict(TypedDict):
        encoding: Optional[str]
        confidence: float
        language: Optional[str]

else:
    ResultDict = dict

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from warnings import warn

from .api import from_bytes
from .constant import CHARDET_CORRESPONDENCE, TOO_SMALL_SEQUENCE

# TODO: remove this check when dropping Python 3.7 support
if TYPE_CHECKING:
    from typing_extensions import TypedDict

    class ResultDict(TypedDict):
        encoding: str | None
        language: str
        confidence: float | None


def detect(
    byte_str: bytes, should_rename_legacy: bool = False, **kwargs: Any
) -> ResultDict:
    """
    chardet legacy method
    Detect the encoding of the given byte string. It should be mostly backward-compatible.
    Encoding name will match Chardet own writing whenever possible. (Not on encoding name unsupported by it)
    This function is deprecated and should be used to migrate your project easily, consult the documentation for
    further information. Not planned for removal.

    :param byte_str:     The byte sequence to examine.
    :param should_rename_legacy:  Should we rename legacy encodings
                                  to their more modern equivalents?
    """
    if len(kwargs):
        warn(
            f"charset-normalizer disregard arguments '{','.join(list(kwargs.keys()))}' in legacy function detect()"
        )

    if not isinstance(byte_str, (bytearray, bytes)):
        raise TypeError(  # pragma: nocover
            f"Expected object of type bytes or bytearray, got: {type(byte_str)}"
        )

    if isinstance(byte_str, bytearray):
        byte_str = bytes(byte_str)

    r = from_bytes(byte_str).best()

    encoding = r.encoding if r is not None else None
    language = r.language if r is not None and r.language != "Unknown" else ""
    confidence = 1.0 - r.chaos if r is not None else None

    # automatically lower confidence
    # on small bytes samples.
    # https://github.com/jawah/charset_normalizer/issues/391
    if (
        confidence is not None
        and confidence >= 0.9
        and encoding
        not in {
            "utf_8",
            "ascii",
        }
        and r.bom is False  # type: ignore[union-attr]
        and len(byte_str) < TOO_SMALL_SEQUENCE
    ):
        confidence -= 0.2

    # Note: CharsetNormalizer does not return 'UTF-8-SIG' as the sig get stripped in the detection/normalization process
    # but chardet does return 'utf-8-sig' and it is a valid codec name.
    if r is not None and encoding == "utf_8" and r.bom:
        encoding += "_sig"

    if should_rename_legacy is False and encoding in CHARDET_CORRESPONDENCE:
        encoding = CHARDET_CORRESPONDENCE[encoding]

    return {
        "encoding": encoding,
        "language": language,
        "confidence": confidence,
    }

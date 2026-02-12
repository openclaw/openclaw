import re
from functools import lru_cache
from typing import Callable, List

from ._cell_widths import CELL_WIDTHS

# Regex to match sequence of the most common character ranges
_is_single_cell_widths = re.compile("^[\u0020-\u006f\u00a0\u02ff\u0370-\u0482]*$").match


@lru_cache(4096)
def cached_cell_len(text: str) -> int:
    """Get the number of cells required to display text.

    This method always caches, which may use up a lot of memory. It is recommended to use
    `cell_len` over this method.

    Args:
        text (str): Text to display.

    Returns:
        int: Get the number of cells required to display text.
    """
    _get_size = get_character_cell_size
    total_size = sum(_get_size(character) for character in text)
    return total_size


def cell_len(text: str, _cell_len: Callable[[str], int] = cached_cell_len) -> int:
    """Get the number of cells required to display text.

    Args:
        text (str): Text to display.

    Returns:
        int: Get the number of cells required to display text.
    """
    if len(text) < 512:
        return _cell_len(text)
    _get_size = get_character_cell_size
    total_size = sum(_get_size(character) for character in text)
    return total_size


@lru_cache(maxsize=4096)
def get_character_cell_size(character: str) -> int:
    """Get the cell size of a character.

    Args:
        character (str): A single character.

    Returns:
        int: Number of cells (0, 1 or 2) occupied by that character.
    """
    return _get_codepoint_cell_size(ord(character))


@lru_cache(maxsize=4096)
def _get_codepoint_cell_size(codepoint: int) -> int:
    """Get the cell size of a character.

    Args:
        codepoint (int): Codepoint of a character.

    Returns:
        int: Number of cells (0, 1 or 2) occupied by that character.
    """

    _table = CELL_WIDTHS
    lower_bound = 0
    upper_bound = len(_table) - 1
    index = (lower_bound + upper_bound) // 2
    while True:
        start, end, width = _table[index]
        if codepoint < start:
            upper_bound = index - 1
        elif codepoint > end:
            lower_bound = index + 1
        else:
            return 0 if width == -1 else width
        if upper_bound < lower_bound:
            break
        index = (lower_bound + upper_bound) // 2
    return 1


def set_cell_size(text: str, total: int) -> str:
    """Set the length of a string to fit within given number of cells."""

    if _is_single_cell_widths(text):
        size = len(text)
        if size < total:
            return text + " " * (total - size)
        return text[:total]

    if total <= 0:
        return ""
    cell_size = cell_len(text)
    if cell_size == total:
        return text
    if cell_size < total:
        return text + " " * (total - cell_size)

    start = 0
    end = len(text)

    # Binary search until we find the right size
    while True:
        pos = (start + end) // 2
        before = text[: pos + 1]
        before_len = cell_len(before)
        if before_len == total + 1 and cell_len(before[-1]) == 2:
            return before[:-1] + " "
        if before_len == total:
            return before
        if before_len > total:
            end = pos
        else:
            start = pos


# TODO: This is inefficient
# TODO: This might not work with CWJ type characters
def chop_cells(text: str, max_size: int, position: int = 0) -> List[str]:
    """Break text in to equal (cell) length strings, returning the characters in reverse
    order"""
    _get_character_cell_size = get_character_cell_size
    characters = [
        (character, _get_character_cell_size(character)) for character in text
    ]
    total_size = position
    lines: List[List[str]] = [[]]
    append = lines[-1].append

    for character, size in reversed(characters):
        if total_size + size > max_size:
            lines.append([character])
            append = lines[-1].append
            total_size = size
        else:
            total_size += size
            append(character)

    return ["".join(line) for line in lines]


if __name__ == "__main__":  # pragma: no cover

    print(get_character_cell_size("😽"))
    for line in chop_cells("""这是对亚洲语言支持的测试。面对模棱两可的想法，拒绝猜测的诱惑。""", 8):
        print(line)
    for n in range(80, 1, -1):
        print(set_cell_size("""这是对亚洲语言支持的测试。面对模棱两可的想法，拒绝猜测的诱惑。""", n) + "|")
        print("x" * n)

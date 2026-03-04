from math import floor, ceil
from decimal import Decimal


def round_down(x: float, sig_digits: int) -> float:
    return floor(x * (10**sig_digits)) / (10**sig_digits)


def round_normal(x: float, sig_digits: int) -> float:
    return round(x * (10**sig_digits)) / (10**sig_digits)


def round_up(x: float, sig_digits: int) -> float:
    return ceil(x * (10**sig_digits)) / (10**sig_digits)


def to_token_decimals(x: float) -> int:
    f = (10**6) * x
    if decimal_places(f) > 0:
        f = round_normal(f, 0)
    return int(f)


def decimal_places(x: float) -> int:
    return abs(Decimal(x.__str__()).as_tuple().exponent)

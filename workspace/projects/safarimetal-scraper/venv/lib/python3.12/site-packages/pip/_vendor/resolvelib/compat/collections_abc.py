__all__ = ["Mapping", "Sequence"]

try:
    from collections.abc import Mapping, Sequence
except ImportError:
    from collections import Mapping, Sequence

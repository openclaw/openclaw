# cython: language_level=3str

"""Backward-compatibility module for lxml_html_clean"""

try:
    from lxml_html_clean import *

    __all__ = [
        "clean_html",
        "clean",
        "Cleaner",
        "autolink",
        "autolink_html",
        "word_break",
        "word_break_html",
    ]
except ImportError:
    raise ImportError(
        "lxml.html.clean module is now a separate project lxml_html_clean.\n"
        "Install lxml[html_clean] or lxml_html_clean directly."
    ) from None

__doc__ = """Legacy interface to the BeautifulSoup HTML parser.
"""

__all__ = ["parse", "convert_tree"]

from .soupparser import convert_tree, parse as _parse

def parse(file, beautifulsoup=None, makeelement=None):
    root = _parse(file, beautifulsoup=beautifulsoup, makeelement=makeelement)
    return root.getroot()

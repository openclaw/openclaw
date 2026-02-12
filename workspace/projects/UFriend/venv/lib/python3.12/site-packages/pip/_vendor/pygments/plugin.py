"""
    pygments.plugin
    ~~~~~~~~~~~~~~~

    Pygments plugin interface. By default, this tries to use
    ``importlib.metadata``, which is in the Python standard
    library since Python 3.8, or its ``importlib_metadata``
    backport for earlier versions of Python. It falls back on
    ``pkg_resources`` if not found. Finally, if ``pkg_resources``
    is not found either, no plugins are loaded at all.

    lexer plugins::

        [pygments.lexers]
        yourlexer = yourmodule:YourLexer

    formatter plugins::

        [pygments.formatters]
        yourformatter = yourformatter:YourFormatter
        /.ext = yourformatter:YourFormatter

    As you can see, you can define extensions for the formatter
    with a leading slash.

    syntax plugins::

        [pygments.styles]
        yourstyle = yourstyle:YourStyle

    filter plugin::

        [pygments.filter]
        yourfilter = yourfilter:YourFilter


    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

LEXER_ENTRY_POINT = 'pygments.lexers'
FORMATTER_ENTRY_POINT = 'pygments.formatters'
STYLE_ENTRY_POINT = 'pygments.styles'
FILTER_ENTRY_POINT = 'pygments.filters'


def iter_entry_points(group_name):
    try:
        from importlib.metadata import entry_points
    except ImportError:
        try:
            from importlib_metadata import entry_points
        except ImportError:
            try:
                from pip._vendor.pkg_resources import iter_entry_points
            except (ImportError, OSError):
                return []
            else:
                return iter_entry_points(group_name)
    groups = entry_points()
    if hasattr(groups, 'select'):
        # New interface in Python 3.10 and newer versions of the
        # importlib_metadata backport.
        return groups.select(group=group_name)
    else:
        # Older interface, deprecated in Python 3.10 and recent
        # importlib_metadata, but we need it in Python 3.8 and 3.9.
        return groups.get(group_name, [])


def find_plugin_lexers():
    for entrypoint in iter_entry_points(LEXER_ENTRY_POINT):
        yield entrypoint.load()


def find_plugin_formatters():
    for entrypoint in iter_entry_points(FORMATTER_ENTRY_POINT):
        yield entrypoint.name, entrypoint.load()


def find_plugin_styles():
    for entrypoint in iter_entry_points(STYLE_ENTRY_POINT):
        yield entrypoint.name, entrypoint.load()


def find_plugin_filters():
    for entrypoint in iter_entry_points(FILTER_ENTRY_POINT):
        yield entrypoint.name, entrypoint.load()

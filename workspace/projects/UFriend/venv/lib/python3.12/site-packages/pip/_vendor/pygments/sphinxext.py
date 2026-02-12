"""
    pygments.sphinxext
    ~~~~~~~~~~~~~~~~~~

    Sphinx extension to generate automatic documentation of lexers,
    formatters and filters.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

import sys

from docutils import nodes
from docutils.statemachine import ViewList
from docutils.parsers.rst import Directive
from sphinx.util.nodes import nested_parse_with_titles


MODULEDOC = '''
.. module:: %s

%s
%s
'''

LEXERDOC = '''
.. class:: %s

    :Short names: %s
    :Filenames:   %s
    :MIME types:  %s

    %s

'''

FMTERDOC = '''
.. class:: %s

    :Short names: %s
    :Filenames: %s

    %s

'''

FILTERDOC = '''
.. class:: %s

    :Name: %s

    %s

'''


class PygmentsDoc(Directive):
    """
    A directive to collect all lexers/formatters/filters and generate
    autoclass directives for them.
    """
    has_content = False
    required_arguments = 1
    optional_arguments = 0
    final_argument_whitespace = False
    option_spec = {}

    def run(self):
        self.filenames = set()
        if self.arguments[0] == 'lexers':
            out = self.document_lexers()
        elif self.arguments[0] == 'formatters':
            out = self.document_formatters()
        elif self.arguments[0] == 'filters':
            out = self.document_filters()
        elif self.arguments[0] == 'lexers_overview':
            out = self.document_lexers_overview()
        else:
            raise Exception('invalid argument for "pygmentsdoc" directive')
        node = nodes.compound()
        vl = ViewList(out.split('\n'), source='')
        nested_parse_with_titles(self.state, vl, node)
        for fn in self.filenames:
            self.state.document.settings.record_dependencies.add(fn)
        return node.children

    def document_lexers_overview(self):
        """Generate a tabular overview of all lexers.

        The columns are the lexer name, the extensions handled by this lexer
        (or "None"), the aliases and a link to the lexer class."""
        from pip._vendor.pygments.lexers._mapping import LEXERS
        from pip._vendor.pygments.lexers import find_lexer_class
        out = []

        table = []

        def format_link(name, url):
            if url:
                return f'`{name} <{url}>`_'
            return name

        for classname, data in sorted(LEXERS.items(), key=lambda x: x[1][1].lower()):
            lexer_cls = find_lexer_class(data[1])
            extensions = lexer_cls.filenames + lexer_cls.alias_filenames

            table.append({
                'name': format_link(data[1], lexer_cls.url),
                'extensions': ', '.join(extensions).replace('*', '\\*').replace('_', '\\') or 'None',
                'aliases': ', '.join(data[2]),
                'class': f'{data[0]}.{classname}'
            })

        column_names = ['name', 'extensions', 'aliases', 'class']
        column_lengths = [max([len(row[column]) for row in table if row[column]])
                          for column in column_names]

        def write_row(*columns):
            """Format a table row"""
            out = []
            for l, c in zip(column_lengths, columns):
                if c:
                    out.append(c.ljust(l))
                else:
                    out.append(' '*l)

            return ' '.join(out)

        def write_seperator():
            """Write a table separator row"""
            sep = ['='*c for c in column_lengths]
            return write_row(*sep)

        out.append(write_seperator())
        out.append(write_row('Name', 'Extension(s)', 'Short name(s)', 'Lexer class'))
        out.append(write_seperator())
        for row in table:
            out.append(write_row(
                row['name'],
                row['extensions'],
                row['aliases'],
                f':class:`~{row["class"]}`'))
        out.append(write_seperator())

        return '\n'.join(out)

    def document_lexers(self):
        from pip._vendor.pygments.lexers._mapping import LEXERS
        out = []
        modules = {}
        moduledocstrings = {}
        for classname, data in sorted(LEXERS.items(), key=lambda x: x[0]):
            module = data[0]
            mod = __import__(module, None, None, [classname])
            self.filenames.add(mod.__file__)
            cls = getattr(mod, classname)
            if not cls.__doc__:
                print("Warning: %s does not have a docstring." % classname)
            docstring = cls.__doc__
            if isinstance(docstring, bytes):
                docstring = docstring.decode('utf8')
            modules.setdefault(module, []).append((
                classname,
                ', '.join(data[2]) or 'None',
                ', '.join(data[3]).replace('*', '\\*').replace('_', '\\') or 'None',
                ', '.join(data[4]) or 'None',
                docstring))
            if module not in moduledocstrings:
                moddoc = mod.__doc__
                if isinstance(moddoc, bytes):
                    moddoc = moddoc.decode('utf8')
                moduledocstrings[module] = moddoc

        for module, lexers in sorted(modules.items(), key=lambda x: x[0]):
            if moduledocstrings[module] is None:
                raise Exception("Missing docstring for %s" % (module,))
            heading = moduledocstrings[module].splitlines()[4].strip().rstrip('.')
            out.append(MODULEDOC % (module, heading, '-'*len(heading)))
            for data in lexers:
                out.append(LEXERDOC % data)

        return ''.join(out)

    def document_formatters(self):
        from pip._vendor.pygments.formatters import FORMATTERS

        out = []
        for classname, data in sorted(FORMATTERS.items(), key=lambda x: x[0]):
            module = data[0]
            mod = __import__(module, None, None, [classname])
            self.filenames.add(mod.__file__)
            cls = getattr(mod, classname)
            docstring = cls.__doc__
            if isinstance(docstring, bytes):
                docstring = docstring.decode('utf8')
            heading = cls.__name__
            out.append(FMTERDOC % (heading, ', '.join(data[2]) or 'None',
                                   ', '.join(data[3]).replace('*', '\\*') or 'None',
                                   docstring))
        return ''.join(out)

    def document_filters(self):
        from pip._vendor.pygments.filters import FILTERS

        out = []
        for name, cls in FILTERS.items():
            self.filenames.add(sys.modules[cls.__module__].__file__)
            docstring = cls.__doc__
            if isinstance(docstring, bytes):
                docstring = docstring.decode('utf8')
            out.append(FILTERDOC % (cls.__name__, name, docstring))
        return ''.join(out)


def setup(app):
    app.add_directive('pygmentsdoc', PygmentsDoc)

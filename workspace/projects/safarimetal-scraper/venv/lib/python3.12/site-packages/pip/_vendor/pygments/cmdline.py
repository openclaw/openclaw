"""
    pygments.cmdline
    ~~~~~~~~~~~~~~~~

    Command line interface.

    :copyright: Copyright 2006-2023 by the Pygments team, see AUTHORS.
    :license: BSD, see LICENSE for details.
"""

import os
import sys
import shutil
import argparse
from textwrap import dedent

from pip._vendor.pygments import __version__, highlight
from pip._vendor.pygments.util import ClassNotFound, OptionError, docstring_headline, \
    guess_decode, guess_decode_from_terminal, terminal_encoding, \
    UnclosingTextIOWrapper
from pip._vendor.pygments.lexers import get_all_lexers, get_lexer_by_name, guess_lexer, \
    load_lexer_from_file, get_lexer_for_filename, find_lexer_class_for_filename
from pip._vendor.pygments.lexers.special import TextLexer
from pip._vendor.pygments.formatters.latex import LatexEmbeddedLexer, LatexFormatter
from pip._vendor.pygments.formatters import get_all_formatters, get_formatter_by_name, \
    load_formatter_from_file, get_formatter_for_filename, find_formatter_class
from pip._vendor.pygments.formatters.terminal import TerminalFormatter
from pip._vendor.pygments.formatters.terminal256 import Terminal256Formatter, TerminalTrueColorFormatter
from pip._vendor.pygments.filters import get_all_filters, find_filter_class
from pip._vendor.pygments.styles import get_all_styles, get_style_by_name


def _parse_options(o_strs):
    opts = {}
    if not o_strs:
        return opts
    for o_str in o_strs:
        if not o_str.strip():
            continue
        o_args = o_str.split(',')
        for o_arg in o_args:
            o_arg = o_arg.strip()
            try:
                o_key, o_val = o_arg.split('=', 1)
                o_key = o_key.strip()
                o_val = o_val.strip()
            except ValueError:
                opts[o_arg] = True
            else:
                opts[o_key] = o_val
    return opts


def _parse_filters(f_strs):
    filters = []
    if not f_strs:
        return filters
    for f_str in f_strs:
        if ':' in f_str:
            fname, fopts = f_str.split(':', 1)
            filters.append((fname, _parse_options([fopts])))
        else:
            filters.append((f_str, {}))
    return filters


def _print_help(what, name):
    try:
        if what == 'lexer':
            cls = get_lexer_by_name(name)
            print("Help on the %s lexer:" % cls.name)
            print(dedent(cls.__doc__))
        elif what == 'formatter':
            cls = find_formatter_class(name)
            print("Help on the %s formatter:" % cls.name)
            print(dedent(cls.__doc__))
        elif what == 'filter':
            cls = find_filter_class(name)
            print("Help on the %s filter:" % name)
            print(dedent(cls.__doc__))
        return 0
    except (AttributeError, ValueError):
        print("%s not found!" % what, file=sys.stderr)
        return 1


def _print_list(what):
    if what == 'lexer':
        print()
        print("Lexers:")
        print("~~~~~~~")

        info = []
        for fullname, names, exts, _ in get_all_lexers():
            tup = (', '.join(names)+':', fullname,
                   exts and '(filenames ' + ', '.join(exts) + ')' or '')
            info.append(tup)
        info.sort()
        for i in info:
            print(('* %s\n    %s %s') % i)

    elif what == 'formatter':
        print()
        print("Formatters:")
        print("~~~~~~~~~~~")

        info = []
        for cls in get_all_formatters():
            doc = docstring_headline(cls)
            tup = (', '.join(cls.aliases) + ':', doc, cls.filenames and
                   '(filenames ' + ', '.join(cls.filenames) + ')' or '')
            info.append(tup)
        info.sort()
        for i in info:
            print(('* %s\n    %s %s') % i)

    elif what == 'filter':
        print()
        print("Filters:")
        print("~~~~~~~~")

        for name in get_all_filters():
            cls = find_filter_class(name)
            print("* " + name + ':')
            print("    %s" % docstring_headline(cls))

    elif what == 'style':
        print()
        print("Styles:")
        print("~~~~~~~")

        for name in get_all_styles():
            cls = get_style_by_name(name)
            print("* " + name + ':')
            print("    %s" % docstring_headline(cls))


def _print_list_as_json(requested_items):
    import json
    result = {}
    if 'lexer' in requested_items:
        info = {}
        for fullname, names, filenames, mimetypes in get_all_lexers():
            info[fullname] = {
                'aliases': names,
                'filenames': filenames,
                'mimetypes': mimetypes
            }
        result['lexers'] = info

    if 'formatter' in requested_items:
        info = {}
        for cls in get_all_formatters():
            doc = docstring_headline(cls)
            info[cls.name] = {
                'aliases': cls.aliases,
                'filenames': cls.filenames,
                'doc': doc
            }
        result['formatters'] = info

    if 'filter' in requested_items:
        info = {}
        for name in get_all_filters():
            cls = find_filter_class(name)
            info[name] = {
                'doc': docstring_headline(cls)
            }
        result['filters'] = info

    if 'style' in requested_items:
        info = {}
        for name in get_all_styles():
            cls = get_style_by_name(name)
            info[name] = {
                'doc': docstring_headline(cls)
            }
        result['styles'] = info

    json.dump(result, sys.stdout)

def main_inner(parser, argns):
    if argns.help:
        parser.print_help()
        return 0

    if argns.V:
        print('Pygments version %s, (c) 2006-2023 by Georg Brandl, Matthäus '
              'Chajdas and contributors.' % __version__)
        return 0

    def is_only_option(opt):
        return not any(v for (k, v) in vars(argns).items() if k != opt)

    # handle ``pygmentize -L``
    if argns.L is not None:
        arg_set = set()
        for k, v in vars(argns).items():
            if v:
                arg_set.add(k)

        arg_set.discard('L')
        arg_set.discard('json')

        if arg_set:
            parser.print_help(sys.stderr)
            return 2

        # print version
        if not argns.json:
            main(['', '-V'])
        allowed_types = {'lexer', 'formatter', 'filter', 'style'}
        largs = [arg.rstrip('s') for arg in argns.L]
        if any(arg not in allowed_types for arg in largs):
            parser.print_help(sys.stderr)
            return 0
        if not largs:
            largs = allowed_types
        if not argns.json:
            for arg in largs:
                _print_list(arg)
        else:
            _print_list_as_json(largs)
        return 0

    # handle ``pygmentize -H``
    if argns.H:
        if not is_only_option('H'):
            parser.print_help(sys.stderr)
            return 2
        what, name = argns.H
        if what not in ('lexer', 'formatter', 'filter'):
            parser.print_help(sys.stderr)
            return 2
        return _print_help(what, name)

    # parse -O options
    parsed_opts = _parse_options(argns.O or [])

    # parse -P options
    for p_opt in argns.P or []:
        try:
            name, value = p_opt.split('=', 1)
        except ValueError:
            parsed_opts[p_opt] = True
        else:
            parsed_opts[name] = value

    # encodings
    inencoding = parsed_opts.get('inencoding', parsed_opts.get('encoding'))
    outencoding = parsed_opts.get('outencoding', parsed_opts.get('encoding'))

    # handle ``pygmentize -N``
    if argns.N:
        lexer = find_lexer_class_for_filename(argns.N)
        if lexer is None:
            lexer = TextLexer

        print(lexer.aliases[0])
        return 0

    # handle ``pygmentize -C``
    if argns.C:
        inp = sys.stdin.buffer.read()
        try:
            lexer = guess_lexer(inp, inencoding=inencoding)
        except ClassNotFound:
            lexer = TextLexer

        print(lexer.aliases[0])
        return 0

    # handle ``pygmentize -S``
    S_opt = argns.S
    a_opt = argns.a
    if S_opt is not None:
        f_opt = argns.f
        if not f_opt:
            parser.print_help(sys.stderr)
            return 2
        if argns.l or argns.INPUTFILE:
            parser.print_help(sys.stderr)
            return 2

        try:
            parsed_opts['style'] = S_opt
            fmter = get_formatter_by_name(f_opt, **parsed_opts)
        except ClassNotFound as err:
            print(err, file=sys.stderr)
            return 1

        print(fmter.get_style_defs(a_opt or ''))
        return 0

    # if no -S is given, -a is not allowed
    if argns.a is not None:
        parser.print_help(sys.stderr)
        return 2

    # parse -F options
    F_opts = _parse_filters(argns.F or [])

    # -x: allow custom (eXternal) lexers and formatters
    allow_custom_lexer_formatter = bool(argns.x)

    # select lexer
    lexer = None

    # given by name?
    lexername = argns.l
    if lexername:
        # custom lexer, located relative to user's cwd
        if allow_custom_lexer_formatter and '.py' in lexername:
            try:
                filename = None
                name = None
                if ':' in lexername:
                    filename, name = lexername.rsplit(':', 1)

                    if '.py' in name:
                        # This can happen on Windows: If the lexername is
                        # C:\lexer.py -- return to normal load path in that case
                        name = None

                if filename and name:
                    lexer = load_lexer_from_file(filename, name,
                                                 **parsed_opts)
                else:
                    lexer = load_lexer_from_file(lexername, **parsed_opts)
            except ClassNotFound as err:
                print('Error:', err, file=sys.stderr)
                return 1
        else:
            try:
                lexer = get_lexer_by_name(lexername, **parsed_opts)
            except (OptionError, ClassNotFound) as err:
                print('Error:', err, file=sys.stderr)
                return 1

    # read input code
    code = None

    if argns.INPUTFILE:
        if argns.s:
            print('Error: -s option not usable when input file specified',
                  file=sys.stderr)
            return 2

        infn = argns.INPUTFILE
        try:
            with open(infn, 'rb') as infp:
                code = infp.read()
        except Exception as err:
            print('Error: cannot read infile:', err, file=sys.stderr)
            return 1
        if not inencoding:
            code, inencoding = guess_decode(code)

        # do we have to guess the lexer?
        if not lexer:
            try:
                lexer = get_lexer_for_filename(infn, code, **parsed_opts)
            except ClassNotFound as err:
                if argns.g:
                    try:
                        lexer = guess_lexer(code, **parsed_opts)
                    except ClassNotFound:
                        lexer = TextLexer(**parsed_opts)
                else:
                    print('Error:', err, file=sys.stderr)
                    return 1
            except OptionError as err:
                print('Error:', err, file=sys.stderr)
                return 1

    elif not argns.s:  # treat stdin as full file (-s support is later)
        # read code from terminal, always in binary mode since we want to
        # decode ourselves and be tolerant with it
        code = sys.stdin.buffer.read()  # use .buffer to get a binary stream
        if not inencoding:
            code, inencoding = guess_decode_from_terminal(code, sys.stdin)
            # else the lexer will do the decoding
        if not lexer:
            try:
                lexer = guess_lexer(code, **parsed_opts)
            except ClassNotFound:
                lexer = TextLexer(**parsed_opts)

    else:  # -s option needs a lexer with -l
        if not lexer:
            print('Error: when using -s a lexer has to be selected with -l',
                  file=sys.stderr)
            return 2

    # process filters
    for fname, fopts in F_opts:
        try:
            lexer.add_filter(fname, **fopts)
        except ClassNotFound as err:
            print('Error:', err, file=sys.stderr)
            return 1

    # select formatter
    outfn = argns.o
    fmter = argns.f
    if fmter:
        # custom formatter, located relative to user's cwd
        if allow_custom_lexer_formatter and '.py' in fmter:
            try:
                filename = None
                name = None
                if ':' in fmter:
                    # Same logic as above for custom lexer
                    filename, name = fmter.rsplit(':', 1)

                    if '.py' in name:
                        name = None

                if filename and name:
                    fmter = load_formatter_from_file(filename, name,
                                                     **parsed_opts)
                else:
                    fmter = load_formatter_from_file(fmter, **parsed_opts)
            except ClassNotFound as err:
                print('Error:', err, file=sys.stderr)
                return 1
        else:
            try:
                fmter = get_formatter_by_name(fmter, **parsed_opts)
            except (OptionError, ClassNotFound) as err:
                print('Error:', err, file=sys.stderr)
                return 1

    if outfn:
        if not fmter:
            try:
                fmter = get_formatter_for_filename(outfn, **parsed_opts)
            except (OptionError, ClassNotFound) as err:
                print('Error:', err, file=sys.stderr)
                return 1
        try:
            outfile = open(outfn, 'wb')
        except Exception as err:
            print('Error: cannot open outfile:', err, file=sys.stderr)
            return 1
    else:
        if not fmter:
            if os.environ.get('COLORTERM','') in ('truecolor', '24bit'):
                fmter = TerminalTrueColorFormatter(**parsed_opts)
            elif '256' in os.environ.get('TERM', ''):
                fmter = Terminal256Formatter(**parsed_opts)
            else:
                fmter = TerminalFormatter(**parsed_opts)
        outfile = sys.stdout.buffer

    # determine output encoding if not explicitly selected
    if not outencoding:
        if outfn:
            # output file? use lexer encoding for now (can still be None)
            fmter.encoding = inencoding
        else:
            # else use terminal encoding
            fmter.encoding = terminal_encoding(sys.stdout)

    # provide coloring under Windows, if possible
    if not outfn and sys.platform in ('win32', 'cygwin') and \
       fmter.name in ('Terminal', 'Terminal256'):  # pragma: no cover
        # unfortunately colorama doesn't support binary streams on Py3
        outfile = UnclosingTextIOWrapper(outfile, encoding=fmter.encoding)
        fmter.encoding = None
        try:
            import pip._vendor.colorama.initialise as colorama_initialise
        except ImportError:
            pass
        else:
            outfile = colorama_initialise.wrap_stream(
                outfile, convert=None, strip=None, autoreset=False, wrap=True)

    # When using the LaTeX formatter and the option `escapeinside` is
    # specified, we need a special lexer which collects escaped text
    # before running the chosen language lexer.
    escapeinside = parsed_opts.get('escapeinside', '')
    if len(escapeinside) == 2 and isinstance(fmter, LatexFormatter):
        left = escapeinside[0]
        right = escapeinside[1]
        lexer = LatexEmbeddedLexer(left, right, lexer)

    # ... and do it!
    if not argns.s:
        # process whole input as per normal...
        try:
            highlight(code, lexer, fmter, outfile)
        finally:
            if outfn:
                outfile.close()
        return 0
    else:
        # line by line processing of stdin (eg: for 'tail -f')...
        try:
            while 1:
                line = sys.stdin.buffer.readline()
                if not line:
                    break
                if not inencoding:
                    line = guess_decode_from_terminal(line, sys.stdin)[0]
                highlight(line, lexer, fmter, outfile)
                if hasattr(outfile, 'flush'):
                    outfile.flush()
            return 0
        except KeyboardInterrupt:  # pragma: no cover
            return 0
        finally:
            if outfn:
                outfile.close()


class HelpFormatter(argparse.HelpFormatter):
    def __init__(self, prog, indent_increment=2, max_help_position=16, width=None):
        if width is None:
            try:
                width = shutil.get_terminal_size().columns - 2
            except Exception:
                pass
        argparse.HelpFormatter.__init__(self, prog, indent_increment,
                                        max_help_position, width)


def main(args=sys.argv):
    """
    Main command line entry point.
    """
    desc = "Highlight an input file and write the result to an output file."
    parser = argparse.ArgumentParser(description=desc, add_help=False,
                                     formatter_class=HelpFormatter)

    operation = parser.add_argument_group('Main operation')
    lexersel = operation.add_mutually_exclusive_group()
    lexersel.add_argument(
        '-l', metavar='LEXER',
        help='Specify the lexer to use.  (Query names with -L.)  If not '
        'given and -g is not present, the lexer is guessed from the filename.')
    lexersel.add_argument(
        '-g', action='store_true',
        help='Guess the lexer from the file contents, or pass through '
        'as plain text if nothing can be guessed.')
    operation.add_argument(
        '-F', metavar='FILTER[:options]', action='append',
        help='Add a filter to the token stream.  (Query names with -L.) '
        'Filter options are given after a colon if necessary.')
    operation.add_argument(
        '-f', metavar='FORMATTER',
        help='Specify the formatter to use.  (Query names with -L.) '
        'If not given, the formatter is guessed from the output filename, '
        'and defaults to the terminal formatter if the output is to the '
        'terminal or an unknown file extension.')
    operation.add_argument(
        '-O', metavar='OPTION=value[,OPTION=value,...]', action='append',
        help='Give options to the lexer and formatter as a comma-separated '
        'list of key-value pairs. '
        'Example: `-O bg=light,python=cool`.')
    operation.add_argument(
        '-P', metavar='OPTION=value', action='append',
        help='Give a single option to the lexer and formatter - with this '
        'you can pass options whose value contains commas and equal signs. '
        'Example: `-P "heading=Pygments, the Python highlighter"`.')
    operation.add_argument(
        '-o', metavar='OUTPUTFILE',
        help='Where to write the output.  Defaults to standard output.')

    operation.add_argument(
        'INPUTFILE', nargs='?',
        help='Where to read the input.  Defaults to standard input.')

    flags = parser.add_argument_group('Operation flags')
    flags.add_argument(
        '-v', action='store_true',
        help='Print a detailed traceback on unhandled exceptions, which '
        'is useful for debugging and bug reports.')
    flags.add_argument(
        '-s', action='store_true',
        help='Process lines one at a time until EOF, rather than waiting to '
        'process the entire file.  This only works for stdin, only for lexers '
        'with no line-spanning constructs, and is intended for streaming '
        'input such as you get from `tail -f`. '
        'Example usage: `tail -f sql.log | pygmentize -s -l sql`.')
    flags.add_argument(
        '-x', action='store_true',
        help='Allow custom lexers and formatters to be loaded from a .py file '
        'relative to the current working directory. For example, '
        '`-l ./customlexer.py -x`. By default, this option expects a file '
        'with a class named CustomLexer or CustomFormatter; you can also '
        'specify your own class name with a colon (`-l ./lexer.py:MyLexer`). '
        'Users should be very careful not to use this option with untrusted '
        'files, because it will import and run them.')
    flags.add_argument('--json', help='Output as JSON. This can '
        'be only used in conjunction with -L.',
        default=False,
        action='store_true')

    special_modes_group = parser.add_argument_group(
        'Special modes - do not do any highlighting')
    special_modes = special_modes_group.add_mutually_exclusive_group()
    special_modes.add_argument(
        '-S', metavar='STYLE -f formatter',
        help='Print style definitions for STYLE for a formatter '
        'given with -f. The argument given by -a is formatter '
        'dependent.')
    special_modes.add_argument(
        '-L', nargs='*', metavar='WHAT',
        help='List lexers, formatters, styles or filters -- '
        'give additional arguments for the thing(s) you want to list '
        '(e.g. "styles"), or omit them to list everything.')
    special_modes.add_argument(
        '-N', metavar='FILENAME',
        help='Guess and print out a lexer name based solely on the given '
        'filename. Does not take input or highlight anything. If no specific '
        'lexer can be determined, "text" is printed.')
    special_modes.add_argument(
        '-C', action='store_true',
        help='Like -N, but print out a lexer name based solely on '
        'a given content from standard input.')
    special_modes.add_argument(
        '-H', action='store', nargs=2, metavar=('NAME', 'TYPE'),
        help='Print detailed help for the object <name> of type <type>, '
        'where <type> is one of "lexer", "formatter" or "filter".')
    special_modes.add_argument(
        '-V', action='store_true',
        help='Print the package version.')
    special_modes.add_argument(
        '-h', '--help', action='store_true',
        help='Print this help.')
    special_modes_group.add_argument(
        '-a', metavar='ARG',
        help='Formatter-specific additional argument for the -S (print '
        'style sheet) mode.')

    argns = parser.parse_args(args[1:])

    try:
        return main_inner(parser, argns)
    except BrokenPipeError:
        # someone closed our stdout, e.g. by quitting a pager.
        return 0
    except Exception:
        if argns.v:
            print(file=sys.stderr)
            print('*' * 65, file=sys.stderr)
            print('An unhandled exception occurred while highlighting.',
                  file=sys.stderr)
            print('Please report the whole traceback to the issue tracker at',
                  file=sys.stderr)
            print('<https://github.com/pygments/pygments/issues>.',
                  file=sys.stderr)
            print('*' * 65, file=sys.stderr)
            print(file=sys.stderr)
            raise
        import traceback
        info = traceback.format_exception(*sys.exc_info())
        msg = info[-1].strip()
        if len(info) >= 3:
            # extract relevant file and position info
            msg += '\n   (f%s)' % info[-2].split('\n')[0].strip()[1:]
        print(file=sys.stderr)
        print('*** Error while highlighting:', file=sys.stderr)
        print(msg, file=sys.stderr)
        print('*** If this is a bug you want to report, please rerun with -v.',
              file=sys.stderr)
        return 1

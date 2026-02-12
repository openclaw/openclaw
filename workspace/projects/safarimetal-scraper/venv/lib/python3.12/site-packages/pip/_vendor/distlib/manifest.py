# -*- coding: utf-8 -*-
#
# Copyright (C) 2012-2023 Python Software Foundation.
# See LICENSE.txt and CONTRIBUTORS.txt.
#
"""
Class representing the list of files in a distribution.

Equivalent to distutils.filelist, but fixes some problems.
"""
import fnmatch
import logging
import os
import re
import sys

from . import DistlibException
from .compat import fsdecode
from .util import convert_path


__all__ = ['Manifest']

logger = logging.getLogger(__name__)

# a \ followed by some spaces + EOL
_COLLAPSE_PATTERN = re.compile('\\\\w*\n', re.M)
_COMMENTED_LINE = re.compile('#.*?(?=\n)|\n(?=$)', re.M | re.S)

#
# Due to the different results returned by fnmatch.translate, we need
# to do slightly different processing for Python 2.7 and 3.2 ... this needed
# to be brought in for Python 3.6 onwards.
#
_PYTHON_VERSION = sys.version_info[:2]


class Manifest(object):
    """
    A list of files built by exploring the filesystem and filtered by applying various
    patterns to what we find there.
    """

    def __init__(self, base=None):
        """
        Initialise an instance.

        :param base: The base directory to explore under.
        """
        self.base = os.path.abspath(os.path.normpath(base or os.getcwd()))
        self.prefix = self.base + os.sep
        self.allfiles = None
        self.files = set()

    #
    # Public API
    #

    def findall(self):
        """Find all files under the base and set ``allfiles`` to the absolute
        pathnames of files found.
        """
        from stat import S_ISREG, S_ISDIR, S_ISLNK

        self.allfiles = allfiles = []
        root = self.base
        stack = [root]
        pop = stack.pop
        push = stack.append

        while stack:
            root = pop()
            names = os.listdir(root)

            for name in names:
                fullname = os.path.join(root, name)

                # Avoid excess stat calls -- just one will do, thank you!
                stat = os.stat(fullname)
                mode = stat.st_mode
                if S_ISREG(mode):
                    allfiles.append(fsdecode(fullname))
                elif S_ISDIR(mode) and not S_ISLNK(mode):
                    push(fullname)

    def add(self, item):
        """
        Add a file to the manifest.

        :param item: The pathname to add. This can be relative to the base.
        """
        if not item.startswith(self.prefix):
            item = os.path.join(self.base, item)
        self.files.add(os.path.normpath(item))

    def add_many(self, items):
        """
        Add a list of files to the manifest.

        :param items: The pathnames to add. These can be relative to the base.
        """
        for item in items:
            self.add(item)

    def sorted(self, wantdirs=False):
        """
        Return sorted files in directory order
        """

        def add_dir(dirs, d):
            dirs.add(d)
            logger.debug('add_dir added %s', d)
            if d != self.base:
                parent, _ = os.path.split(d)
                assert parent not in ('', '/')
                add_dir(dirs, parent)

        result = set(self.files)    # make a copy!
        if wantdirs:
            dirs = set()
            for f in result:
                add_dir(dirs, os.path.dirname(f))
            result |= dirs
        return [os.path.join(*path_tuple) for path_tuple in
                sorted(os.path.split(path) for path in result)]

    def clear(self):
        """Clear all collected files."""
        self.files = set()
        self.allfiles = []

    def process_directive(self, directive):
        """
        Process a directive which either adds some files from ``allfiles`` to
        ``files``, or removes some files from ``files``.

        :param directive: The directive to process. This should be in a format
                     compatible with distutils ``MANIFEST.in`` files:

                     http://docs.python.org/distutils/sourcedist.html#commands
        """
        # Parse the line: split it up, make sure the right number of words
        # is there, and return the relevant words.  'action' is always
        # defined: it's the first word of the line.  Which of the other
        # three are defined depends on the action; it'll be either
        # patterns, (dir and patterns), or (dirpattern).
        action, patterns, thedir, dirpattern = self._parse_directive(directive)

        # OK, now we know that the action is valid and we have the
        # right number of words on the line for that action -- so we
        # can proceed with minimal error-checking.
        if action == 'include':
            for pattern in patterns:
                if not self._include_pattern(pattern, anchor=True):
                    logger.warning('no files found matching %r', pattern)

        elif action == 'exclude':
            for pattern in patterns:
                self._exclude_pattern(pattern, anchor=True)

        elif action == 'global-include':
            for pattern in patterns:
                if not self._include_pattern(pattern, anchor=False):
                    logger.warning('no files found matching %r '
                                   'anywhere in distribution', pattern)

        elif action == 'global-exclude':
            for pattern in patterns:
                self._exclude_pattern(pattern, anchor=False)

        elif action == 'recursive-include':
            for pattern in patterns:
                if not self._include_pattern(pattern, prefix=thedir):
                    logger.warning('no files found matching %r '
                                   'under directory %r', pattern, thedir)

        elif action == 'recursive-exclude':
            for pattern in patterns:
                self._exclude_pattern(pattern, prefix=thedir)

        elif action == 'graft':
            if not self._include_pattern(None, prefix=dirpattern):
                logger.warning('no directories found matching %r',
                               dirpattern)

        elif action == 'prune':
            if not self._exclude_pattern(None, prefix=dirpattern):
                logger.warning('no previously-included directories found '
                               'matching %r', dirpattern)
        else:   # pragma: no cover
            # This should never happen, as it should be caught in
            # _parse_template_line
            raise DistlibException(
                'invalid action %r' % action)

    #
    # Private API
    #

    def _parse_directive(self, directive):
        """
        Validate a directive.
        :param directive: The directive to validate.
        :return: A tuple of action, patterns, thedir, dir_patterns
        """
        words = directive.split()
        if len(words) == 1 and words[0] not in ('include', 'exclude',
                                                'global-include',
                                                'global-exclude',
                                                'recursive-include',
                                                'recursive-exclude',
                                                'graft', 'prune'):
            # no action given, let's use the default 'include'
            words.insert(0, 'include')

        action = words[0]
        patterns = thedir = dir_pattern = None

        if action in ('include', 'exclude',
                      'global-include', 'global-exclude'):
            if len(words) < 2:
                raise DistlibException(
                    '%r expects <pattern1> <pattern2> ...' % action)

            patterns = [convert_path(word) for word in words[1:]]

        elif action in ('recursive-include', 'recursive-exclude'):
            if len(words) < 3:
                raise DistlibException(
                    '%r expects <dir> <pattern1> <pattern2> ...' % action)

            thedir = convert_path(words[1])
            patterns = [convert_path(word) for word in words[2:]]

        elif action in ('graft', 'prune'):
            if len(words) != 2:
                raise DistlibException(
                    '%r expects a single <dir_pattern>' % action)

            dir_pattern = convert_path(words[1])

        else:
            raise DistlibException('unknown action %r' % action)

        return action, patterns, thedir, dir_pattern

    def _include_pattern(self, pattern, anchor=True, prefix=None,
                         is_regex=False):
        """Select strings (presumably filenames) from 'self.files' that
        match 'pattern', a Unix-style wildcard (glob) pattern.

        Patterns are not quite the same as implemented by the 'fnmatch'
        module: '*' and '?'  match non-special characters, where "special"
        is platform-dependent: slash on Unix; colon, slash, and backslash on
        DOS/Windows; and colon on Mac OS.

        If 'anchor' is true (the default), then the pattern match is more
        stringent: "*.py" will match "foo.py" but not "foo/bar.py".  If
        'anchor' is false, both of these will match.

        If 'prefix' is supplied, then only filenames starting with 'prefix'
        (itself a pattern) and ending with 'pattern', with anything in between
        them, will match.  'anchor' is ignored in this case.

        If 'is_regex' is true, 'anchor' and 'prefix' are ignored, and
        'pattern' is assumed to be either a string containing a regex or a
        regex object -- no translation is done, the regex is just compiled
        and used as-is.

        Selected strings will be added to self.files.

        Return True if files are found.
        """
        # XXX docstring lying about what the special chars are?
        found = False
        pattern_re = self._translate_pattern(pattern, anchor, prefix, is_regex)

        # delayed loading of allfiles list
        if self.allfiles is None:
            self.findall()

        for name in self.allfiles:
            if pattern_re.search(name):
                self.files.add(name)
                found = True
        return found

    def _exclude_pattern(self, pattern, anchor=True, prefix=None,
                         is_regex=False):
        """Remove strings (presumably filenames) from 'files' that match
        'pattern'.

        Other parameters are the same as for 'include_pattern()', above.
        The list 'self.files' is modified in place. Return True if files are
        found.

        This API is public to allow e.g. exclusion of SCM subdirs, e.g. when
        packaging source distributions
        """
        found = False
        pattern_re = self._translate_pattern(pattern, anchor, prefix, is_regex)
        for f in list(self.files):
            if pattern_re.search(f):
                self.files.remove(f)
                found = True
        return found

    def _translate_pattern(self, pattern, anchor=True, prefix=None,
                           is_regex=False):
        """Translate a shell-like wildcard pattern to a compiled regular
        expression.

        Return the compiled regex.  If 'is_regex' true,
        then 'pattern' is directly compiled to a regex (if it's a string)
        or just returned as-is (assumes it's a regex object).
        """
        if is_regex:
            if isinstance(pattern, str):
                return re.compile(pattern)
            else:
                return pattern

        if _PYTHON_VERSION > (3, 2):
            # ditch start and end characters
            start, _, end = self._glob_to_re('_').partition('_')

        if pattern:
            pattern_re = self._glob_to_re(pattern)
            if _PYTHON_VERSION > (3, 2):
                assert pattern_re.startswith(start) and pattern_re.endswith(end)
        else:
            pattern_re = ''

        base = re.escape(os.path.join(self.base, ''))
        if prefix is not None:
            # ditch end of pattern character
            if _PYTHON_VERSION <= (3, 2):
                empty_pattern = self._glob_to_re('')
                prefix_re = self._glob_to_re(prefix)[:-len(empty_pattern)]
            else:
                prefix_re = self._glob_to_re(prefix)
                assert prefix_re.startswith(start) and prefix_re.endswith(end)
                prefix_re = prefix_re[len(start): len(prefix_re) - len(end)]
            sep = os.sep
            if os.sep == '\\':
                sep = r'\\'
            if _PYTHON_VERSION <= (3, 2):
                pattern_re = '^' + base + sep.join((prefix_re,
                                                    '.*' + pattern_re))
            else:
                pattern_re = pattern_re[len(start): len(pattern_re) - len(end)]
                pattern_re = r'%s%s%s%s.*%s%s' % (start, base, prefix_re, sep,
                                                  pattern_re, end)
        else:  # no prefix -- respect anchor flag
            if anchor:
                if _PYTHON_VERSION <= (3, 2):
                    pattern_re = '^' + base + pattern_re
                else:
                    pattern_re = r'%s%s%s' % (start, base, pattern_re[len(start):])

        return re.compile(pattern_re)

    def _glob_to_re(self, pattern):
        """Translate a shell-like glob pattern to a regular expression.

        Return a string containing the regex.  Differs from
        'fnmatch.translate()' in that '*' does not match "special characters"
        (which are platform-specific).
        """
        pattern_re = fnmatch.translate(pattern)

        # '?' and '*' in the glob pattern become '.' and '.*' in the RE, which
        # IMHO is wrong -- '?' and '*' aren't supposed to match slash in Unix,
        # and by extension they shouldn't match such "special characters" under
        # any OS.  So change all non-escaped dots in the RE to match any
        # character except the special characters (currently: just os.sep).
        sep = os.sep
        if os.sep == '\\':
            # we're using a regex to manipulate a regex, so we need
            # to escape the backslash twice
            sep = r'\\\\'
        escaped = r'\1[^%s]' % sep
        pattern_re = re.sub(r'((?<!\\)(\\\\)*)\.', escaped, pattern_re)
        return pattern_re

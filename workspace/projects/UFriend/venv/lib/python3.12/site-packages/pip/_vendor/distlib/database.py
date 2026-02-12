# -*- coding: utf-8 -*-
#
# Copyright (C) 2012-2023 The Python Software Foundation.
# See LICENSE.txt and CONTRIBUTORS.txt.
#
"""PEP 376 implementation."""

from __future__ import unicode_literals

import base64
import codecs
import contextlib
import hashlib
import logging
import os
import posixpath
import sys
import zipimport

from . import DistlibException, resources
from .compat import StringIO
from .version import get_scheme, UnsupportedVersionError
from .metadata import (Metadata, METADATA_FILENAME, WHEEL_METADATA_FILENAME,
                       LEGACY_METADATA_FILENAME)
from .util import (parse_requirement, cached_property, parse_name_and_version,
                   read_exports, write_exports, CSVReader, CSVWriter)

__all__ = [
    'Distribution', 'BaseInstalledDistribution', 'InstalledDistribution',
    'EggInfoDistribution', 'DistributionPath'
]

logger = logging.getLogger(__name__)

EXPORTS_FILENAME = 'pydist-exports.json'
COMMANDS_FILENAME = 'pydist-commands.json'

DIST_FILES = ('INSTALLER', METADATA_FILENAME, 'RECORD', 'REQUESTED',
              'RESOURCES', EXPORTS_FILENAME, 'SHARED')

DISTINFO_EXT = '.dist-info'


class _Cache(object):
    """
    A simple cache mapping names and .dist-info paths to distributions
    """

    def __init__(self):
        """
        Initialise an instance. There is normally one for each DistributionPath.
        """
        self.name = {}
        self.path = {}
        self.generated = False

    def clear(self):
        """
        Clear the cache, setting it to its initial state.
        """
        self.name.clear()
        self.path.clear()
        self.generated = False

    def add(self, dist):
        """
        Add a distribution to the cache.
        :param dist: The distribution to add.
        """
        if dist.path not in self.path:
            self.path[dist.path] = dist
            self.name.setdefault(dist.key, []).append(dist)


class DistributionPath(object):
    """
    Represents a set of distributions installed on a path (typically sys.path).
    """

    def __init__(self, path=None, include_egg=False):
        """
        Create an instance from a path, optionally including legacy (distutils/
        setuptools/distribute) distributions.
        :param path: The path to use, as a list of directories. If not specified,
                     sys.path is used.
        :param include_egg: If True, this instance will look for and return legacy
                            distributions as well as those based on PEP 376.
        """
        if path is None:
            path = sys.path
        self.path = path
        self._include_dist = True
        self._include_egg = include_egg

        self._cache = _Cache()
        self._cache_egg = _Cache()
        self._cache_enabled = True
        self._scheme = get_scheme('default')

    def _get_cache_enabled(self):
        return self._cache_enabled

    def _set_cache_enabled(self, value):
        self._cache_enabled = value

    cache_enabled = property(_get_cache_enabled, _set_cache_enabled)

    def clear_cache(self):
        """
        Clears the internal cache.
        """
        self._cache.clear()
        self._cache_egg.clear()

    def _yield_distributions(self):
        """
        Yield .dist-info and/or .egg(-info) distributions.
        """
        # We need to check if we've seen some resources already, because on
        # some Linux systems (e.g. some Debian/Ubuntu variants) there are
        # symlinks which alias other files in the environment.
        seen = set()
        for path in self.path:
            finder = resources.finder_for_path(path)
            if finder is None:
                continue
            r = finder.find('')
            if not r or not r.is_container:
                continue
            rset = sorted(r.resources)
            for entry in rset:
                r = finder.find(entry)
                if not r or r.path in seen:
                    continue
                try:
                    if self._include_dist and entry.endswith(DISTINFO_EXT):
                        possible_filenames = [
                            METADATA_FILENAME, WHEEL_METADATA_FILENAME,
                            LEGACY_METADATA_FILENAME
                        ]
                        for metadata_filename in possible_filenames:
                            metadata_path = posixpath.join(
                                entry, metadata_filename)
                            pydist = finder.find(metadata_path)
                            if pydist:
                                break
                        else:
                            continue

                        with contextlib.closing(pydist.as_stream()) as stream:
                            metadata = Metadata(fileobj=stream,
                                                scheme='legacy')
                        logger.debug('Found %s', r.path)
                        seen.add(r.path)
                        yield new_dist_class(r.path,
                                             metadata=metadata,
                                             env=self)
                    elif self._include_egg and entry.endswith(
                            ('.egg-info', '.egg')):
                        logger.debug('Found %s', r.path)
                        seen.add(r.path)
                        yield old_dist_class(r.path, self)
                except Exception as e:
                    msg = 'Unable to read distribution at %s, perhaps due to bad metadata: %s'
                    logger.warning(msg, r.path, e)
                    import warnings
                    warnings.warn(msg % (r.path, e), stacklevel=2)

    def _generate_cache(self):
        """
        Scan the path for distributions and populate the cache with
        those that are found.
        """
        gen_dist = not self._cache.generated
        gen_egg = self._include_egg and not self._cache_egg.generated
        if gen_dist or gen_egg:
            for dist in self._yield_distributions():
                if isinstance(dist, InstalledDistribution):
                    self._cache.add(dist)
                else:
                    self._cache_egg.add(dist)

            if gen_dist:
                self._cache.generated = True
            if gen_egg:
                self._cache_egg.generated = True

    @classmethod
    def distinfo_dirname(cls, name, version):
        """
        The *name* and *version* parameters are converted into their
        filename-escaped form, i.e. any ``'-'`` characters are replaced
        with ``'_'`` other than the one in ``'dist-info'`` and the one
        separating the name from the version number.

        :parameter name: is converted to a standard distribution name by replacing
                         any runs of non- alphanumeric characters with a single
                         ``'-'``.
        :type name: string
        :parameter version: is converted to a standard version string. Spaces
                            become dots, and all other non-alphanumeric characters
                            (except dots) become dashes, with runs of multiple
                            dashes condensed to a single dash.
        :type version: string
        :returns: directory name
        :rtype: string"""
        name = name.replace('-', '_')
        return '-'.join([name, version]) + DISTINFO_EXT

    def get_distributions(self):
        """
        Provides an iterator that looks for distributions and returns
        :class:`InstalledDistribution` or
        :class:`EggInfoDistribution` instances for each one of them.

        :rtype: iterator of :class:`InstalledDistribution` and
                :class:`EggInfoDistribution` instances
        """
        if not self._cache_enabled:
            for dist in self._yield_distributions():
                yield dist
        else:
            self._generate_cache()

            for dist in self._cache.path.values():
                yield dist

            if self._include_egg:
                for dist in self._cache_egg.path.values():
                    yield dist

    def get_distribution(self, name):
        """
        Looks for a named distribution on the path.

        This function only returns the first result found, as no more than one
        value is expected. If nothing is found, ``None`` is returned.

        :rtype: :class:`InstalledDistribution`, :class:`EggInfoDistribution`
                or ``None``
        """
        result = None
        name = name.lower()
        if not self._cache_enabled:
            for dist in self._yield_distributions():
                if dist.key == name:
                    result = dist
                    break
        else:
            self._generate_cache()

            if name in self._cache.name:
                result = self._cache.name[name][0]
            elif self._include_egg and name in self._cache_egg.name:
                result = self._cache_egg.name[name][0]
        return result

    def provides_distribution(self, name, version=None):
        """
        Iterates over all distributions to find which distributions provide *name*.
        If a *version* is provided, it will be used to filter the results.

        This function only returns the first result found, since no more than
        one values are expected. If the directory is not found, returns ``None``.

        :parameter version: a version specifier that indicates the version
                            required, conforming to the format in ``PEP-345``

        :type name: string
        :type version: string
        """
        matcher = None
        if version is not None:
            try:
                matcher = self._scheme.matcher('%s (%s)' % (name, version))
            except ValueError:
                raise DistlibException('invalid name or version: %r, %r' %
                                       (name, version))

        for dist in self.get_distributions():
            # We hit a problem on Travis where enum34 was installed and doesn't
            # have a provides attribute ...
            if not hasattr(dist, 'provides'):
                logger.debug('No "provides": %s', dist)
            else:
                provided = dist.provides

                for p in provided:
                    p_name, p_ver = parse_name_and_version(p)
                    if matcher is None:
                        if p_name == name:
                            yield dist
                            break
                    else:
                        if p_name == name and matcher.match(p_ver):
                            yield dist
                            break

    def get_file_path(self, name, relative_path):
        """
        Return the path to a resource file.
        """
        dist = self.get_distribution(name)
        if dist is None:
            raise LookupError('no distribution named %r found' % name)
        return dist.get_resource_path(relative_path)

    def get_exported_entries(self, category, name=None):
        """
        Return all of the exported entries in a particular category.

        :param category: The category to search for entries.
        :param name: If specified, only entries with that name are returned.
        """
        for dist in self.get_distributions():
            r = dist.exports
            if category in r:
                d = r[category]
                if name is not None:
                    if name in d:
                        yield d[name]
                else:
                    for v in d.values():
                        yield v


class Distribution(object):
    """
    A base class for distributions, whether installed or from indexes.
    Either way, it must have some metadata, so that's all that's needed
    for construction.
    """

    build_time_dependency = False
    """
    Set to True if it's known to be only a build-time dependency (i.e.
    not needed after installation).
    """

    requested = False
    """A boolean that indicates whether the ``REQUESTED`` metadata file is
    present (in other words, whether the package was installed by user
    request or it was installed as a dependency)."""

    def __init__(self, metadata):
        """
        Initialise an instance.
        :param metadata: The instance of :class:`Metadata` describing this
        distribution.
        """
        self.metadata = metadata
        self.name = metadata.name
        self.key = self.name.lower()  # for case-insensitive comparisons
        self.version = metadata.version
        self.locator = None
        self.digest = None
        self.extras = None  # additional features requested
        self.context = None  # environment marker overrides
        self.download_urls = set()
        self.digests = {}

    @property
    def source_url(self):
        """
        The source archive download URL for this distribution.
        """
        return self.metadata.source_url

    download_url = source_url  # Backward compatibility

    @property
    def name_and_version(self):
        """
        A utility property which displays the name and version in parentheses.
        """
        return '%s (%s)' % (self.name, self.version)

    @property
    def provides(self):
        """
        A set of distribution names and versions provided by this distribution.
        :return: A set of "name (version)" strings.
        """
        plist = self.metadata.provides
        s = '%s (%s)' % (self.name, self.version)
        if s not in plist:
            plist.append(s)
        return plist

    def _get_requirements(self, req_attr):
        md = self.metadata
        reqts = getattr(md, req_attr)
        logger.debug('%s: got requirements %r from metadata: %r', self.name,
                     req_attr, reqts)
        return set(
            md.get_requirements(reqts, extras=self.extras, env=self.context))

    @property
    def run_requires(self):
        return self._get_requirements('run_requires')

    @property
    def meta_requires(self):
        return self._get_requirements('meta_requires')

    @property
    def build_requires(self):
        return self._get_requirements('build_requires')

    @property
    def test_requires(self):
        return self._get_requirements('test_requires')

    @property
    def dev_requires(self):
        return self._get_requirements('dev_requires')

    def matches_requirement(self, req):
        """
        Say if this instance matches (fulfills) a requirement.
        :param req: The requirement to match.
        :rtype req: str
        :return: True if it matches, else False.
        """
        # Requirement may contain extras - parse to lose those
        # from what's passed to the matcher
        r = parse_requirement(req)
        scheme = get_scheme(self.metadata.scheme)
        try:
            matcher = scheme.matcher(r.requirement)
        except UnsupportedVersionError:
            # XXX compat-mode if cannot read the version
            logger.warning('could not read version %r - using name only', req)
            name = req.split()[0]
            matcher = scheme.matcher(name)

        name = matcher.key  # case-insensitive

        result = False
        for p in self.provides:
            p_name, p_ver = parse_name_and_version(p)
            if p_name != name:
                continue
            try:
                result = matcher.match(p_ver)
                break
            except UnsupportedVersionError:
                pass
        return result

    def __repr__(self):
        """
        Return a textual representation of this instance,
        """
        if self.source_url:
            suffix = ' [%s]' % self.source_url
        else:
            suffix = ''
        return '<Distribution %s (%s)%s>' % (self.name, self.version, suffix)

    def __eq__(self, other):
        """
        See if this distribution is the same as another.
        :param other: The distribution to compare with. To be equal to one
                      another. distributions must have the same type, name,
                      version and source_url.
        :return: True if it is the same, else False.
        """
        if type(other) is not type(self):
            result = False
        else:
            result = (self.name == other.name and self.version == other.version
                      and self.source_url == other.source_url)
        return result

    def __hash__(self):
        """
        Compute hash in a way which matches the equality test.
        """
        return hash(self.name) + hash(self.version) + hash(self.source_url)


class BaseInstalledDistribution(Distribution):
    """
    This is the base class for installed distributions (whether PEP 376 or
    legacy).
    """

    hasher = None

    def __init__(self, metadata, path, env=None):
        """
        Initialise an instance.
        :param metadata: An instance of :class:`Metadata` which describes the
                         distribution. This will normally have been initialised
                         from a metadata file in the ``path``.
        :param path:     The path of the ``.dist-info`` or ``.egg-info``
                         directory for the distribution.
        :param env:      This is normally the :class:`DistributionPath`
                         instance where this distribution was found.
        """
        super(BaseInstalledDistribution, self).__init__(metadata)
        self.path = path
        self.dist_path = env

    def get_hash(self, data, hasher=None):
        """
        Get the hash of some data, using a particular hash algorithm, if
        specified.

        :param data: The data to be hashed.
        :type data: bytes
        :param hasher: The name of a hash implementation, supported by hashlib,
                       or ``None``. Examples of valid values are ``'sha1'``,
                       ``'sha224'``, ``'sha384'``, '``sha256'``, ``'md5'`` and
                       ``'sha512'``. If no hasher is specified, the ``hasher``
                       attribute of the :class:`InstalledDistribution` instance
                       is used. If the hasher is determined to be ``None``, MD5
                       is used as the hashing algorithm.
        :returns: The hash of the data. If a hasher was explicitly specified,
                  the returned hash will be prefixed with the specified hasher
                  followed by '='.
        :rtype: str
        """
        if hasher is None:
            hasher = self.hasher
        if hasher is None:
            hasher = hashlib.md5
            prefix = ''
        else:
            hasher = getattr(hashlib, hasher)
            prefix = '%s=' % self.hasher
        digest = hasher(data).digest()
        digest = base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')
        return '%s%s' % (prefix, digest)


class InstalledDistribution(BaseInstalledDistribution):
    """
    Created with the *path* of the ``.dist-info`` directory provided to the
    constructor. It reads the metadata contained in ``pydist.json`` when it is
    instantiated., or uses a passed in Metadata instance (useful for when
    dry-run mode is being used).
    """

    hasher = 'sha256'

    def __init__(self, path, metadata=None, env=None):
        self.modules = []
        self.finder = finder = resources.finder_for_path(path)
        if finder is None:
            raise ValueError('finder unavailable for %s' % path)
        if env and env._cache_enabled and path in env._cache.path:
            metadata = env._cache.path[path].metadata
        elif metadata is None:
            r = finder.find(METADATA_FILENAME)
            # Temporary - for Wheel 0.23 support
            if r is None:
                r = finder.find(WHEEL_METADATA_FILENAME)
            # Temporary - for legacy support
            if r is None:
                r = finder.find(LEGACY_METADATA_FILENAME)
            if r is None:
                raise ValueError('no %s found in %s' %
                                 (METADATA_FILENAME, path))
            with contextlib.closing(r.as_stream()) as stream:
                metadata = Metadata(fileobj=stream, scheme='legacy')

        super(InstalledDistribution, self).__init__(metadata, path, env)

        if env and env._cache_enabled:
            env._cache.add(self)

        r = finder.find('REQUESTED')
        self.requested = r is not None
        p = os.path.join(path, 'top_level.txt')
        if os.path.exists(p):
            with open(p, 'rb') as f:
                data = f.read().decode('utf-8')
            self.modules = data.splitlines()

    def __repr__(self):
        return '<InstalledDistribution %r %s at %r>' % (
            self.name, self.version, self.path)

    def __str__(self):
        return "%s %s" % (self.name, self.version)

    def _get_records(self):
        """
        Get the list of installed files for the distribution
        :return: A list of tuples of path, hash and size. Note that hash and
                 size might be ``None`` for some entries. The path is exactly
                 as stored in the file (which is as in PEP 376).
        """
        results = []
        r = self.get_distinfo_resource('RECORD')
        with contextlib.closing(r.as_stream()) as stream:
            with CSVReader(stream=stream) as record_reader:
                # Base location is parent dir of .dist-info dir
                # base_location = os.path.dirname(self.path)
                # base_location = os.path.abspath(base_location)
                for row in record_reader:
                    missing = [None for i in range(len(row), 3)]
                    path, checksum, size = row + missing
                    # if not os.path.isabs(path):
                    #     path = path.replace('/', os.sep)
                    #     path = os.path.join(base_location, path)
                    results.append((path, checksum, size))
        return results

    @cached_property
    def exports(self):
        """
        Return the information exported by this distribution.
        :return: A dictionary of exports, mapping an export category to a dict
                 of :class:`ExportEntry` instances describing the individual
                 export entries, and keyed by name.
        """
        result = {}
        r = self.get_distinfo_resource(EXPORTS_FILENAME)
        if r:
            result = self.read_exports()
        return result

    def read_exports(self):
        """
        Read exports data from a file in .ini format.

        :return: A dictionary of exports, mapping an export category to a list
                 of :class:`ExportEntry` instances describing the individual
                 export entries.
        """
        result = {}
        r = self.get_distinfo_resource(EXPORTS_FILENAME)
        if r:
            with contextlib.closing(r.as_stream()) as stream:
                result = read_exports(stream)
        return result

    def write_exports(self, exports):
        """
        Write a dictionary of exports to a file in .ini format.
        :param exports: A dictionary of exports, mapping an export category to
                        a list of :class:`ExportEntry` instances describing the
                        individual export entries.
        """
        rf = self.get_distinfo_file(EXPORTS_FILENAME)
        with open(rf, 'w') as f:
            write_exports(exports, f)

    def get_resource_path(self, relative_path):
        """
        NOTE: This API may change in the future.

        Return the absolute path to a resource file with the given relative
        path.

        :param relative_path: The path, relative to .dist-info, of the resource
                              of interest.
        :return: The absolute path where the resource is to be found.
        """
        r = self.get_distinfo_resource('RESOURCES')
        with contextlib.closing(r.as_stream()) as stream:
            with CSVReader(stream=stream) as resources_reader:
                for relative, destination in resources_reader:
                    if relative == relative_path:
                        return destination
        raise KeyError('no resource file with relative path %r '
                       'is installed' % relative_path)

    def list_installed_files(self):
        """
        Iterates over the ``RECORD`` entries and returns a tuple
        ``(path, hash, size)`` for each line.

        :returns: iterator of (path, hash, size)
        """
        for result in self._get_records():
            yield result

    def write_installed_files(self, paths, prefix, dry_run=False):
        """
        Writes the ``RECORD`` file, using the ``paths`` iterable passed in. Any
        existing ``RECORD`` file is silently overwritten.

        prefix is used to determine when to write absolute paths.
        """
        prefix = os.path.join(prefix, '')
        base = os.path.dirname(self.path)
        base_under_prefix = base.startswith(prefix)
        base = os.path.join(base, '')
        record_path = self.get_distinfo_file('RECORD')
        logger.info('creating %s', record_path)
        if dry_run:
            return None
        with CSVWriter(record_path) as writer:
            for path in paths:
                if os.path.isdir(path) or path.endswith(('.pyc', '.pyo')):
                    # do not put size and hash, as in PEP-376
                    hash_value = size = ''
                else:
                    size = '%d' % os.path.getsize(path)
                    with open(path, 'rb') as fp:
                        hash_value = self.get_hash(fp.read())
                if path.startswith(base) or (base_under_prefix
                                             and path.startswith(prefix)):
                    path = os.path.relpath(path, base)
                writer.writerow((path, hash_value, size))

            # add the RECORD file itself
            if record_path.startswith(base):
                record_path = os.path.relpath(record_path, base)
            writer.writerow((record_path, '', ''))
        return record_path

    def check_installed_files(self):
        """
        Checks that the hashes and sizes of the files in ``RECORD`` are
        matched by the files themselves. Returns a (possibly empty) list of
        mismatches. Each entry in the mismatch list will be a tuple consisting
        of the path, 'exists', 'size' or 'hash' according to what didn't match
        (existence is checked first, then size, then hash), the expected
        value and the actual value.
        """
        mismatches = []
        base = os.path.dirname(self.path)
        record_path = self.get_distinfo_file('RECORD')
        for path, hash_value, size in self.list_installed_files():
            if not os.path.isabs(path):
                path = os.path.join(base, path)
            if path == record_path:
                continue
            if not os.path.exists(path):
                mismatches.append((path, 'exists', True, False))
            elif os.path.isfile(path):
                actual_size = str(os.path.getsize(path))
                if size and actual_size != size:
                    mismatches.append((path, 'size', size, actual_size))
                elif hash_value:
                    if '=' in hash_value:
                        hasher = hash_value.split('=', 1)[0]
                    else:
                        hasher = None

                    with open(path, 'rb') as f:
                        actual_hash = self.get_hash(f.read(), hasher)
                        if actual_hash != hash_value:
                            mismatches.append(
                                (path, 'hash', hash_value, actual_hash))
        return mismatches

    @cached_property
    def shared_locations(self):
        """
        A dictionary of shared locations whose keys are in the set 'prefix',
        'purelib', 'platlib', 'scripts', 'headers', 'data' and 'namespace'.
        The corresponding value is the absolute path of that category for
        this distribution, and takes into account any paths selected by the
        user at installation time (e.g. via command-line arguments). In the
        case of the 'namespace' key, this would be a list of absolute paths
        for the roots of namespace packages in this distribution.

        The first time this property is accessed, the relevant information is
        read from the SHARED file in the .dist-info directory.
        """
        result = {}
        shared_path = os.path.join(self.path, 'SHARED')
        if os.path.isfile(shared_path):
            with codecs.open(shared_path, 'r', encoding='utf-8') as f:
                lines = f.read().splitlines()
            for line in lines:
                key, value = line.split('=', 1)
                if key == 'namespace':
                    result.setdefault(key, []).append(value)
                else:
                    result[key] = value
        return result

    def write_shared_locations(self, paths, dry_run=False):
        """
        Write shared location information to the SHARED file in .dist-info.
        :param paths: A dictionary as described in the documentation for
        :meth:`shared_locations`.
        :param dry_run: If True, the action is logged but no file is actually
                        written.
        :return: The path of the file written to.
        """
        shared_path = os.path.join(self.path, 'SHARED')
        logger.info('creating %s', shared_path)
        if dry_run:
            return None
        lines = []
        for key in ('prefix', 'lib', 'headers', 'scripts', 'data'):
            path = paths[key]
            if os.path.isdir(paths[key]):
                lines.append('%s=%s' % (key, path))
        for ns in paths.get('namespace', ()):
            lines.append('namespace=%s' % ns)

        with codecs.open(shared_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        return shared_path

    def get_distinfo_resource(self, path):
        if path not in DIST_FILES:
            raise DistlibException('invalid path for a dist-info file: '
                                   '%r at %r' % (path, self.path))
        finder = resources.finder_for_path(self.path)
        if finder is None:
            raise DistlibException('Unable to get a finder for %s' % self.path)
        return finder.find(path)

    def get_distinfo_file(self, path):
        """
        Returns a path located under the ``.dist-info`` directory. Returns a
        string representing the path.

        :parameter path: a ``'/'``-separated path relative to the
                         ``.dist-info`` directory or an absolute path;
                         If *path* is an absolute path and doesn't start
                         with the ``.dist-info`` directory path,
                         a :class:`DistlibException` is raised
        :type path: str
        :rtype: str
        """
        # Check if it is an absolute path  # XXX use relpath, add tests
        if path.find(os.sep) >= 0:
            # it's an absolute path?
            distinfo_dirname, path = path.split(os.sep)[-2:]
            if distinfo_dirname != self.path.split(os.sep)[-1]:
                raise DistlibException(
                    'dist-info file %r does not belong to the %r %s '
                    'distribution' % (path, self.name, self.version))

        # The file must be relative
        if path not in DIST_FILES:
            raise DistlibException('invalid path for a dist-info file: '
                                   '%r at %r' % (path, self.path))

        return os.path.join(self.path, path)

    def list_distinfo_files(self):
        """
        Iterates over the ``RECORD`` entries and returns paths for each line if
        the path is pointing to a file located in the ``.dist-info`` directory
        or one of its subdirectories.

        :returns: iterator of paths
        """
        base = os.path.dirname(self.path)
        for path, checksum, size in self._get_records():
            # XXX add separator or use real relpath algo
            if not os.path.isabs(path):
                path = os.path.join(base, path)
            if path.startswith(self.path):
                yield path

    def __eq__(self, other):
        return (isinstance(other, InstalledDistribution)
                and self.path == other.path)

    # See http://docs.python.org/reference/datamodel#object.__hash__
    __hash__ = object.__hash__


class EggInfoDistribution(BaseInstalledDistribution):
    """Created with the *path* of the ``.egg-info`` directory or file provided
    to the constructor. It reads the metadata contained in the file itself, or
    if the given path happens to be a directory, the metadata is read from the
    file ``PKG-INFO`` under that directory."""

    requested = True  # as we have no way of knowing, assume it was
    shared_locations = {}

    def __init__(self, path, env=None):

        def set_name_and_version(s, n, v):
            s.name = n
            s.key = n.lower()  # for case-insensitive comparisons
            s.version = v

        self.path = path
        self.dist_path = env
        if env and env._cache_enabled and path in env._cache_egg.path:
            metadata = env._cache_egg.path[path].metadata
            set_name_and_version(self, metadata.name, metadata.version)
        else:
            metadata = self._get_metadata(path)

            # Need to be set before caching
            set_name_and_version(self, metadata.name, metadata.version)

            if env and env._cache_enabled:
                env._cache_egg.add(self)
        super(EggInfoDistribution, self).__init__(metadata, path, env)

    def _get_metadata(self, path):
        requires = None

        def parse_requires_data(data):
            """Create a list of dependencies from a requires.txt file.

            *data*: the contents of a setuptools-produced requires.txt file.
            """
            reqs = []
            lines = data.splitlines()
            for line in lines:
                line = line.strip()
                # sectioned files have bare newlines (separating sections)
                if not line:  # pragma: no cover
                    continue
                if line.startswith('['):  # pragma: no cover
                    logger.warning(
                        'Unexpected line: quitting requirement scan: %r', line)
                    break
                r = parse_requirement(line)
                if not r:  # pragma: no cover
                    logger.warning('Not recognised as a requirement: %r', line)
                    continue
                if r.extras:  # pragma: no cover
                    logger.warning('extra requirements in requires.txt are '
                                   'not supported')
                if not r.constraints:
                    reqs.append(r.name)
                else:
                    cons = ', '.join('%s%s' % c for c in r.constraints)
                    reqs.append('%s (%s)' % (r.name, cons))
            return reqs

        def parse_requires_path(req_path):
            """Create a list of dependencies from a requires.txt file.

            *req_path*: the path to a setuptools-produced requires.txt file.
            """

            reqs = []
            try:
                with codecs.open(req_path, 'r', 'utf-8') as fp:
                    reqs = parse_requires_data(fp.read())
            except IOError:
                pass
            return reqs

        tl_path = tl_data = None
        if path.endswith('.egg'):
            if os.path.isdir(path):
                p = os.path.join(path, 'EGG-INFO')
                meta_path = os.path.join(p, 'PKG-INFO')
                metadata = Metadata(path=meta_path, scheme='legacy')
                req_path = os.path.join(p, 'requires.txt')
                tl_path = os.path.join(p, 'top_level.txt')
                requires = parse_requires_path(req_path)
            else:
                # FIXME handle the case where zipfile is not available
                zipf = zipimport.zipimporter(path)
                fileobj = StringIO(
                    zipf.get_data('EGG-INFO/PKG-INFO').decode('utf8'))
                metadata = Metadata(fileobj=fileobj, scheme='legacy')
                try:
                    data = zipf.get_data('EGG-INFO/requires.txt')
                    tl_data = zipf.get_data('EGG-INFO/top_level.txt').decode(
                        'utf-8')
                    requires = parse_requires_data(data.decode('utf-8'))
                except IOError:
                    requires = None
        elif path.endswith('.egg-info'):
            if os.path.isdir(path):
                req_path = os.path.join(path, 'requires.txt')
                requires = parse_requires_path(req_path)
                path = os.path.join(path, 'PKG-INFO')
                tl_path = os.path.join(path, 'top_level.txt')
            metadata = Metadata(path=path, scheme='legacy')
        else:
            raise DistlibException('path must end with .egg-info or .egg, '
                                   'got %r' % path)

        if requires:
            metadata.add_requirements(requires)
        # look for top-level modules in top_level.txt, if present
        if tl_data is None:
            if tl_path is not None and os.path.exists(tl_path):
                with open(tl_path, 'rb') as f:
                    tl_data = f.read().decode('utf-8')
        if not tl_data:
            tl_data = []
        else:
            tl_data = tl_data.splitlines()
        self.modules = tl_data
        return metadata

    def __repr__(self):
        return '<EggInfoDistribution %r %s at %r>' % (self.name, self.version,
                                                      self.path)

    def __str__(self):
        return "%s %s" % (self.name, self.version)

    def check_installed_files(self):
        """
        Checks that the hashes and sizes of the files in ``RECORD`` are
        matched by the files themselves. Returns a (possibly empty) list of
        mismatches. Each entry in the mismatch list will be a tuple consisting
        of the path, 'exists', 'size' or 'hash' according to what didn't match
        (existence is checked first, then size, then hash), the expected
        value and the actual value.
        """
        mismatches = []
        record_path = os.path.join(self.path, 'installed-files.txt')
        if os.path.exists(record_path):
            for path, _, _ in self.list_installed_files():
                if path == record_path:
                    continue
                if not os.path.exists(path):
                    mismatches.append((path, 'exists', True, False))
        return mismatches

    def list_installed_files(self):
        """
        Iterates over the ``installed-files.txt`` entries and returns a tuple
        ``(path, hash, size)`` for each line.

        :returns: a list of (path, hash, size)
        """

        def _md5(path):
            f = open(path, 'rb')
            try:
                content = f.read()
            finally:
                f.close()
            return hashlib.md5(content).hexdigest()

        def _size(path):
            return os.stat(path).st_size

        record_path = os.path.join(self.path, 'installed-files.txt')
        result = []
        if os.path.exists(record_path):
            with codecs.open(record_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    p = os.path.normpath(os.path.join(self.path, line))
                    # "./" is present as a marker between installed files
                    # and installation metadata files
                    if not os.path.exists(p):
                        logger.warning('Non-existent file: %s', p)
                        if p.endswith(('.pyc', '.pyo')):
                            continue
                        # otherwise fall through and fail
                    if not os.path.isdir(p):
                        result.append((p, _md5(p), _size(p)))
            result.append((record_path, None, None))
        return result

    def list_distinfo_files(self, absolute=False):
        """
        Iterates over the ``installed-files.txt`` entries and returns paths for
        each line if the path is pointing to a file located in the
        ``.egg-info`` directory or one of its subdirectories.

        :parameter absolute: If *absolute* is ``True``, each returned path is
                          transformed into a local absolute path. Otherwise the
                          raw value from ``installed-files.txt`` is returned.
        :type absolute: boolean
        :returns: iterator of paths
        """
        record_path = os.path.join(self.path, 'installed-files.txt')
        if os.path.exists(record_path):
            skip = True
            with codecs.open(record_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line == './':
                        skip = False
                        continue
                    if not skip:
                        p = os.path.normpath(os.path.join(self.path, line))
                        if p.startswith(self.path):
                            if absolute:
                                yield p
                            else:
                                yield line

    def __eq__(self, other):
        return (isinstance(other, EggInfoDistribution)
                and self.path == other.path)

    # See http://docs.python.org/reference/datamodel#object.__hash__
    __hash__ = object.__hash__


new_dist_class = InstalledDistribution
old_dist_class = EggInfoDistribution


class DependencyGraph(object):
    """
    Represents a dependency graph between distributions.

    The dependency relationships are stored in an ``adjacency_list`` that maps
    distributions to a list of ``(other, label)`` tuples where  ``other``
    is a distribution and the edge is labeled with ``label`` (i.e. the version
    specifier, if such was provided). Also, for more efficient traversal, for
    every distribution ``x``, a list of predecessors is kept in
    ``reverse_list[x]``. An edge from distribution ``a`` to
    distribution ``b`` means that ``a`` depends on ``b``. If any missing
    dependencies are found, they are stored in ``missing``, which is a
    dictionary that maps distributions to a list of requirements that were not
    provided by any other distributions.
    """

    def __init__(self):
        self.adjacency_list = {}
        self.reverse_list = {}
        self.missing = {}

    def add_distribution(self, distribution):
        """Add the *distribution* to the graph.

        :type distribution: :class:`distutils2.database.InstalledDistribution`
                            or :class:`distutils2.database.EggInfoDistribution`
        """
        self.adjacency_list[distribution] = []
        self.reverse_list[distribution] = []
        # self.missing[distribution] = []

    def add_edge(self, x, y, label=None):
        """Add an edge from distribution *x* to distribution *y* with the given
        *label*.

        :type x: :class:`distutils2.database.InstalledDistribution` or
                 :class:`distutils2.database.EggInfoDistribution`
        :type y: :class:`distutils2.database.InstalledDistribution` or
                 :class:`distutils2.database.EggInfoDistribution`
        :type label: ``str`` or ``None``
        """
        self.adjacency_list[x].append((y, label))
        # multiple edges are allowed, so be careful
        if x not in self.reverse_list[y]:
            self.reverse_list[y].append(x)

    def add_missing(self, distribution, requirement):
        """
        Add a missing *requirement* for the given *distribution*.

        :type distribution: :class:`distutils2.database.InstalledDistribution`
                            or :class:`distutils2.database.EggInfoDistribution`
        :type requirement: ``str``
        """
        logger.debug('%s missing %r', distribution, requirement)
        self.missing.setdefault(distribution, []).append(requirement)

    def _repr_dist(self, dist):
        return '%s %s' % (dist.name, dist.version)

    def repr_node(self, dist, level=1):
        """Prints only a subgraph"""
        output = [self._repr_dist(dist)]
        for other, label in self.adjacency_list[dist]:
            dist = self._repr_dist(other)
            if label is not None:
                dist = '%s [%s]' % (dist, label)
            output.append('    ' * level + str(dist))
            suboutput = self.repr_node(other, level + 1)
            subs = suboutput.split('\n')
            output.extend(subs[1:])
        return '\n'.join(output)

    def to_dot(self, f, skip_disconnected=True):
        """Writes a DOT output for the graph to the provided file *f*.

        If *skip_disconnected* is set to ``True``, then all distributions
        that are not dependent on any other distribution are skipped.

        :type f: has to support ``file``-like operations
        :type skip_disconnected: ``bool``
        """
        disconnected = []

        f.write("digraph dependencies {\n")
        for dist, adjs in self.adjacency_list.items():
            if len(adjs) == 0 and not skip_disconnected:
                disconnected.append(dist)
            for other, label in adjs:
                if label is not None:
                    f.write('"%s" -> "%s" [label="%s"]\n' %
                            (dist.name, other.name, label))
                else:
                    f.write('"%s" -> "%s"\n' % (dist.name, other.name))
        if not skip_disconnected and len(disconnected) > 0:
            f.write('subgraph disconnected {\n')
            f.write('label = "Disconnected"\n')
            f.write('bgcolor = red\n')

            for dist in disconnected:
                f.write('"%s"' % dist.name)
                f.write('\n')
            f.write('}\n')
        f.write('}\n')

    def topological_sort(self):
        """
        Perform a topological sort of the graph.
        :return: A tuple, the first element of which is a topologically sorted
                 list of distributions, and the second element of which is a
                 list of distributions that cannot be sorted because they have
                 circular dependencies and so form a cycle.
        """
        result = []
        # Make a shallow copy of the adjacency list
        alist = {}
        for k, v in self.adjacency_list.items():
            alist[k] = v[:]
        while True:
            # See what we can remove in this run
            to_remove = []
            for k, v in list(alist.items())[:]:
                if not v:
                    to_remove.append(k)
                    del alist[k]
            if not to_remove:
                # What's left in alist (if anything) is a cycle.
                break
            # Remove from the adjacency list of others
            for k, v in alist.items():
                alist[k] = [(d, r) for d, r in v if d not in to_remove]
            logger.debug('Moving to result: %s',
                         ['%s (%s)' % (d.name, d.version) for d in to_remove])
            result.extend(to_remove)
        return result, list(alist.keys())

    def __repr__(self):
        """Representation of the graph"""
        output = []
        for dist, adjs in self.adjacency_list.items():
            output.append(self.repr_node(dist))
        return '\n'.join(output)


def make_graph(dists, scheme='default'):
    """Makes a dependency graph from the given distributions.

    :parameter dists: a list of distributions
    :type dists: list of :class:`distutils2.database.InstalledDistribution` and
                 :class:`distutils2.database.EggInfoDistribution` instances
    :rtype: a :class:`DependencyGraph` instance
    """
    scheme = get_scheme(scheme)
    graph = DependencyGraph()
    provided = {}  # maps names to lists of (version, dist) tuples

    # first, build the graph and find out what's provided
    for dist in dists:
        graph.add_distribution(dist)

        for p in dist.provides:
            name, version = parse_name_and_version(p)
            logger.debug('Add to provided: %s, %s, %s', name, version, dist)
            provided.setdefault(name, []).append((version, dist))

    # now make the edges
    for dist in dists:
        requires = (dist.run_requires | dist.meta_requires
                    | dist.build_requires | dist.dev_requires)
        for req in requires:
            try:
                matcher = scheme.matcher(req)
            except UnsupportedVersionError:
                # XXX compat-mode if cannot read the version
                logger.warning('could not read version %r - using name only',
                               req)
                name = req.split()[0]
                matcher = scheme.matcher(name)

            name = matcher.key  # case-insensitive

            matched = False
            if name in provided:
                for version, provider in provided[name]:
                    try:
                        match = matcher.match(version)
                    except UnsupportedVersionError:
                        match = False

                    if match:
                        graph.add_edge(dist, provider, req)
                        matched = True
                        break
            if not matched:
                graph.add_missing(dist, req)
    return graph


def get_dependent_dists(dists, dist):
    """Recursively generate a list of distributions from *dists* that are
    dependent on *dist*.

    :param dists: a list of distributions
    :param dist: a distribution, member of *dists* for which we are interested
    """
    if dist not in dists:
        raise DistlibException('given distribution %r is not a member '
                               'of the list' % dist.name)
    graph = make_graph(dists)

    dep = [dist]  # dependent distributions
    todo = graph.reverse_list[dist]  # list of nodes we should inspect

    while todo:
        d = todo.pop()
        dep.append(d)
        for succ in graph.reverse_list[d]:
            if succ not in dep:
                todo.append(succ)

    dep.pop(0)  # remove dist from dep, was there to prevent infinite loops
    return dep


def get_required_dists(dists, dist):
    """Recursively generate a list of distributions from *dists* that are
    required by *dist*.

    :param dists: a list of distributions
    :param dist: a distribution, member of *dists* for which we are interested
                 in finding the dependencies.
    """
    if dist not in dists:
        raise DistlibException('given distribution %r is not a member '
                               'of the list' % dist.name)
    graph = make_graph(dists)

    req = set()  # required distributions
    todo = graph.adjacency_list[dist]  # list of nodes we should inspect
    seen = set(t[0] for t in todo)  # already added to todo

    while todo:
        d = todo.pop()[0]
        req.add(d)
        pred_list = graph.adjacency_list[d]
        for pred in pred_list:
            d = pred[0]
            if d not in req and d not in seen:
                seen.add(d)
                todo.append(pred)
    return req


def make_dist(name, version, **kwargs):
    """
    A convenience method for making a dist given just a name and version.
    """
    summary = kwargs.pop('summary', 'Placeholder for summary')
    md = Metadata(**kwargs)
    md.name = name
    md.version = version
    md.summary = summary or 'Placeholder for summary'
    return Distribution(md)

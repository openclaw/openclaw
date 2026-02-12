# -*- coding: utf-8 -*-
#
# Copyright (C) 2013-2023 Vinay Sajip.
# Licensed to the Python Software Foundation under a contributor agreement.
# See LICENSE.txt and CONTRIBUTORS.txt.
#
from __future__ import unicode_literals

import base64
import codecs
import datetime
from email import message_from_file
import hashlib
import json
import logging
import os
import posixpath
import re
import shutil
import sys
import tempfile
import zipfile

from . import __version__, DistlibException
from .compat import sysconfig, ZipFile, fsdecode, text_type, filter
from .database import InstalledDistribution
from .metadata import Metadata, WHEEL_METADATA_FILENAME, LEGACY_METADATA_FILENAME
from .util import (FileOperator, convert_path, CSVReader, CSVWriter, Cache,
                   cached_property, get_cache_base, read_exports, tempdir,
                   get_platform)
from .version import NormalizedVersion, UnsupportedVersionError

logger = logging.getLogger(__name__)

cache = None  # created when needed

if hasattr(sys, 'pypy_version_info'):  # pragma: no cover
    IMP_PREFIX = 'pp'
elif sys.platform.startswith('java'):  # pragma: no cover
    IMP_PREFIX = 'jy'
elif sys.platform == 'cli':  # pragma: no cover
    IMP_PREFIX = 'ip'
else:
    IMP_PREFIX = 'cp'

VER_SUFFIX = sysconfig.get_config_var('py_version_nodot')
if not VER_SUFFIX:  # pragma: no cover
    VER_SUFFIX = '%s%s' % sys.version_info[:2]
PYVER = 'py' + VER_SUFFIX
IMPVER = IMP_PREFIX + VER_SUFFIX

ARCH = get_platform().replace('-', '_').replace('.', '_')

ABI = sysconfig.get_config_var('SOABI')
if ABI and ABI.startswith('cpython-'):
    ABI = ABI.replace('cpython-', 'cp').split('-')[0]
else:

    def _derive_abi():
        parts = ['cp', VER_SUFFIX]
        if sysconfig.get_config_var('Py_DEBUG'):
            parts.append('d')
        if IMP_PREFIX == 'cp':
            vi = sys.version_info[:2]
            if vi < (3, 8):
                wpm = sysconfig.get_config_var('WITH_PYMALLOC')
                if wpm is None:
                    wpm = True
                if wpm:
                    parts.append('m')
                if vi < (3, 3):
                    us = sysconfig.get_config_var('Py_UNICODE_SIZE')
                    if us == 4 or (us is None and sys.maxunicode == 0x10FFFF):
                        parts.append('u')
        return ''.join(parts)

    ABI = _derive_abi()
    del _derive_abi

FILENAME_RE = re.compile(
    r'''
(?P<nm>[^-]+)
-(?P<vn>\d+[^-]*)
(-(?P<bn>\d+[^-]*))?
-(?P<py>\w+\d+(\.\w+\d+)*)
-(?P<bi>\w+)
-(?P<ar>\w+(\.\w+)*)
\.whl$
''', re.IGNORECASE | re.VERBOSE)

NAME_VERSION_RE = re.compile(
    r'''
(?P<nm>[^-]+)
-(?P<vn>\d+[^-]*)
(-(?P<bn>\d+[^-]*))?$
''', re.IGNORECASE | re.VERBOSE)

SHEBANG_RE = re.compile(br'\s*#![^\r\n]*')
SHEBANG_DETAIL_RE = re.compile(br'^(\s*#!("[^"]+"|\S+))\s+(.*)$')
SHEBANG_PYTHON = b'#!python'
SHEBANG_PYTHONW = b'#!pythonw'

if os.sep == '/':
    to_posix = lambda o: o
else:
    to_posix = lambda o: o.replace(os.sep, '/')

if sys.version_info[0] < 3:
    import imp
else:
    imp = None
    import importlib.machinery
    import importlib.util


def _get_suffixes():
    if imp:
        return [s[0] for s in imp.get_suffixes()]
    else:
        return importlib.machinery.EXTENSION_SUFFIXES


def _load_dynamic(name, path):
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    if imp:
        return imp.load_dynamic(name, path)
    else:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module


class Mounter(object):

    def __init__(self):
        self.impure_wheels = {}
        self.libs = {}

    def add(self, pathname, extensions):
        self.impure_wheels[pathname] = extensions
        self.libs.update(extensions)

    def remove(self, pathname):
        extensions = self.impure_wheels.pop(pathname)
        for k, v in extensions:
            if k in self.libs:
                del self.libs[k]

    def find_module(self, fullname, path=None):
        if fullname in self.libs:
            result = self
        else:
            result = None
        return result

    def load_module(self, fullname):
        if fullname in sys.modules:
            result = sys.modules[fullname]
        else:
            if fullname not in self.libs:
                raise ImportError('unable to find extension for %s' % fullname)
            result = _load_dynamic(fullname, self.libs[fullname])
            result.__loader__ = self
            parts = fullname.rsplit('.', 1)
            if len(parts) > 1:
                result.__package__ = parts[0]
        return result


_hook = Mounter()


class Wheel(object):
    """
    Class to build and install from Wheel files (PEP 427).
    """

    wheel_version = (1, 1)
    hash_kind = 'sha256'

    def __init__(self, filename=None, sign=False, verify=False):
        """
        Initialise an instance using a (valid) filename.
        """
        self.sign = sign
        self.should_verify = verify
        self.buildver = ''
        self.pyver = [PYVER]
        self.abi = ['none']
        self.arch = ['any']
        self.dirname = os.getcwd()
        if filename is None:
            self.name = 'dummy'
            self.version = '0.1'
            self._filename = self.filename
        else:
            m = NAME_VERSION_RE.match(filename)
            if m:
                info = m.groupdict('')
                self.name = info['nm']
                # Reinstate the local version separator
                self.version = info['vn'].replace('_', '-')
                self.buildver = info['bn']
                self._filename = self.filename
            else:
                dirname, filename = os.path.split(filename)
                m = FILENAME_RE.match(filename)
                if not m:
                    raise DistlibException('Invalid name or '
                                           'filename: %r' % filename)
                if dirname:
                    self.dirname = os.path.abspath(dirname)
                self._filename = filename
                info = m.groupdict('')
                self.name = info['nm']
                self.version = info['vn']
                self.buildver = info['bn']
                self.pyver = info['py'].split('.')
                self.abi = info['bi'].split('.')
                self.arch = info['ar'].split('.')

    @property
    def filename(self):
        """
        Build and return a filename from the various components.
        """
        if self.buildver:
            buildver = '-' + self.buildver
        else:
            buildver = ''
        pyver = '.'.join(self.pyver)
        abi = '.'.join(self.abi)
        arch = '.'.join(self.arch)
        # replace - with _ as a local version separator
        version = self.version.replace('-', '_')
        return '%s-%s%s-%s-%s-%s.whl' % (self.name, version, buildver, pyver,
                                         abi, arch)

    @property
    def exists(self):
        path = os.path.join(self.dirname, self.filename)
        return os.path.isfile(path)

    @property
    def tags(self):
        for pyver in self.pyver:
            for abi in self.abi:
                for arch in self.arch:
                    yield pyver, abi, arch

    @cached_property
    def metadata(self):
        pathname = os.path.join(self.dirname, self.filename)
        name_ver = '%s-%s' % (self.name, self.version)
        info_dir = '%s.dist-info' % name_ver
        wrapper = codecs.getreader('utf-8')
        with ZipFile(pathname, 'r') as zf:
            self.get_wheel_metadata(zf)
            # wv = wheel_metadata['Wheel-Version'].split('.', 1)
            # file_version = tuple([int(i) for i in wv])
            # if file_version < (1, 1):
            # fns = [WHEEL_METADATA_FILENAME, METADATA_FILENAME,
            # LEGACY_METADATA_FILENAME]
            # else:
            # fns = [WHEEL_METADATA_FILENAME, METADATA_FILENAME]
            fns = [WHEEL_METADATA_FILENAME, LEGACY_METADATA_FILENAME]
            result = None
            for fn in fns:
                try:
                    metadata_filename = posixpath.join(info_dir, fn)
                    with zf.open(metadata_filename) as bf:
                        wf = wrapper(bf)
                        result = Metadata(fileobj=wf)
                        if result:
                            break
                except KeyError:
                    pass
            if not result:
                raise ValueError('Invalid wheel, because metadata is '
                                 'missing: looked in %s' % ', '.join(fns))
        return result

    def get_wheel_metadata(self, zf):
        name_ver = '%s-%s' % (self.name, self.version)
        info_dir = '%s.dist-info' % name_ver
        metadata_filename = posixpath.join(info_dir, 'WHEEL')
        with zf.open(metadata_filename) as bf:
            wf = codecs.getreader('utf-8')(bf)
            message = message_from_file(wf)
        return dict(message)

    @cached_property
    def info(self):
        pathname = os.path.join(self.dirname, self.filename)
        with ZipFile(pathname, 'r') as zf:
            result = self.get_wheel_metadata(zf)
        return result

    def process_shebang(self, data):
        m = SHEBANG_RE.match(data)
        if m:
            end = m.end()
            shebang, data_after_shebang = data[:end], data[end:]
            # Preserve any arguments after the interpreter
            if b'pythonw' in shebang.lower():
                shebang_python = SHEBANG_PYTHONW
            else:
                shebang_python = SHEBANG_PYTHON
            m = SHEBANG_DETAIL_RE.match(shebang)
            if m:
                args = b' ' + m.groups()[-1]
            else:
                args = b''
            shebang = shebang_python + args
            data = shebang + data_after_shebang
        else:
            cr = data.find(b'\r')
            lf = data.find(b'\n')
            if cr < 0 or cr > lf:
                term = b'\n'
            else:
                if data[cr:cr + 2] == b'\r\n':
                    term = b'\r\n'
                else:
                    term = b'\r'
            data = SHEBANG_PYTHON + term + data
        return data

    def get_hash(self, data, hash_kind=None):
        if hash_kind is None:
            hash_kind = self.hash_kind
        try:
            hasher = getattr(hashlib, hash_kind)
        except AttributeError:
            raise DistlibException('Unsupported hash algorithm: %r' %
                                   hash_kind)
        result = hasher(data).digest()
        result = base64.urlsafe_b64encode(result).rstrip(b'=').decode('ascii')
        return hash_kind, result

    def write_record(self, records, record_path, archive_record_path):
        records = list(records)  # make a copy, as mutated
        records.append((archive_record_path, '', ''))
        with CSVWriter(record_path) as writer:
            for row in records:
                writer.writerow(row)

    def write_records(self, info, libdir, archive_paths):
        records = []
        distinfo, info_dir = info
        # hasher = getattr(hashlib, self.hash_kind)
        for ap, p in archive_paths:
            with open(p, 'rb') as f:
                data = f.read()
            digest = '%s=%s' % self.get_hash(data)
            size = os.path.getsize(p)
            records.append((ap, digest, size))

        p = os.path.join(distinfo, 'RECORD')
        ap = to_posix(os.path.join(info_dir, 'RECORD'))
        self.write_record(records, p, ap)
        archive_paths.append((ap, p))

    def build_zip(self, pathname, archive_paths):
        with ZipFile(pathname, 'w', zipfile.ZIP_DEFLATED) as zf:
            for ap, p in archive_paths:
                logger.debug('Wrote %s to %s in wheel', p, ap)
                zf.write(p, ap)

    def build(self, paths, tags=None, wheel_version=None):
        """
        Build a wheel from files in specified paths, and use any specified tags
        when determining the name of the wheel.
        """
        if tags is None:
            tags = {}

        libkey = list(filter(lambda o: o in paths, ('purelib', 'platlib')))[0]
        if libkey == 'platlib':
            is_pure = 'false'
            default_pyver = [IMPVER]
            default_abi = [ABI]
            default_arch = [ARCH]
        else:
            is_pure = 'true'
            default_pyver = [PYVER]
            default_abi = ['none']
            default_arch = ['any']

        self.pyver = tags.get('pyver', default_pyver)
        self.abi = tags.get('abi', default_abi)
        self.arch = tags.get('arch', default_arch)

        libdir = paths[libkey]

        name_ver = '%s-%s' % (self.name, self.version)
        data_dir = '%s.data' % name_ver
        info_dir = '%s.dist-info' % name_ver

        archive_paths = []

        # First, stuff which is not in site-packages
        for key in ('data', 'headers', 'scripts'):
            if key not in paths:
                continue
            path = paths[key]
            if os.path.isdir(path):
                for root, dirs, files in os.walk(path):
                    for fn in files:
                        p = fsdecode(os.path.join(root, fn))
                        rp = os.path.relpath(p, path)
                        ap = to_posix(os.path.join(data_dir, key, rp))
                        archive_paths.append((ap, p))
                        if key == 'scripts' and not p.endswith('.exe'):
                            with open(p, 'rb') as f:
                                data = f.read()
                            data = self.process_shebang(data)
                            with open(p, 'wb') as f:
                                f.write(data)

        # Now, stuff which is in site-packages, other than the
        # distinfo stuff.
        path = libdir
        distinfo = None
        for root, dirs, files in os.walk(path):
            if root == path:
                # At the top level only, save distinfo for later
                # and skip it for now
                for i, dn in enumerate(dirs):
                    dn = fsdecode(dn)
                    if dn.endswith('.dist-info'):
                        distinfo = os.path.join(root, dn)
                        del dirs[i]
                        break
                assert distinfo, '.dist-info directory expected, not found'

            for fn in files:
                # comment out next suite to leave .pyc files in
                if fsdecode(fn).endswith(('.pyc', '.pyo')):
                    continue
                p = os.path.join(root, fn)
                rp = to_posix(os.path.relpath(p, path))
                archive_paths.append((rp, p))

        # Now distinfo. Assumed to be flat, i.e. os.listdir is enough.
        files = os.listdir(distinfo)
        for fn in files:
            if fn not in ('RECORD', 'INSTALLER', 'SHARED', 'WHEEL'):
                p = fsdecode(os.path.join(distinfo, fn))
                ap = to_posix(os.path.join(info_dir, fn))
                archive_paths.append((ap, p))

        wheel_metadata = [
            'Wheel-Version: %d.%d' % (wheel_version or self.wheel_version),
            'Generator: distlib %s' % __version__,
            'Root-Is-Purelib: %s' % is_pure,
        ]
        for pyver, abi, arch in self.tags:
            wheel_metadata.append('Tag: %s-%s-%s' % (pyver, abi, arch))
        p = os.path.join(distinfo, 'WHEEL')
        with open(p, 'w') as f:
            f.write('\n'.join(wheel_metadata))
        ap = to_posix(os.path.join(info_dir, 'WHEEL'))
        archive_paths.append((ap, p))

        # sort the entries by archive path. Not needed by any spec, but it
        # keeps the archive listing and RECORD tidier than they would otherwise
        # be. Use the number of path segments to keep directory entries together,
        # and keep the dist-info stuff at the end.
        def sorter(t):
            ap = t[0]
            n = ap.count('/')
            if '.dist-info' in ap:
                n += 10000
            return (n, ap)

        archive_paths = sorted(archive_paths, key=sorter)

        # Now, at last, RECORD.
        # Paths in here are archive paths - nothing else makes sense.
        self.write_records((distinfo, info_dir), libdir, archive_paths)
        # Now, ready to build the zip file
        pathname = os.path.join(self.dirname, self.filename)
        self.build_zip(pathname, archive_paths)
        return pathname

    def skip_entry(self, arcname):
        """
        Determine whether an archive entry should be skipped when verifying
        or installing.
        """
        # The signature file won't be in RECORD,
        # and we  don't currently don't do anything with it
        # We also skip directories, as they won't be in RECORD
        # either. See:
        #
        # https://github.com/pypa/wheel/issues/294
        # https://github.com/pypa/wheel/issues/287
        # https://github.com/pypa/wheel/pull/289
        #
        return arcname.endswith(('/', '/RECORD.jws'))

    def install(self, paths, maker, **kwargs):
        """
        Install a wheel to the specified paths. If kwarg ``warner`` is
        specified, it should be a callable, which will be called with two
        tuples indicating the wheel version of this software and the wheel
        version in the file, if there is a discrepancy in the versions.
        This can be used to issue any warnings to raise any exceptions.
        If kwarg ``lib_only`` is True, only the purelib/platlib files are
        installed, and the headers, scripts, data and dist-info metadata are
        not written. If kwarg ``bytecode_hashed_invalidation`` is True, written
        bytecode will try to use file-hash based invalidation (PEP-552) on
        supported interpreter versions (CPython 2.7+).

        The return value is a :class:`InstalledDistribution` instance unless
        ``options.lib_only`` is True, in which case the return value is ``None``.
        """

        dry_run = maker.dry_run
        warner = kwargs.get('warner')
        lib_only = kwargs.get('lib_only', False)
        bc_hashed_invalidation = kwargs.get('bytecode_hashed_invalidation',
                                            False)

        pathname = os.path.join(self.dirname, self.filename)
        name_ver = '%s-%s' % (self.name, self.version)
        data_dir = '%s.data' % name_ver
        info_dir = '%s.dist-info' % name_ver

        metadata_name = posixpath.join(info_dir, LEGACY_METADATA_FILENAME)
        wheel_metadata_name = posixpath.join(info_dir, 'WHEEL')
        record_name = posixpath.join(info_dir, 'RECORD')

        wrapper = codecs.getreader('utf-8')

        with ZipFile(pathname, 'r') as zf:
            with zf.open(wheel_metadata_name) as bwf:
                wf = wrapper(bwf)
                message = message_from_file(wf)
            wv = message['Wheel-Version'].split('.', 1)
            file_version = tuple([int(i) for i in wv])
            if (file_version != self.wheel_version) and warner:
                warner(self.wheel_version, file_version)

            if message['Root-Is-Purelib'] == 'true':
                libdir = paths['purelib']
            else:
                libdir = paths['platlib']

            records = {}
            with zf.open(record_name) as bf:
                with CSVReader(stream=bf) as reader:
                    for row in reader:
                        p = row[0]
                        records[p] = row

            data_pfx = posixpath.join(data_dir, '')
            info_pfx = posixpath.join(info_dir, '')
            script_pfx = posixpath.join(data_dir, 'scripts', '')

            # make a new instance rather than a copy of maker's,
            # as we mutate it
            fileop = FileOperator(dry_run=dry_run)
            fileop.record = True  # so we can rollback if needed

            bc = not sys.dont_write_bytecode  # Double negatives. Lovely!

            outfiles = []  # for RECORD writing

            # for script copying/shebang processing
            workdir = tempfile.mkdtemp()
            # set target dir later
            # we default add_launchers to False, as the
            # Python Launcher should be used instead
            maker.source_dir = workdir
            maker.target_dir = None
            try:
                for zinfo in zf.infolist():
                    arcname = zinfo.filename
                    if isinstance(arcname, text_type):
                        u_arcname = arcname
                    else:
                        u_arcname = arcname.decode('utf-8')
                    if self.skip_entry(u_arcname):
                        continue
                    row = records[u_arcname]
                    if row[2] and str(zinfo.file_size) != row[2]:
                        raise DistlibException('size mismatch for '
                                               '%s' % u_arcname)
                    if row[1]:
                        kind, value = row[1].split('=', 1)
                        with zf.open(arcname) as bf:
                            data = bf.read()
                        _, digest = self.get_hash(data, kind)
                        if digest != value:
                            raise DistlibException('digest mismatch for '
                                                   '%s' % arcname)

                    if lib_only and u_arcname.startswith((info_pfx, data_pfx)):
                        logger.debug('lib_only: skipping %s', u_arcname)
                        continue
                    is_script = (u_arcname.startswith(script_pfx)
                                 and not u_arcname.endswith('.exe'))

                    if u_arcname.startswith(data_pfx):
                        _, where, rp = u_arcname.split('/', 2)
                        outfile = os.path.join(paths[where], convert_path(rp))
                    else:
                        # meant for site-packages.
                        if u_arcname in (wheel_metadata_name, record_name):
                            continue
                        outfile = os.path.join(libdir, convert_path(u_arcname))
                    if not is_script:
                        with zf.open(arcname) as bf:
                            fileop.copy_stream(bf, outfile)
                        # Issue #147: permission bits aren't preserved. Using
                        # zf.extract(zinfo, libdir) should have worked, but didn't,
                        # see https://www.thetopsites.net/article/53834422.shtml
                        # So ... manually preserve permission bits as given in zinfo
                        if os.name == 'posix':
                            # just set the normal permission bits
                            os.chmod(outfile,
                                     (zinfo.external_attr >> 16) & 0x1FF)
                        outfiles.append(outfile)
                        # Double check the digest of the written file
                        if not dry_run and row[1]:
                            with open(outfile, 'rb') as bf:
                                data = bf.read()
                                _, newdigest = self.get_hash(data, kind)
                                if newdigest != digest:
                                    raise DistlibException('digest mismatch '
                                                           'on write for '
                                                           '%s' % outfile)
                        if bc and outfile.endswith('.py'):
                            try:
                                pyc = fileop.byte_compile(
                                    outfile,
                                    hashed_invalidation=bc_hashed_invalidation)
                                outfiles.append(pyc)
                            except Exception:
                                # Don't give up if byte-compilation fails,
                                # but log it and perhaps warn the user
                                logger.warning('Byte-compilation failed',
                                               exc_info=True)
                    else:
                        fn = os.path.basename(convert_path(arcname))
                        workname = os.path.join(workdir, fn)
                        with zf.open(arcname) as bf:
                            fileop.copy_stream(bf, workname)

                        dn, fn = os.path.split(outfile)
                        maker.target_dir = dn
                        filenames = maker.make(fn)
                        fileop.set_executable_mode(filenames)
                        outfiles.extend(filenames)

                if lib_only:
                    logger.debug('lib_only: returning None')
                    dist = None
                else:
                    # Generate scripts

                    # Try to get pydist.json so we can see if there are
                    # any commands to generate. If this fails (e.g. because
                    # of a legacy wheel), log a warning but don't give up.
                    commands = None
                    file_version = self.info['Wheel-Version']
                    if file_version == '1.0':
                        # Use legacy info
                        ep = posixpath.join(info_dir, 'entry_points.txt')
                        try:
                            with zf.open(ep) as bwf:
                                epdata = read_exports(bwf)
                            commands = {}
                            for key in ('console', 'gui'):
                                k = '%s_scripts' % key
                                if k in epdata:
                                    commands['wrap_%s' % key] = d = {}
                                    for v in epdata[k].values():
                                        s = '%s:%s' % (v.prefix, v.suffix)
                                        if v.flags:
                                            s += ' [%s]' % ','.join(v.flags)
                                        d[v.name] = s
                        except Exception:
                            logger.warning('Unable to read legacy script '
                                           'metadata, so cannot generate '
                                           'scripts')
                    else:
                        try:
                            with zf.open(metadata_name) as bwf:
                                wf = wrapper(bwf)
                                commands = json.load(wf).get('extensions')
                                if commands:
                                    commands = commands.get('python.commands')
                        except Exception:
                            logger.warning('Unable to read JSON metadata, so '
                                           'cannot generate scripts')
                    if commands:
                        console_scripts = commands.get('wrap_console', {})
                        gui_scripts = commands.get('wrap_gui', {})
                        if console_scripts or gui_scripts:
                            script_dir = paths.get('scripts', '')
                            if not os.path.isdir(script_dir):
                                raise ValueError('Valid script path not '
                                                 'specified')
                            maker.target_dir = script_dir
                            for k, v in console_scripts.items():
                                script = '%s = %s' % (k, v)
                                filenames = maker.make(script)
                                fileop.set_executable_mode(filenames)

                            if gui_scripts:
                                options = {'gui': True}
                                for k, v in gui_scripts.items():
                                    script = '%s = %s' % (k, v)
                                    filenames = maker.make(script, options)
                                    fileop.set_executable_mode(filenames)

                    p = os.path.join(libdir, info_dir)
                    dist = InstalledDistribution(p)

                    # Write SHARED
                    paths = dict(paths)  # don't change passed in dict
                    del paths['purelib']
                    del paths['platlib']
                    paths['lib'] = libdir
                    p = dist.write_shared_locations(paths, dry_run)
                    if p:
                        outfiles.append(p)

                    # Write RECORD
                    dist.write_installed_files(outfiles, paths['prefix'],
                                               dry_run)
                return dist
            except Exception:  # pragma: no cover
                logger.exception('installation failed.')
                fileop.rollback()
                raise
            finally:
                shutil.rmtree(workdir)

    def _get_dylib_cache(self):
        global cache
        if cache is None:
            # Use native string to avoid issues on 2.x: see Python #20140.
            base = os.path.join(get_cache_base(), str('dylib-cache'),
                                '%s.%s' % sys.version_info[:2])
            cache = Cache(base)
        return cache

    def _get_extensions(self):
        pathname = os.path.join(self.dirname, self.filename)
        name_ver = '%s-%s' % (self.name, self.version)
        info_dir = '%s.dist-info' % name_ver
        arcname = posixpath.join(info_dir, 'EXTENSIONS')
        wrapper = codecs.getreader('utf-8')
        result = []
        with ZipFile(pathname, 'r') as zf:
            try:
                with zf.open(arcname) as bf:
                    wf = wrapper(bf)
                    extensions = json.load(wf)
                    cache = self._get_dylib_cache()
                    prefix = cache.prefix_to_dir(pathname)
                    cache_base = os.path.join(cache.base, prefix)
                    if not os.path.isdir(cache_base):
                        os.makedirs(cache_base)
                    for name, relpath in extensions.items():
                        dest = os.path.join(cache_base, convert_path(relpath))
                        if not os.path.exists(dest):
                            extract = True
                        else:
                            file_time = os.stat(dest).st_mtime
                            file_time = datetime.datetime.fromtimestamp(
                                file_time)
                            info = zf.getinfo(relpath)
                            wheel_time = datetime.datetime(*info.date_time)
                            extract = wheel_time > file_time
                        if extract:
                            zf.extract(relpath, cache_base)
                        result.append((name, dest))
            except KeyError:
                pass
        return result

    def is_compatible(self):
        """
        Determine if a wheel is compatible with the running system.
        """
        return is_compatible(self)

    def is_mountable(self):
        """
        Determine if a wheel is asserted as mountable by its metadata.
        """
        return True  # for now - metadata details TBD

    def mount(self, append=False):
        pathname = os.path.abspath(os.path.join(self.dirname, self.filename))
        if not self.is_compatible():
            msg = 'Wheel %s not compatible with this Python.' % pathname
            raise DistlibException(msg)
        if not self.is_mountable():
            msg = 'Wheel %s is marked as not mountable.' % pathname
            raise DistlibException(msg)
        if pathname in sys.path:
            logger.debug('%s already in path', pathname)
        else:
            if append:
                sys.path.append(pathname)
            else:
                sys.path.insert(0, pathname)
            extensions = self._get_extensions()
            if extensions:
                if _hook not in sys.meta_path:
                    sys.meta_path.append(_hook)
                _hook.add(pathname, extensions)

    def unmount(self):
        pathname = os.path.abspath(os.path.join(self.dirname, self.filename))
        if pathname not in sys.path:
            logger.debug('%s not in path', pathname)
        else:
            sys.path.remove(pathname)
            if pathname in _hook.impure_wheels:
                _hook.remove(pathname)
            if not _hook.impure_wheels:
                if _hook in sys.meta_path:
                    sys.meta_path.remove(_hook)

    def verify(self):
        pathname = os.path.join(self.dirname, self.filename)
        name_ver = '%s-%s' % (self.name, self.version)
        # data_dir = '%s.data' % name_ver
        info_dir = '%s.dist-info' % name_ver

        # metadata_name = posixpath.join(info_dir, LEGACY_METADATA_FILENAME)
        wheel_metadata_name = posixpath.join(info_dir, 'WHEEL')
        record_name = posixpath.join(info_dir, 'RECORD')

        wrapper = codecs.getreader('utf-8')

        with ZipFile(pathname, 'r') as zf:
            with zf.open(wheel_metadata_name) as bwf:
                wf = wrapper(bwf)
                message_from_file(wf)
            # wv = message['Wheel-Version'].split('.', 1)
            # file_version = tuple([int(i) for i in wv])
            # TODO version verification

            records = {}
            with zf.open(record_name) as bf:
                with CSVReader(stream=bf) as reader:
                    for row in reader:
                        p = row[0]
                        records[p] = row

            for zinfo in zf.infolist():
                arcname = zinfo.filename
                if isinstance(arcname, text_type):
                    u_arcname = arcname
                else:
                    u_arcname = arcname.decode('utf-8')
                # See issue #115: some wheels have .. in their entries, but
                # in the filename ... e.g. __main__..py ! So the check is
                # updated to look for .. in the directory portions
                p = u_arcname.split('/')
                if '..' in p:
                    raise DistlibException('invalid entry in '
                                           'wheel: %r' % u_arcname)

                if self.skip_entry(u_arcname):
                    continue
                row = records[u_arcname]
                if row[2] and str(zinfo.file_size) != row[2]:
                    raise DistlibException('size mismatch for '
                                           '%s' % u_arcname)
                if row[1]:
                    kind, value = row[1].split('=', 1)
                    with zf.open(arcname) as bf:
                        data = bf.read()
                    _, digest = self.get_hash(data, kind)
                    if digest != value:
                        raise DistlibException('digest mismatch for '
                                               '%s' % arcname)

    def update(self, modifier, dest_dir=None, **kwargs):
        """
        Update the contents of a wheel in a generic way. The modifier should
        be a callable which expects a dictionary argument: its keys are
        archive-entry paths, and its values are absolute filesystem paths
        where the contents the corresponding archive entries can be found. The
        modifier is free to change the contents of the files pointed to, add
        new entries and remove entries, before returning. This method will
        extract the entire contents of the wheel to a temporary location, call
        the modifier, and then use the passed (and possibly updated)
        dictionary to write a new wheel. If ``dest_dir`` is specified, the new
        wheel is written there -- otherwise, the original wheel is overwritten.

        The modifier should return True if it updated the wheel, else False.
        This method returns the same value the modifier returns.
        """

        def get_version(path_map, info_dir):
            version = path = None
            key = '%s/%s' % (info_dir, LEGACY_METADATA_FILENAME)
            if key not in path_map:
                key = '%s/PKG-INFO' % info_dir
            if key in path_map:
                path = path_map[key]
                version = Metadata(path=path).version
            return version, path

        def update_version(version, path):
            updated = None
            try:
                NormalizedVersion(version)
                i = version.find('-')
                if i < 0:
                    updated = '%s+1' % version
                else:
                    parts = [int(s) for s in version[i + 1:].split('.')]
                    parts[-1] += 1
                    updated = '%s+%s' % (version[:i], '.'.join(
                        str(i) for i in parts))
            except UnsupportedVersionError:
                logger.debug(
                    'Cannot update non-compliant (PEP-440) '
                    'version %r', version)
            if updated:
                md = Metadata(path=path)
                md.version = updated
                legacy = path.endswith(LEGACY_METADATA_FILENAME)
                md.write(path=path, legacy=legacy)
                logger.debug('Version updated from %r to %r', version, updated)

        pathname = os.path.join(self.dirname, self.filename)
        name_ver = '%s-%s' % (self.name, self.version)
        info_dir = '%s.dist-info' % name_ver
        record_name = posixpath.join(info_dir, 'RECORD')
        with tempdir() as workdir:
            with ZipFile(pathname, 'r') as zf:
                path_map = {}
                for zinfo in zf.infolist():
                    arcname = zinfo.filename
                    if isinstance(arcname, text_type):
                        u_arcname = arcname
                    else:
                        u_arcname = arcname.decode('utf-8')
                    if u_arcname == record_name:
                        continue
                    if '..' in u_arcname:
                        raise DistlibException('invalid entry in '
                                               'wheel: %r' % u_arcname)
                    zf.extract(zinfo, workdir)
                    path = os.path.join(workdir, convert_path(u_arcname))
                    path_map[u_arcname] = path

            # Remember the version.
            original_version, _ = get_version(path_map, info_dir)
            # Files extracted. Call the modifier.
            modified = modifier(path_map, **kwargs)
            if modified:
                # Something changed - need to build a new wheel.
                current_version, path = get_version(path_map, info_dir)
                if current_version and (current_version == original_version):
                    # Add or update local version to signify changes.
                    update_version(current_version, path)
                # Decide where the new wheel goes.
                if dest_dir is None:
                    fd, newpath = tempfile.mkstemp(suffix='.whl',
                                                   prefix='wheel-update-',
                                                   dir=workdir)
                    os.close(fd)
                else:
                    if not os.path.isdir(dest_dir):
                        raise DistlibException('Not a directory: %r' %
                                               dest_dir)
                    newpath = os.path.join(dest_dir, self.filename)
                archive_paths = list(path_map.items())
                distinfo = os.path.join(workdir, info_dir)
                info = distinfo, info_dir
                self.write_records(info, workdir, archive_paths)
                self.build_zip(newpath, archive_paths)
                if dest_dir is None:
                    shutil.copyfile(newpath, pathname)
        return modified


def _get_glibc_version():
    import platform
    ver = platform.libc_ver()
    result = []
    if ver[0] == 'glibc':
        for s in ver[1].split('.'):
            result.append(int(s) if s.isdigit() else 0)
        result = tuple(result)
    return result


def compatible_tags():
    """
    Return (pyver, abi, arch) tuples compatible with this Python.
    """
    versions = [VER_SUFFIX]
    major = VER_SUFFIX[0]
    for minor in range(sys.version_info[1] - 1, -1, -1):
        versions.append(''.join([major, str(minor)]))

    abis = []
    for suffix in _get_suffixes():
        if suffix.startswith('.abi'):
            abis.append(suffix.split('.', 2)[1])
    abis.sort()
    if ABI != 'none':
        abis.insert(0, ABI)
    abis.append('none')
    result = []

    arches = [ARCH]
    if sys.platform == 'darwin':
        m = re.match(r'(\w+)_(\d+)_(\d+)_(\w+)$', ARCH)
        if m:
            name, major, minor, arch = m.groups()
            minor = int(minor)
            matches = [arch]
            if arch in ('i386', 'ppc'):
                matches.append('fat')
            if arch in ('i386', 'ppc', 'x86_64'):
                matches.append('fat3')
            if arch in ('ppc64', 'x86_64'):
                matches.append('fat64')
            if arch in ('i386', 'x86_64'):
                matches.append('intel')
            if arch in ('i386', 'x86_64', 'intel', 'ppc', 'ppc64'):
                matches.append('universal')
            while minor >= 0:
                for match in matches:
                    s = '%s_%s_%s_%s' % (name, major, minor, match)
                    if s != ARCH:  # already there
                        arches.append(s)
                minor -= 1

    # Most specific - our Python version, ABI and arch
    for abi in abis:
        for arch in arches:
            result.append((''.join((IMP_PREFIX, versions[0])), abi, arch))
            # manylinux
            if abi != 'none' and sys.platform.startswith('linux'):
                arch = arch.replace('linux_', '')
                parts = _get_glibc_version()
                if len(parts) == 2:
                    if parts >= (2, 5):
                        result.append((''.join((IMP_PREFIX, versions[0])), abi,
                                       'manylinux1_%s' % arch))
                    if parts >= (2, 12):
                        result.append((''.join((IMP_PREFIX, versions[0])), abi,
                                       'manylinux2010_%s' % arch))
                    if parts >= (2, 17):
                        result.append((''.join((IMP_PREFIX, versions[0])), abi,
                                       'manylinux2014_%s' % arch))
                    result.append(
                        (''.join((IMP_PREFIX, versions[0])), abi,
                         'manylinux_%s_%s_%s' % (parts[0], parts[1], arch)))

    # where no ABI / arch dependency, but IMP_PREFIX dependency
    for i, version in enumerate(versions):
        result.append((''.join((IMP_PREFIX, version)), 'none', 'any'))
        if i == 0:
            result.append((''.join((IMP_PREFIX, version[0])), 'none', 'any'))

    # no IMP_PREFIX, ABI or arch dependency
    for i, version in enumerate(versions):
        result.append((''.join(('py', version)), 'none', 'any'))
        if i == 0:
            result.append((''.join(('py', version[0])), 'none', 'any'))

    return set(result)


COMPATIBLE_TAGS = compatible_tags()

del compatible_tags


def is_compatible(wheel, tags=None):
    if not isinstance(wheel, Wheel):
        wheel = Wheel(wheel)  # assume it's a filename
    result = False
    if tags is None:
        tags = COMPATIBLE_TAGS
    for ver, abi, arch in tags:
        if ver in wheel.pyver and abi in wheel.abi and arch in wheel.arch:
            result = True
            break
    return result

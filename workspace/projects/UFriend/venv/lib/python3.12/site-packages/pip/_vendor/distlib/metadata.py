# -*- coding: utf-8 -*-
#
# Copyright (C) 2012 The Python Software Foundation.
# See LICENSE.txt and CONTRIBUTORS.txt.
#
"""Implementation of the Metadata for Python packages PEPs.

Supports all metadata formats (1.0, 1.1, 1.2, 1.3/2.1 and 2.2).
"""
from __future__ import unicode_literals

import codecs
from email import message_from_file
import json
import logging
import re


from . import DistlibException, __version__
from .compat import StringIO, string_types, text_type
from .markers import interpret
from .util import extract_by_key, get_extras
from .version import get_scheme, PEP440_VERSION_RE

logger = logging.getLogger(__name__)


class MetadataMissingError(DistlibException):
    """A required metadata is missing"""


class MetadataConflictError(DistlibException):
    """Attempt to read or write metadata fields that are conflictual."""


class MetadataUnrecognizedVersionError(DistlibException):
    """Unknown metadata version number."""


class MetadataInvalidError(DistlibException):
    """A metadata value is invalid"""

# public API of this module
__all__ = ['Metadata', 'PKG_INFO_ENCODING', 'PKG_INFO_PREFERRED_VERSION']

# Encoding used for the PKG-INFO files
PKG_INFO_ENCODING = 'utf-8'

# preferred version. Hopefully will be changed
# to 1.2 once PEP 345 is supported everywhere
PKG_INFO_PREFERRED_VERSION = '1.1'

_LINE_PREFIX_1_2 = re.compile('\n       \\|')
_LINE_PREFIX_PRE_1_2 = re.compile('\n        ')
_241_FIELDS = ('Metadata-Version', 'Name', 'Version', 'Platform',
               'Summary', 'Description',
               'Keywords', 'Home-page', 'Author', 'Author-email',
               'License')

_314_FIELDS = ('Metadata-Version', 'Name', 'Version', 'Platform',
               'Supported-Platform', 'Summary', 'Description',
               'Keywords', 'Home-page', 'Author', 'Author-email',
               'License', 'Classifier', 'Download-URL', 'Obsoletes',
               'Provides', 'Requires')

_314_MARKERS = ('Obsoletes', 'Provides', 'Requires', 'Classifier',
                'Download-URL')

_345_FIELDS = ('Metadata-Version', 'Name', 'Version', 'Platform',
               'Supported-Platform', 'Summary', 'Description',
               'Keywords', 'Home-page', 'Author', 'Author-email',
               'Maintainer', 'Maintainer-email', 'License',
               'Classifier', 'Download-URL', 'Obsoletes-Dist',
               'Project-URL', 'Provides-Dist', 'Requires-Dist',
               'Requires-Python', 'Requires-External')

_345_MARKERS = ('Provides-Dist', 'Requires-Dist', 'Requires-Python',
                'Obsoletes-Dist', 'Requires-External', 'Maintainer',
                'Maintainer-email', 'Project-URL')

_426_FIELDS = ('Metadata-Version', 'Name', 'Version', 'Platform',
               'Supported-Platform', 'Summary', 'Description',
               'Keywords', 'Home-page', 'Author', 'Author-email',
               'Maintainer', 'Maintainer-email', 'License',
               'Classifier', 'Download-URL', 'Obsoletes-Dist',
               'Project-URL', 'Provides-Dist', 'Requires-Dist',
               'Requires-Python', 'Requires-External', 'Private-Version',
               'Obsoleted-By', 'Setup-Requires-Dist', 'Extension',
               'Provides-Extra')

_426_MARKERS = ('Private-Version', 'Provides-Extra', 'Obsoleted-By',
                'Setup-Requires-Dist', 'Extension')

# See issue #106: Sometimes 'Requires' and 'Provides' occur wrongly in
# the metadata. Include them in the tuple literal below to allow them
# (for now).
# Ditto for Obsoletes - see issue #140.
_566_FIELDS = _426_FIELDS + ('Description-Content-Type',
                             'Requires', 'Provides', 'Obsoletes')

_566_MARKERS = ('Description-Content-Type',)

_643_MARKERS = ('Dynamic', 'License-File')

_643_FIELDS = _566_FIELDS + _643_MARKERS

_ALL_FIELDS = set()
_ALL_FIELDS.update(_241_FIELDS)
_ALL_FIELDS.update(_314_FIELDS)
_ALL_FIELDS.update(_345_FIELDS)
_ALL_FIELDS.update(_426_FIELDS)
_ALL_FIELDS.update(_566_FIELDS)
_ALL_FIELDS.update(_643_FIELDS)

EXTRA_RE = re.compile(r'''extra\s*==\s*("([^"]+)"|'([^']+)')''')


def _version2fieldlist(version):
    if version == '1.0':
        return _241_FIELDS
    elif version == '1.1':
        return _314_FIELDS
    elif version == '1.2':
        return _345_FIELDS
    elif version in ('1.3', '2.1'):
        # avoid adding field names if already there
        return _345_FIELDS + tuple(f for f in _566_FIELDS if f not in _345_FIELDS)
    elif version == '2.0':
        raise ValueError('Metadata 2.0 is withdrawn and not supported')
        # return _426_FIELDS
    elif version == '2.2':
        return _643_FIELDS
    raise MetadataUnrecognizedVersionError(version)


def _best_version(fields):
    """Detect the best version depending on the fields used."""
    def _has_marker(keys, markers):
        return any(marker in keys for marker in markers)

    keys = [key for key, value in fields.items() if value not in ([], 'UNKNOWN', None)]
    possible_versions = ['1.0', '1.1', '1.2', '1.3', '2.1', '2.2']  # 2.0 removed

    # first let's try to see if a field is not part of one of the version
    for key in keys:
        if key not in _241_FIELDS and '1.0' in possible_versions:
            possible_versions.remove('1.0')
            logger.debug('Removed 1.0 due to %s', key)
        if key not in _314_FIELDS and '1.1' in possible_versions:
            possible_versions.remove('1.1')
            logger.debug('Removed 1.1 due to %s', key)
        if key not in _345_FIELDS and '1.2' in possible_versions:
            possible_versions.remove('1.2')
            logger.debug('Removed 1.2 due to %s', key)
        if key not in _566_FIELDS and '1.3' in possible_versions:
            possible_versions.remove('1.3')
            logger.debug('Removed 1.3 due to %s', key)
        if key not in _566_FIELDS and '2.1' in possible_versions:
            if key != 'Description':  # In 2.1, description allowed after headers
                possible_versions.remove('2.1')
                logger.debug('Removed 2.1 due to %s', key)
        if key not in _643_FIELDS and '2.2' in possible_versions:
            possible_versions.remove('2.2')
            logger.debug('Removed 2.2 due to %s', key)
        # if key not in _426_FIELDS and '2.0' in possible_versions:
            # possible_versions.remove('2.0')
            # logger.debug('Removed 2.0 due to %s', key)

    # possible_version contains qualified versions
    if len(possible_versions) == 1:
        return possible_versions[0]   # found !
    elif len(possible_versions) == 0:
        logger.debug('Out of options - unknown metadata set: %s', fields)
        raise MetadataConflictError('Unknown metadata set')

    # let's see if one unique marker is found
    is_1_1 = '1.1' in possible_versions and _has_marker(keys, _314_MARKERS)
    is_1_2 = '1.2' in possible_versions and _has_marker(keys, _345_MARKERS)
    is_2_1 = '2.1' in possible_versions and _has_marker(keys, _566_MARKERS)
    # is_2_0 = '2.0' in possible_versions and _has_marker(keys, _426_MARKERS)
    is_2_2 = '2.2' in possible_versions and _has_marker(keys, _643_MARKERS)
    if int(is_1_1) + int(is_1_2) + int(is_2_1) + int(is_2_2) > 1:
        raise MetadataConflictError('You used incompatible 1.1/1.2/2.1/2.2 fields')

    # we have the choice, 1.0, or 1.2, 2.1 or 2.2
    #   - 1.0 has a broken Summary field but works with all tools
    #   - 1.1 is to avoid
    #   - 1.2 fixes Summary but has little adoption
    #   - 2.1 adds more features
    #   - 2.2 is the latest
    if not is_1_1 and not is_1_2 and not is_2_1 and not is_2_2:
        # we couldn't find any specific marker
        if PKG_INFO_PREFERRED_VERSION in possible_versions:
            return PKG_INFO_PREFERRED_VERSION
    if is_1_1:
        return '1.1'
    if is_1_2:
        return '1.2'
    if is_2_1:
        return '2.1'
    # if is_2_2:
        # return '2.2'

    return '2.2'

# This follows the rules about transforming keys as described in
# https://www.python.org/dev/peps/pep-0566/#id17
_ATTR2FIELD = {
    name.lower().replace("-", "_"): name for name in _ALL_FIELDS
}
_FIELD2ATTR = {field: attr for attr, field in _ATTR2FIELD.items()}

_PREDICATE_FIELDS = ('Requires-Dist', 'Obsoletes-Dist', 'Provides-Dist')
_VERSIONS_FIELDS = ('Requires-Python',)
_VERSION_FIELDS = ('Version',)
_LISTFIELDS = ('Platform', 'Classifier', 'Obsoletes',
               'Requires', 'Provides', 'Obsoletes-Dist',
               'Provides-Dist', 'Requires-Dist', 'Requires-External',
               'Project-URL', 'Supported-Platform', 'Setup-Requires-Dist',
               'Provides-Extra', 'Extension', 'License-File')
_LISTTUPLEFIELDS = ('Project-URL',)

_ELEMENTSFIELD = ('Keywords',)

_UNICODEFIELDS = ('Author', 'Maintainer', 'Summary', 'Description')

_MISSING = object()

_FILESAFE = re.compile('[^A-Za-z0-9.]+')


def _get_name_and_version(name, version, for_filename=False):
    """Return the distribution name with version.

    If for_filename is true, return a filename-escaped form."""
    if for_filename:
        # For both name and version any runs of non-alphanumeric or '.'
        # characters are replaced with a single '-'.  Additionally any
        # spaces in the version string become '.'
        name = _FILESAFE.sub('-', name)
        version = _FILESAFE.sub('-', version.replace(' ', '.'))
    return '%s-%s' % (name, version)


class LegacyMetadata(object):
    """The legacy metadata of a release.

    Supports versions 1.0, 1.1, 1.2, 2.0 and 1.3/2.1 (auto-detected). You can
    instantiate the class with one of these arguments (or none):
    - *path*, the path to a metadata file
    - *fileobj* give a file-like object with metadata as content
    - *mapping* is a dict-like object
    - *scheme* is a version scheme name
    """
    # TODO document the mapping API and UNKNOWN default key

    def __init__(self, path=None, fileobj=None, mapping=None,
                 scheme='default'):
        if [path, fileobj, mapping].count(None) < 2:
            raise TypeError('path, fileobj and mapping are exclusive')
        self._fields = {}
        self.requires_files = []
        self._dependencies = None
        self.scheme = scheme
        if path is not None:
            self.read(path)
        elif fileobj is not None:
            self.read_file(fileobj)
        elif mapping is not None:
            self.update(mapping)
            self.set_metadata_version()

    def set_metadata_version(self):
        self._fields['Metadata-Version'] = _best_version(self._fields)

    def _write_field(self, fileobj, name, value):
        fileobj.write('%s: %s\n' % (name, value))

    def __getitem__(self, name):
        return self.get(name)

    def __setitem__(self, name, value):
        return self.set(name, value)

    def __delitem__(self, name):
        field_name = self._convert_name(name)
        try:
            del self._fields[field_name]
        except KeyError:
            raise KeyError(name)

    def __contains__(self, name):
        return (name in self._fields or
                self._convert_name(name) in self._fields)

    def _convert_name(self, name):
        if name in _ALL_FIELDS:
            return name
        name = name.replace('-', '_').lower()
        return _ATTR2FIELD.get(name, name)

    def _default_value(self, name):
        if name in _LISTFIELDS or name in _ELEMENTSFIELD:
            return []
        return 'UNKNOWN'

    def _remove_line_prefix(self, value):
        if self.metadata_version in ('1.0', '1.1'):
            return _LINE_PREFIX_PRE_1_2.sub('\n', value)
        else:
            return _LINE_PREFIX_1_2.sub('\n', value)

    def __getattr__(self, name):
        if name in _ATTR2FIELD:
            return self[name]
        raise AttributeError(name)

    #
    # Public API
    #

#    dependencies = property(_get_dependencies, _set_dependencies)

    def get_fullname(self, filesafe=False):
        """Return the distribution name with version.

        If filesafe is true, return a filename-escaped form."""
        return _get_name_and_version(self['Name'], self['Version'], filesafe)

    def is_field(self, name):
        """return True if name is a valid metadata key"""
        name = self._convert_name(name)
        return name in _ALL_FIELDS

    def is_multi_field(self, name):
        name = self._convert_name(name)
        return name in _LISTFIELDS

    def read(self, filepath):
        """Read the metadata values from a file path."""
        fp = codecs.open(filepath, 'r', encoding='utf-8')
        try:
            self.read_file(fp)
        finally:
            fp.close()

    def read_file(self, fileob):
        """Read the metadata values from a file object."""
        msg = message_from_file(fileob)
        self._fields['Metadata-Version'] = msg['metadata-version']

        # When reading, get all the fields we can
        for field in _ALL_FIELDS:
            if field not in msg:
                continue
            if field in _LISTFIELDS:
                # we can have multiple lines
                values = msg.get_all(field)
                if field in _LISTTUPLEFIELDS and values is not None:
                    values = [tuple(value.split(',')) for value in values]
                self.set(field, values)
            else:
                # single line
                value = msg[field]
                if value is not None and value != 'UNKNOWN':
                    self.set(field, value)

        # PEP 566 specifies that the body be used for the description, if
        # available
        body = msg.get_payload()
        self["Description"] = body if body else self["Description"]
        # logger.debug('Attempting to set metadata for %s', self)
        # self.set_metadata_version()

    def write(self, filepath, skip_unknown=False):
        """Write the metadata fields to filepath."""
        fp = codecs.open(filepath, 'w', encoding='utf-8')
        try:
            self.write_file(fp, skip_unknown)
        finally:
            fp.close()

    def write_file(self, fileobject, skip_unknown=False):
        """Write the PKG-INFO format data to a file object."""
        self.set_metadata_version()

        for field in _version2fieldlist(self['Metadata-Version']):
            values = self.get(field)
            if skip_unknown and values in ('UNKNOWN', [], ['UNKNOWN']):
                continue
            if field in _ELEMENTSFIELD:
                self._write_field(fileobject, field, ','.join(values))
                continue
            if field not in _LISTFIELDS:
                if field == 'Description':
                    if self.metadata_version in ('1.0', '1.1'):
                        values = values.replace('\n', '\n        ')
                    else:
                        values = values.replace('\n', '\n       |')
                values = [values]

            if field in _LISTTUPLEFIELDS:
                values = [','.join(value) for value in values]

            for value in values:
                self._write_field(fileobject, field, value)

    def update(self, other=None, **kwargs):
        """Set metadata values from the given iterable `other` and kwargs.

        Behavior is like `dict.update`: If `other` has a ``keys`` method,
        they are looped over and ``self[key]`` is assigned ``other[key]``.
        Else, ``other`` is an iterable of ``(key, value)`` iterables.

        Keys that don't match a metadata field or that have an empty value are
        dropped.
        """
        def _set(key, value):
            if key in _ATTR2FIELD and value:
                self.set(self._convert_name(key), value)

        if not other:
            # other is None or empty container
            pass
        elif hasattr(other, 'keys'):
            for k in other.keys():
                _set(k, other[k])
        else:
            for k, v in other:
                _set(k, v)

        if kwargs:
            for k, v in kwargs.items():
                _set(k, v)

    def set(self, name, value):
        """Control then set a metadata field."""
        name = self._convert_name(name)

        if ((name in _ELEMENTSFIELD or name == 'Platform') and
            not isinstance(value, (list, tuple))):
            if isinstance(value, string_types):
                value = [v.strip() for v in value.split(',')]
            else:
                value = []
        elif (name in _LISTFIELDS and
              not isinstance(value, (list, tuple))):
            if isinstance(value, string_types):
                value = [value]
            else:
                value = []

        if logger.isEnabledFor(logging.WARNING):
            project_name = self['Name']

            scheme = get_scheme(self.scheme)
            if name in _PREDICATE_FIELDS and value is not None:
                for v in value:
                    # check that the values are valid
                    if not scheme.is_valid_matcher(v.split(';')[0]):
                        logger.warning(
                            "'%s': '%s' is not valid (field '%s')",
                            project_name, v, name)
            # FIXME this rejects UNKNOWN, is that right?
            elif name in _VERSIONS_FIELDS and value is not None:
                if not scheme.is_valid_constraint_list(value):
                    logger.warning("'%s': '%s' is not a valid version (field '%s')",
                                   project_name, value, name)
            elif name in _VERSION_FIELDS and value is not None:
                if not scheme.is_valid_version(value):
                    logger.warning("'%s': '%s' is not a valid version (field '%s')",
                                   project_name, value, name)

        if name in _UNICODEFIELDS:
            if name == 'Description':
                value = self._remove_line_prefix(value)

        self._fields[name] = value

    def get(self, name, default=_MISSING):
        """Get a metadata field."""
        name = self._convert_name(name)
        if name not in self._fields:
            if default is _MISSING:
                default = self._default_value(name)
            return default
        if name in _UNICODEFIELDS:
            value = self._fields[name]
            return value
        elif name in _LISTFIELDS:
            value = self._fields[name]
            if value is None:
                return []
            res = []
            for val in value:
                if name not in _LISTTUPLEFIELDS:
                    res.append(val)
                else:
                    # That's for Project-URL
                    res.append((val[0], val[1]))
            return res

        elif name in _ELEMENTSFIELD:
            value = self._fields[name]
            if isinstance(value, string_types):
                return value.split(',')
        return self._fields[name]

    def check(self, strict=False):
        """Check if the metadata is compliant. If strict is True then raise if
        no Name or Version are provided"""
        self.set_metadata_version()

        # XXX should check the versions (if the file was loaded)
        missing, warnings = [], []

        for attr in ('Name', 'Version'):  # required by PEP 345
            if attr not in self:
                missing.append(attr)

        if strict and missing != []:
            msg = 'missing required metadata: %s' % ', '.join(missing)
            raise MetadataMissingError(msg)

        for attr in ('Home-page', 'Author'):
            if attr not in self:
                missing.append(attr)

        # checking metadata 1.2 (XXX needs to check 1.1, 1.0)
        if self['Metadata-Version'] != '1.2':
            return missing, warnings

        scheme = get_scheme(self.scheme)

        def are_valid_constraints(value):
            for v in value:
                if not scheme.is_valid_matcher(v.split(';')[0]):
                    return False
            return True

        for fields, controller in ((_PREDICATE_FIELDS, are_valid_constraints),
                                   (_VERSIONS_FIELDS,
                                    scheme.is_valid_constraint_list),
                                   (_VERSION_FIELDS,
                                    scheme.is_valid_version)):
            for field in fields:
                value = self.get(field, None)
                if value is not None and not controller(value):
                    warnings.append("Wrong value for '%s': %s" % (field, value))

        return missing, warnings

    def todict(self, skip_missing=False):
        """Return fields as a dict.

        Field names will be converted to use the underscore-lowercase style
        instead of hyphen-mixed case (i.e. home_page instead of Home-page).
        This is as per https://www.python.org/dev/peps/pep-0566/#id17.
        """
        self.set_metadata_version()

        fields = _version2fieldlist(self['Metadata-Version'])

        data = {}

        for field_name in fields:
            if not skip_missing or field_name in self._fields:
                key = _FIELD2ATTR[field_name]
                if key != 'project_url':
                    data[key] = self[field_name]
                else:
                    data[key] = [','.join(u) for u in self[field_name]]

        return data

    def add_requirements(self, requirements):
        if self['Metadata-Version'] == '1.1':
            # we can't have 1.1 metadata *and* Setuptools requires
            for field in ('Obsoletes', 'Requires', 'Provides'):
                if field in self:
                    del self[field]
        self['Requires-Dist'] += requirements

    # Mapping API
    # TODO could add iter* variants

    def keys(self):
        return list(_version2fieldlist(self['Metadata-Version']))

    def __iter__(self):
        for key in self.keys():
            yield key

    def values(self):
        return [self[key] for key in self.keys()]

    def items(self):
        return [(key, self[key]) for key in self.keys()]

    def __repr__(self):
        return '<%s %s %s>' % (self.__class__.__name__, self.name,
                               self.version)


METADATA_FILENAME = 'pydist.json'
WHEEL_METADATA_FILENAME = 'metadata.json'
LEGACY_METADATA_FILENAME = 'METADATA'


class Metadata(object):
    """
    The metadata of a release. This implementation uses 2.1
    metadata where possible. If not possible, it wraps a LegacyMetadata
    instance which handles the key-value metadata format.
    """

    METADATA_VERSION_MATCHER = re.compile(r'^\d+(\.\d+)*$')

    NAME_MATCHER = re.compile('^[0-9A-Z]([0-9A-Z_.-]*[0-9A-Z])?$', re.I)

    FIELDNAME_MATCHER = re.compile('^[A-Z]([0-9A-Z-]*[0-9A-Z])?$', re.I)

    VERSION_MATCHER = PEP440_VERSION_RE

    SUMMARY_MATCHER = re.compile('.{1,2047}')

    METADATA_VERSION = '2.0'

    GENERATOR = 'distlib (%s)' % __version__

    MANDATORY_KEYS = {
        'name': (),
        'version': (),
        'summary': ('legacy',),
    }

    INDEX_KEYS = ('name version license summary description author '
                  'author_email keywords platform home_page classifiers '
                  'download_url')

    DEPENDENCY_KEYS = ('extras run_requires test_requires build_requires '
                       'dev_requires provides meta_requires obsoleted_by '
                       'supports_environments')

    SYNTAX_VALIDATORS = {
        'metadata_version': (METADATA_VERSION_MATCHER, ()),
        'name': (NAME_MATCHER, ('legacy',)),
        'version': (VERSION_MATCHER, ('legacy',)),
        'summary': (SUMMARY_MATCHER, ('legacy',)),
        'dynamic': (FIELDNAME_MATCHER, ('legacy',)),
    }

    __slots__ = ('_legacy', '_data', 'scheme')

    def __init__(self, path=None, fileobj=None, mapping=None,
                 scheme='default'):
        if [path, fileobj, mapping].count(None) < 2:
            raise TypeError('path, fileobj and mapping are exclusive')
        self._legacy = None
        self._data = None
        self.scheme = scheme
        #import pdb; pdb.set_trace()
        if mapping is not None:
            try:
                self._validate_mapping(mapping, scheme)
                self._data = mapping
            except MetadataUnrecognizedVersionError:
                self._legacy = LegacyMetadata(mapping=mapping, scheme=scheme)
                self.validate()
        else:
            data = None
            if path:
                with open(path, 'rb') as f:
                    data = f.read()
            elif fileobj:
                data = fileobj.read()
            if data is None:
                # Initialised with no args - to be added
                self._data = {
                    'metadata_version': self.METADATA_VERSION,
                    'generator': self.GENERATOR,
                }
            else:
                if not isinstance(data, text_type):
                    data = data.decode('utf-8')
                try:
                    self._data = json.loads(data)
                    self._validate_mapping(self._data, scheme)
                except ValueError:
                    # Note: MetadataUnrecognizedVersionError does not
                    # inherit from ValueError (it's a DistlibException,
                    # which should not inherit from ValueError).
                    # The ValueError comes from the json.load - if that
                    # succeeds and we get a validation error, we want
                    # that to propagate
                    self._legacy = LegacyMetadata(fileobj=StringIO(data),
                                                  scheme=scheme)
                    self.validate()

    common_keys = set(('name', 'version', 'license', 'keywords', 'summary'))

    none_list = (None, list)
    none_dict = (None, dict)

    mapped_keys = {
        'run_requires': ('Requires-Dist', list),
        'build_requires': ('Setup-Requires-Dist', list),
        'dev_requires': none_list,
        'test_requires': none_list,
        'meta_requires': none_list,
        'extras': ('Provides-Extra', list),
        'modules': none_list,
        'namespaces': none_list,
        'exports': none_dict,
        'commands': none_dict,
        'classifiers': ('Classifier', list),
        'source_url': ('Download-URL', None),
        'metadata_version': ('Metadata-Version', None),
    }

    del none_list, none_dict

    def __getattribute__(self, key):
        common = object.__getattribute__(self, 'common_keys')
        mapped = object.__getattribute__(self, 'mapped_keys')
        if key in mapped:
            lk, maker = mapped[key]
            if self._legacy:
                if lk is None:
                    result = None if maker is None else maker()
                else:
                    result = self._legacy.get(lk)
            else:
                value = None if maker is None else maker()
                if key not in ('commands', 'exports', 'modules', 'namespaces',
                               'classifiers'):
                    result = self._data.get(key, value)
                else:
                    # special cases for PEP 459
                    sentinel = object()
                    result = sentinel
                    d = self._data.get('extensions')
                    if d:
                        if key == 'commands':
                            result = d.get('python.commands', value)
                        elif key == 'classifiers':
                            d = d.get('python.details')
                            if d:
                                result = d.get(key, value)
                        else:
                            d = d.get('python.exports')
                            if not d:
                                d = self._data.get('python.exports')
                            if d:
                                result = d.get(key, value)
                    if result is sentinel:
                        result = value
        elif key not in common:
            result = object.__getattribute__(self, key)
        elif self._legacy:
            result = self._legacy.get(key)
        else:
            result = self._data.get(key)
        return result

    def _validate_value(self, key, value, scheme=None):
        if key in self.SYNTAX_VALIDATORS:
            pattern, exclusions = self.SYNTAX_VALIDATORS[key]
            if (scheme or self.scheme) not in exclusions:
                m = pattern.match(value)
                if not m:
                    raise MetadataInvalidError("'%s' is an invalid value for "
                                               "the '%s' property" % (value,
                                                                    key))

    def __setattr__(self, key, value):
        self._validate_value(key, value)
        common = object.__getattribute__(self, 'common_keys')
        mapped = object.__getattribute__(self, 'mapped_keys')
        if key in mapped:
            lk, _ = mapped[key]
            if self._legacy:
                if lk is None:
                    raise NotImplementedError
                self._legacy[lk] = value
            elif key not in ('commands', 'exports', 'modules', 'namespaces',
                             'classifiers'):
                self._data[key] = value
            else:
                # special cases for PEP 459
                d = self._data.setdefault('extensions', {})
                if key == 'commands':
                    d['python.commands'] = value
                elif key == 'classifiers':
                    d = d.setdefault('python.details', {})
                    d[key] = value
                else:
                    d = d.setdefault('python.exports', {})
                    d[key] = value
        elif key not in common:
            object.__setattr__(self, key, value)
        else:
            if key == 'keywords':
                if isinstance(value, string_types):
                    value = value.strip()
                    if value:
                        value = value.split()
                    else:
                        value = []
            if self._legacy:
                self._legacy[key] = value
            else:
                self._data[key] = value

    @property
    def name_and_version(self):
        return _get_name_and_version(self.name, self.version, True)

    @property
    def provides(self):
        if self._legacy:
            result = self._legacy['Provides-Dist']
        else:
            result = self._data.setdefault('provides', [])
        s = '%s (%s)' % (self.name, self.version)
        if s not in result:
            result.append(s)
        return result

    @provides.setter
    def provides(self, value):
        if self._legacy:
            self._legacy['Provides-Dist'] = value
        else:
            self._data['provides'] = value

    def get_requirements(self, reqts, extras=None, env=None):
        """
        Base method to get dependencies, given a set of extras
        to satisfy and an optional environment context.
        :param reqts: A list of sometimes-wanted dependencies,
                      perhaps dependent on extras and environment.
        :param extras: A list of optional components being requested.
        :param env: An optional environment for marker evaluation.
        """
        if self._legacy:
            result = reqts
        else:
            result = []
            extras = get_extras(extras or [], self.extras)
            for d in reqts:
                if 'extra' not in d and 'environment' not in d:
                    # unconditional
                    include = True
                else:
                    if 'extra' not in d:
                        # Not extra-dependent - only environment-dependent
                        include = True
                    else:
                        include = d.get('extra') in extras
                    if include:
                        # Not excluded because of extras, check environment
                        marker = d.get('environment')
                        if marker:
                            include = interpret(marker, env)
                if include:
                    result.extend(d['requires'])
            for key in ('build', 'dev', 'test'):
                e = ':%s:' % key
                if e in extras:
                    extras.remove(e)
                    # A recursive call, but it should terminate since 'test'
                    # has been removed from the extras
                    reqts = self._data.get('%s_requires' % key, [])
                    result.extend(self.get_requirements(reqts, extras=extras,
                                                        env=env))
        return result

    @property
    def dictionary(self):
        if self._legacy:
            return self._from_legacy()
        return self._data

    @property
    def dependencies(self):
        if self._legacy:
            raise NotImplementedError
        else:
            return extract_by_key(self._data, self.DEPENDENCY_KEYS)

    @dependencies.setter
    def dependencies(self, value):
        if self._legacy:
            raise NotImplementedError
        else:
            self._data.update(value)

    def _validate_mapping(self, mapping, scheme):
        if mapping.get('metadata_version') != self.METADATA_VERSION:
            raise MetadataUnrecognizedVersionError()
        missing = []
        for key, exclusions in self.MANDATORY_KEYS.items():
            if key not in mapping:
                if scheme not in exclusions:
                    missing.append(key)
        if missing:
            msg = 'Missing metadata items: %s' % ', '.join(missing)
            raise MetadataMissingError(msg)
        for k, v in mapping.items():
            self._validate_value(k, v, scheme)

    def validate(self):
        if self._legacy:
            missing, warnings = self._legacy.check(True)
            if missing or warnings:
                logger.warning('Metadata: missing: %s, warnings: %s',
                               missing, warnings)
        else:
            self._validate_mapping(self._data, self.scheme)

    def todict(self):
        if self._legacy:
            return self._legacy.todict(True)
        else:
            result = extract_by_key(self._data, self.INDEX_KEYS)
            return result

    def _from_legacy(self):
        assert self._legacy and not self._data
        result = {
            'metadata_version': self.METADATA_VERSION,
            'generator': self.GENERATOR,
        }
        lmd = self._legacy.todict(True)     # skip missing ones
        for k in ('name', 'version', 'license', 'summary', 'description',
                  'classifier'):
            if k in lmd:
                if k == 'classifier':
                    nk = 'classifiers'
                else:
                    nk = k
                result[nk] = lmd[k]
        kw = lmd.get('Keywords', [])
        if kw == ['']:
            kw = []
        result['keywords'] = kw
        keys = (('requires_dist', 'run_requires'),
                ('setup_requires_dist', 'build_requires'))
        for ok, nk in keys:
            if ok in lmd and lmd[ok]:
                result[nk] = [{'requires': lmd[ok]}]
        result['provides'] = self.provides
        author = {}
        maintainer = {}
        return result

    LEGACY_MAPPING = {
        'name': 'Name',
        'version': 'Version',
        ('extensions', 'python.details', 'license'): 'License',
        'summary': 'Summary',
        'description': 'Description',
        ('extensions', 'python.project', 'project_urls', 'Home'): 'Home-page',
        ('extensions', 'python.project', 'contacts', 0, 'name'): 'Author',
        ('extensions', 'python.project', 'contacts', 0, 'email'): 'Author-email',
        'source_url': 'Download-URL',
        ('extensions', 'python.details', 'classifiers'): 'Classifier',
    }

    def _to_legacy(self):
        def process_entries(entries):
            reqts = set()
            for e in entries:
                extra = e.get('extra')
                env = e.get('environment')
                rlist = e['requires']
                for r in rlist:
                    if not env and not extra:
                        reqts.add(r)
                    else:
                        marker = ''
                        if extra:
                            marker = 'extra == "%s"' % extra
                        if env:
                            if marker:
                                marker = '(%s) and %s' % (env, marker)
                            else:
                                marker = env
                        reqts.add(';'.join((r, marker)))
            return reqts

        assert self._data and not self._legacy
        result = LegacyMetadata()
        nmd = self._data
        # import pdb; pdb.set_trace()
        for nk, ok in self.LEGACY_MAPPING.items():
            if not isinstance(nk, tuple):
                if nk in nmd:
                    result[ok] = nmd[nk]
            else:
                d = nmd
                found = True
                for k in nk:
                    try:
                        d = d[k]
                    except (KeyError, IndexError):
                        found = False
                        break
                if found:
                    result[ok] = d
        r1 = process_entries(self.run_requires + self.meta_requires)
        r2 = process_entries(self.build_requires + self.dev_requires)
        if self.extras:
            result['Provides-Extra'] = sorted(self.extras)
        result['Requires-Dist'] = sorted(r1)
        result['Setup-Requires-Dist'] = sorted(r2)
        # TODO: any other fields wanted
        return result

    def write(self, path=None, fileobj=None, legacy=False, skip_unknown=True):
        if [path, fileobj].count(None) != 1:
            raise ValueError('Exactly one of path and fileobj is needed')
        self.validate()
        if legacy:
            if self._legacy:
                legacy_md = self._legacy
            else:
                legacy_md = self._to_legacy()
            if path:
                legacy_md.write(path, skip_unknown=skip_unknown)
            else:
                legacy_md.write_file(fileobj, skip_unknown=skip_unknown)
        else:
            if self._legacy:
                d = self._from_legacy()
            else:
                d = self._data
            if fileobj:
                json.dump(d, fileobj, ensure_ascii=True, indent=2,
                          sort_keys=True)
            else:
                with codecs.open(path, 'w', 'utf-8') as f:
                    json.dump(d, f, ensure_ascii=True, indent=2,
                              sort_keys=True)

    def add_requirements(self, requirements):
        if self._legacy:
            self._legacy.add_requirements(requirements)
        else:
            run_requires = self._data.setdefault('run_requires', [])
            always = None
            for entry in run_requires:
                if 'environment' not in entry and 'extra' not in entry:
                    always = entry
                    break
            if always is None:
                always = { 'requires': requirements }
                run_requires.insert(0, always)
            else:
                rset = set(always['requires']) | set(requirements)
                always['requires'] = sorted(rset)

    def __repr__(self):
        name = self.name or '(no name)'
        version = self.version or 'no version'
        return '<%s %s %s (%s)>' % (self.__class__.__name__,
                                    self.metadata_version, name, version)

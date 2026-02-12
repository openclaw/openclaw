# cython: binding=True
# cython: auto_pickle=False
# cython: language_level=3

"""
The ``lxml.etree`` module implements the extended ElementTree API for XML.
"""

__docformat__ = "restructuredtext en"

__all__ = [
    'AttributeBasedElementClassLookup', 'C14NError', 'C14NWriterTarget', 'CDATA',
    'Comment', 'CommentBase', 'CustomElementClassLookup', 'DEBUG',
    'DTD', 'DTDError', 'DTDParseError', 'DTDValidateError',
    'DocumentInvalid', 'ETCompatXMLParser', 'ETXPath', 'Element',
    'ElementBase', 'ElementClassLookup', 'ElementDefaultClassLookup',
    'ElementNamespaceClassLookup', 'ElementTree', 'Entity', 'EntityBase',
    'Error', 'ErrorDomains', 'ErrorLevels', 'ErrorTypes', 'Extension',
    'FallbackElementClassLookup', 'FunctionNamespace', 'HTML', 'HTMLParser',
    'ICONV_COMPILED_VERSION',
    'LIBXML_COMPILED_VERSION', 'LIBXML_VERSION',
    'LIBXML_FEATURES',
    'LIBXSLT_COMPILED_VERSION', 'LIBXSLT_VERSION',
    'LXML_VERSION',
    'LxmlError', 'LxmlRegistryError', 'LxmlSyntaxError',
    'NamespaceRegistryError', 'PI', 'PIBase', 'ParseError',
    'ParserBasedElementClassLookup', 'ParserError', 'ProcessingInstruction',
    'PyErrorLog', 'PythonElementClassLookup', 'QName', 'RelaxNG',
    'RelaxNGError', 'RelaxNGErrorTypes', 'RelaxNGParseError',
    'RelaxNGValidateError', 'Resolver', 'Schematron', 'SchematronError',
    'SchematronParseError', 'SchematronValidateError', 'SerialisationError',
    'SubElement', 'TreeBuilder', 'XInclude', 'XIncludeError', 'XML',
    'XMLDTDID', 'XMLID', 'XMLParser', 'XMLSchema', 'XMLSchemaError',
    'XMLSchemaParseError', 'XMLSchemaValidateError', 'XMLSyntaxError',
    'XMLTreeBuilder', 'XPath', 'XPathDocumentEvaluator', 'XPathError',
    'XPathEvalError', 'XPathEvaluator', 'XPathFunctionError', 'XPathResultError',
    'XPathSyntaxError', 'XSLT', 'XSLTAccessControl', 'XSLTApplyError',
    'XSLTError', 'XSLTExtension', 'XSLTExtensionError', 'XSLTParseError',
    'XSLTSaveError', 'canonicalize',
    'cleanup_namespaces', 'clear_error_log', 'dump',
    'fromstring', 'fromstringlist', 'get_default_parser', 'iselement',
    'iterparse', 'iterwalk', 'parse', 'parseid', 'register_namespace',
    'set_default_parser', 'set_element_class_lookup', 'strip_attributes',
    'strip_elements', 'strip_tags', 'tostring', 'tostringlist', 'tounicode',
    'use_global_python_log'
    ]

cimport cython

from lxml cimport python
from lxml.includes cimport tree, config
from lxml.includes.tree cimport xmlDoc, xmlNode, xmlAttr, xmlNs, _isElement, _getNs
from lxml.includes.tree cimport const_xmlChar, xmlChar, _xcstr
from lxml.python cimport _cstr, _isString
from lxml.includes cimport xpath
from lxml.includes cimport c14n

# Cython's standard declarations
cimport cpython.mem
cimport cpython.ref
from libc cimport limits, stdio, stdlib
from libc cimport string as cstring_h   # not to be confused with stdlib 'string'
from libc.string cimport const_char

cdef object os_path_abspath
from os.path import abspath as os_path_abspath

cdef object BytesIO, StringIO
from io import BytesIO, StringIO

cdef object OrderedDict
from collections import OrderedDict

cdef object _elementpath
from lxml import _elementpath

cdef object sys
import sys

cdef object re
import re

cdef object partial
from functools import partial

cdef object islice
from itertools import islice

cdef object ITER_EMPTY = iter(())

cdef object MutableMapping
from collections.abc import MutableMapping

class _ImmutableMapping(MutableMapping):
    def __getitem__(self, key):
        raise KeyError, key

    def __setitem__(self, key, value):
        raise KeyError, key

    def __delitem__(self, key):
        raise KeyError, key

    def __contains__(self, key):
        return False

    def __len__(self):
        return 0

    def __iter__(self):
        return ITER_EMPTY
    iterkeys = itervalues = iteritems = __iter__

cdef object IMMUTABLE_EMPTY_MAPPING = _ImmutableMapping()
del _ImmutableMapping


# the rules
# ---------
# any libxml C argument/variable is prefixed with c_
# any non-public function/class is prefixed with an underscore
# instance creation is always through factories

# what to do with libxml2/libxslt error messages?
# 0 : drop
# 1 : use log
DEF __DEBUG = 1

# maximum number of lines in the libxml2/xslt log if __DEBUG == 1
DEF __MAX_LOG_SIZE = 100

# make the compiled-in debug state publicly available
DEBUG = __DEBUG

# A struct to store a cached qualified tag name+href pair.
# While we can borrow the c_name from the document dict,
# PyPy requires us to store a Python reference for the
# namespace in order to keep the byte buffer alive.
cdef struct qname:
    const_xmlChar* c_name
    python.PyObject* href

# initialize parser (and threading)
xmlparser.xmlInitParser()

# global per-thread setup
tree.xmlThrDefIndentTreeOutput(1)
tree.xmlThrDefLineNumbersDefaultValue(1)

_initThreadLogging()

# filename encoding
cdef bytes _FILENAME_ENCODING = (sys.getfilesystemencoding() or sys.getdefaultencoding() or 'ascii').encode("UTF-8")
cdef char* _C_FILENAME_ENCODING = _cstr(_FILENAME_ENCODING)

# set up some default namespace prefixes
cdef dict _DEFAULT_NAMESPACE_PREFIXES = {
    b"http://www.w3.org/XML/1998/namespace": b'xml',
    b"http://www.w3.org/1999/xhtml": b"html",
    b"http://www.w3.org/1999/XSL/Transform": b"xsl",
    b"http://www.w3.org/1999/02/22-rdf-syntax-ns#": b"rdf",
    b"http://schemas.xmlsoap.org/wsdl/": b"wsdl",
    # xml schema
    b"http://www.w3.org/2001/XMLSchema": b"xs",
    b"http://www.w3.org/2001/XMLSchema-instance": b"xsi",
    # dublin core
    b"http://purl.org/dc/elements/1.1/": b"dc",
    # objectify
    b"http://codespeak.net/lxml/objectify/pytype" : b"py",
}

# To avoid runtime encoding overhead, we keep a Unicode copy
# of the uri-prefix mapping as (str, str) items view.
cdef object _DEFAULT_NAMESPACE_PREFIXES_ITEMS = []

cdef _update_default_namespace_prefixes_items():
    cdef bytes ns, prefix
    global _DEFAULT_NAMESPACE_PREFIXES_ITEMS
    _DEFAULT_NAMESPACE_PREFIXES_ITEMS = {
        ns.decode('utf-8') : prefix.decode('utf-8')
        for ns, prefix in _DEFAULT_NAMESPACE_PREFIXES.items()
    }.items()

_update_default_namespace_prefixes_items()

cdef object _check_internal_prefix = re.compile(br"ns\d+$").match

def register_namespace(prefix, uri):
    """Registers a namespace prefix that newly created Elements in that
    namespace will use.  The registry is global, and any existing
    mapping for either the given prefix or the namespace URI will be
    removed.
    """
    prefix_utf, uri_utf = _utf8(prefix), _utf8(uri)
    if _check_internal_prefix(prefix_utf):
        raise ValueError("Prefix format reserved for internal use")
    _tagValidOrRaise(prefix_utf)
    _uriValidOrRaise(uri_utf)
    if (uri_utf == b"http://www.w3.org/XML/1998/namespace" and prefix_utf != b'xml'
            or prefix_utf == b'xml' and uri_utf != b"http://www.w3.org/XML/1998/namespace"):
        raise ValueError("Cannot change the 'xml' prefix of the XML namespace")
    for k, v in list(_DEFAULT_NAMESPACE_PREFIXES.items()):
        if k == uri_utf or v == prefix_utf:
            del _DEFAULT_NAMESPACE_PREFIXES[k]
    _DEFAULT_NAMESPACE_PREFIXES[uri_utf] = prefix_utf
    _update_default_namespace_prefixes_items()


# Error superclass for ElementTree compatibility
cdef class Error(Exception):
    pass

# module level superclass for all exceptions
cdef class LxmlError(Error):
    """Main exception base class for lxml.  All other exceptions inherit from
    this one.
    """
    def __init__(self, message, error_log=None):
        super(_Error, self).__init__(message)
        if error_log is None:
            self.error_log = __copyGlobalErrorLog()
        else:
            self.error_log = error_log.copy()

cdef object _Error = Error


# superclass for all syntax errors
class LxmlSyntaxError(LxmlError, SyntaxError):
    """Base class for all syntax errors.
    """

cdef class C14NError(LxmlError):
    """Error during C14N serialisation.
    """

# version information
cdef tuple __unpackDottedVersion(version):
    version_list = []
    l = (version.decode("ascii").replace('-', '.').split('.') + [0]*4)[:4]
    for item in l:
        try:
            item = int(item)
        except ValueError:
            if item.startswith('dev'):
                count = item[3:]
                item = -300
            elif item.startswith('alpha'):
                count = item[5:]
                item = -200
            elif item.startswith('beta'):
                count = item[4:]
                item = -100
            else:
                count = 0
            if count:
                item += int(count)
        version_list.append(item)
    return tuple(version_list)

cdef tuple __unpackIntVersion(int c_version, int base=100):
    return (
        ((c_version // (base*base)) % base),
        ((c_version // base)        % base),
        (c_version                  % base)
        )

cdef int _LIBXML_VERSION_INT
try:
    _LIBXML_VERSION_INT = int(
        re.match('[0-9]+', (<unsigned char*>tree.xmlParserVersion).decode("ascii")).group(0))
except Exception:
    print("Unknown libxml2 version: " + (<unsigned char*>tree.xmlParserVersion).decode("latin1"))
    _LIBXML_VERSION_INT = 0

LIBXML_VERSION = __unpackIntVersion(_LIBXML_VERSION_INT)
LIBXML_COMPILED_VERSION = __unpackIntVersion(tree.LIBXML_VERSION)
LXML_VERSION = __unpackDottedVersion(tree.LXML_VERSION_STRING)

__version__ = tree.LXML_VERSION_STRING.decode("ascii")

cdef extern from *:
    """
    #ifdef ZLIB_VERNUM
      #define __lxml_zlib_version (ZLIB_VERNUM >> 4)
    #else
      #define __lxml_zlib_version 0
    #endif
    #ifdef _LIBICONV_VERSION
      #define __lxml_iconv_version (_LIBICONV_VERSION << 8)
    #else
      #define __lxml_iconv_version 0
    #endif
    """
    # zlib isn't included automatically by libxml2's headers
    #long ZLIB_HEX_VERSION "__lxml_zlib_version"
    long LIBICONV_HEX_VERSION "__lxml_iconv_version"

#ZLIB_COMPILED_VERSION = __unpackIntVersion(ZLIB_HEX_VERSION, base=0x10)
ICONV_COMPILED_VERSION = __unpackIntVersion(LIBICONV_HEX_VERSION, base=0x100)[:2]


cdef extern from "libxml/xmlversion.h":
    """
    static const char* const _lxml_lib_features[] = {
#ifdef LIBXML_HTML_ENABLED
        "html",
#endif
#ifdef LIBXML_FTP_ENABLED
        "ftp",
#endif
#ifdef LIBXML_HTTP_ENABLED
        "http",
#endif
#ifdef LIBXML_CATALOG_ENABLED
        "catalog",
#endif
#ifdef LIBXML_XPATH_ENABLED
        "xpath",
#endif
#ifdef LIBXML_ICONV_ENABLED
        "iconv",
#endif
#ifdef LIBXML_ICU_ENABLED
        "icu",
#endif
#ifdef LIBXML_REGEXP_ENABLED
        "regexp",
#endif
#ifdef LIBXML_SCHEMAS_ENABLED
        "xmlschema",
#endif
#ifdef LIBXML_SCHEMATRON_ENABLED
        "schematron",
#endif
#ifdef LIBXML_ZLIB_ENABLED
        "zlib",
#endif
#ifdef LIBXML_LZMA_ENABLED
        "lzma",
#endif
        0
    };
    """
    const char* const* _LXML_LIB_FEATURES "_lxml_lib_features"


cdef set _copy_lib_features():
    features = set()
    feature = _LXML_LIB_FEATURES
    while feature[0]:
        features.add(feature[0].decode('ASCII'))
        feature += 1
    return features

LIBXML_COMPILED_FEATURES = _copy_lib_features()
LIBXML_FEATURES = {
    feature_name for feature_id, feature_name in [
        #XML_WITH_THREAD = 1
        #XML_WITH_TREE = 2
        #XML_WITH_OUTPUT = 3
        #XML_WITH_PUSH = 4
        #XML_WITH_READER = 5
        #XML_WITH_PATTERN = 6
        #XML_WITH_WRITER = 7
        #XML_WITH_SAX1 = 8
        (xmlparser.XML_WITH_FTP, "ftp"),  # XML_WITH_FTP = 9
        (xmlparser.XML_WITH_HTTP, "http"),  # XML_WITH_HTTP = 10
        #XML_WITH_VALID = 11
        (xmlparser.XML_WITH_HTML, "html"),  # XML_WITH_HTML = 12
        #XML_WITH_LEGACY = 13
        #XML_WITH_C14N = 14
        (xmlparser.XML_WITH_CATALOG, "catalog"),  # XML_WITH_CATALOG = 15
        (xmlparser.XML_WITH_XPATH, "xpath"),  # XML_WITH_XPATH = 16
        #XML_WITH_XPTR = 17
        #XML_WITH_XINCLUDE = 18
        (xmlparser.XML_WITH_ICONV, "iconv"),  # XML_WITH_ICONV = 19
        #XML_WITH_ISO8859X = 20
        #XML_WITH_UNICODE = 21
        (xmlparser.XML_WITH_REGEXP, "regexp"),  # XML_WITH_REGEXP = 22
        #XML_WITH_AUTOMATA = 23
        #XML_WITH_EXPR = 24
        (xmlparser.XML_WITH_SCHEMAS, "xmlschema"),  # XML_WITH_SCHEMAS = 25
        (xmlparser.XML_WITH_SCHEMATRON, "schematron"),  # XML_WITH_SCHEMATRON = 26
        #XML_WITH_MODULES = 27
        #XML_WITH_DEBUG = 28
        #XML_WITH_DEBUG_MEM = 29
        #XML_WITH_DEBUG_RUN = 30  # unused
        (xmlparser.XML_WITH_ZLIB, "zlib"),  # XML_WITH_ZLIB = 31
        (xmlparser.XML_WITH_ICU, "icu"),  # XML_WITH_ICU = 32
        (xmlparser.XML_WITH_LZMA, "lzma"),  # XML_WITH_LZMA = 33
    ] if xmlparser.xmlHasFeature(feature_id)
}

cdef bint HAS_ZLIB_COMPRESSION = xmlparser.xmlHasFeature(xmlparser.XML_WITH_ZLIB)


# class for temporary storage of Python references,
# used e.g. for XPath results
@cython.final
@cython.internal
cdef class _TempStore:
    cdef list _storage
    def __init__(self):
        self._storage = []

    cdef int add(self, obj) except -1:
        self._storage.append(obj)
        return 0

    cdef int clear(self) except -1:
        del self._storage[:]
        return 0


# class for temporarily storing exceptions raised in extensions
@cython.internal
cdef class _ExceptionContext:
    cdef object _exc_info
    cdef int clear(self) except -1:
        self._exc_info = None
        return 0

    cdef void _store_raised(self) noexcept:
        try:
            self._exc_info = sys.exc_info()
        except BaseException as e:
            self._store_exception(e)
        finally:
            return  # and swallow any further exceptions

    cdef int _store_exception(self, exception) except -1:
        self._exc_info = (exception, None, None)
        return 0

    cdef bint _has_raised(self) except -1:
        return self._exc_info is not None

    cdef int _raise_if_stored(self) except -1:
        if self._exc_info is None:
            return 0
        type, value, traceback = self._exc_info
        self._exc_info = None
        if value is None and traceback is None:
            raise type
        else:
            raise type, value, traceback


# type of a function that steps from node to node
ctypedef public xmlNode* (*_node_to_node_function)(xmlNode*)


################################################################################
# Include submodules

include "proxy.pxi"        # Proxy handling (element backpointers/memory/etc.)
include "apihelpers.pxi"   # Private helper functions
include "xmlerror.pxi"     # Error and log handling


################################################################################
# Public Python API

@cython.final
@cython.freelist(8)
cdef public class _Document [ type LxmlDocumentType, object LxmlDocument ]:
    """Internal base class to reference a libxml document.

    When instances of this class are garbage collected, the libxml
    document is cleaned up.
    """
    cdef int _ns_counter
    cdef bytes _prefix_tail
    cdef xmlDoc* _c_doc
    cdef _BaseParser _parser

    def __dealloc__(self):
        # if there are no more references to the document, it is safe
        # to clean the whole thing up, as all nodes have a reference to
        # the document
        tree.xmlFreeDoc(self._c_doc)

    @cython.final
    cdef getroot(self):
        # return an element proxy for the document root
        cdef xmlNode* c_node
        c_node = tree.xmlDocGetRootElement(self._c_doc)
        if c_node is NULL:
            return None
        return _elementFactory(self, c_node)

    @cython.final
    cdef bint hasdoctype(self) noexcept:
        # DOCTYPE gets parsed into internal subset (xmlDTD*)
        return self._c_doc is not NULL and self._c_doc.intSubset is not NULL

    @cython.final
    cdef getdoctype(self):
        # get doctype info: root tag, public/system ID (or None if not known)
        cdef tree.xmlDtd* c_dtd
        cdef xmlNode* c_root_node
        public_id = None
        sys_url   = None
        c_dtd = self._c_doc.intSubset
        if c_dtd is not NULL:
            if c_dtd.ExternalID is not NULL:
                public_id = funicode(c_dtd.ExternalID)
            if c_dtd.SystemID is not NULL:
                sys_url = funicode(c_dtd.SystemID)
        c_dtd = self._c_doc.extSubset
        if c_dtd is not NULL:
            if not public_id and c_dtd.ExternalID is not NULL:
                public_id = funicode(c_dtd.ExternalID)
            if not sys_url and c_dtd.SystemID is not NULL:
                sys_url = funicode(c_dtd.SystemID)
        c_root_node = tree.xmlDocGetRootElement(self._c_doc)
        if c_root_node is NULL:
            root_name = None
        else:
            root_name = funicode(c_root_node.name)
        return root_name, public_id, sys_url

    @cython.final
    cdef getxmlinfo(self):
        # return XML version and encoding (or None if not known)
        cdef xmlDoc* c_doc = self._c_doc
        if c_doc.version is NULL:
            version = None
        else:
            version = funicode(c_doc.version)
        if c_doc.encoding is NULL:
            encoding = None
        else:
            encoding = funicode(c_doc.encoding)
        return version, encoding

    @cython.final
    cdef isstandalone(self):
        # returns True for "standalone=true",
        # False for "standalone=false", None if not provided
        if self._c_doc.standalone == -1:
            return None
        else:
            return <bint>(self._c_doc.standalone == 1)

    @cython.final
    cdef bytes buildNewPrefix(self):
        # get a new unique prefix ("nsX") for this document
        cdef bytes ns
        if self._ns_counter < len(_PREFIX_CACHE):
            ns = _PREFIX_CACHE[self._ns_counter]
        else:
            ns = python.PyBytes_FromFormat("ns%d", self._ns_counter)
        if self._prefix_tail is not None:
            ns += self._prefix_tail
        self._ns_counter += 1
        if self._ns_counter < 0:
            # overflow!
            self._ns_counter = 0
            if self._prefix_tail is None:
                self._prefix_tail = b"A"
            else:
                self._prefix_tail += b"A"
        return ns

    @cython.final
    cdef xmlNs* _findOrBuildNodeNs(self, xmlNode* c_node,
                                   const_xmlChar* c_href, const_xmlChar* c_prefix,
                                   bint is_attribute) except NULL:
        """Get or create namespace structure for a node.  Reuses the prefix if
        possible.
        """
        cdef xmlNs* c_ns
        cdef xmlNs* c_doc_ns
        cdef python.PyObject* dict_result
        if c_node.type != tree.XML_ELEMENT_NODE:
            assert c_node.type == tree.XML_ELEMENT_NODE, \
                "invalid node type %d, expected %d" % (
                c_node.type, tree.XML_ELEMENT_NODE)
        # look for existing ns declaration
        c_ns = _searchNsByHref(c_node, c_href, is_attribute)
        if c_ns is not NULL:
            if is_attribute and c_ns.prefix is NULL:
                # do not put namespaced attributes into the default
                # namespace as this would break serialisation
                pass
            else:
                return c_ns

        # none found => determine a suitable new prefix
        if c_prefix is NULL:
            dict_result = python.PyDict_GetItem(
                _DEFAULT_NAMESPACE_PREFIXES, <unsigned char*>c_href)
            if dict_result is not NULL:
                prefix = <object>dict_result
            else:
                prefix = self.buildNewPrefix()
            c_prefix = _xcstr(prefix)

        # make sure the prefix is not in use already
        while tree.xmlSearchNs(self._c_doc, c_node, c_prefix) is not NULL:
            prefix = self.buildNewPrefix()
            c_prefix = _xcstr(prefix)

        # declare the namespace and return it
        c_ns = tree.xmlNewNs(c_node, c_href, c_prefix)
        if c_ns is NULL:
            raise MemoryError()
        return c_ns

    @cython.final
    cdef int _setNodeNs(self, xmlNode* c_node, const_xmlChar* c_href) except -1:
        "Lookup namespace structure and set it for the node."
        c_ns = self._findOrBuildNodeNs(c_node, c_href, NULL, 0)
        tree.xmlSetNs(c_node, c_ns)


cdef tuple __initPrefixCache():
    cdef int i
    return tuple([ python.PyBytes_FromFormat("ns%d", i)
                   for i in range(26) ])

cdef tuple _PREFIX_CACHE = __initPrefixCache()


cdef _Document _documentFactory(xmlDoc* c_doc, _BaseParser parser):
    cdef _Document result
    result = _Document.__new__(_Document)
    result._c_doc = c_doc
    result._ns_counter = 0
    result._prefix_tail = None
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
    result._parser = parser
    return result


cdef object _find_invalid_public_id_characters = re.compile(
    ur"[^\x20\x0D\x0Aa-zA-Z0-9'()+,./:=?;!*#@$_%-]+").search


cdef class DocInfo:
    "Document information provided by parser and DTD."
    cdef _Document _doc
    def __cinit__(self, tree):
        "Create a DocInfo object for an ElementTree object or root Element."
        self._doc = _documentOrRaise(tree)
        root_name, public_id, system_url = self._doc.getdoctype()
        if not root_name and (public_id or system_url):
            raise ValueError, "Could not find root node"

    @property
    def root_name(self):
        """Returns the name of the root node as defined by the DOCTYPE."""
        root_name, public_id, system_url = self._doc.getdoctype()
        return root_name

    @cython.final
    cdef tree.xmlDtd* _get_c_dtd(self):
        """"Return the DTD. Create it if it does not yet exist."""
        cdef xmlDoc* c_doc = self._doc._c_doc
        cdef xmlNode* c_root_node
        cdef const_xmlChar* c_name

        if c_doc.intSubset:
            return c_doc.intSubset

        c_root_node = tree.xmlDocGetRootElement(c_doc)
        c_name = c_root_node.name if c_root_node else NULL
        return  tree.xmlCreateIntSubset(c_doc, c_name, NULL, NULL)

    def clear(self):
        """Removes DOCTYPE and internal subset from the document."""
        cdef xmlDoc* c_doc = self._doc._c_doc
        cdef tree.xmlNode* c_dtd = <xmlNode*>c_doc.intSubset
        if c_dtd is NULL:
            return
        tree.xmlUnlinkNode(c_dtd)
        tree.xmlFreeNode(c_dtd)

    property public_id:
        """Public ID of the DOCTYPE.

        Mutable.  May be set to a valid string or None.  If a DTD does not
        exist, setting this variable (even to None) will create one.
        """
        def __get__(self):
            root_name, public_id, system_url = self._doc.getdoctype()
            return public_id

        def __set__(self, value):
            cdef xmlChar* c_value = NULL
            if value is not None:
                match = _find_invalid_public_id_characters(value)
                if match:
                    raise ValueError, f'Invalid character(s) {match.group(0)!r} in public_id.'
                value = _utf8(value)
                c_value = tree.xmlStrdup(_xcstr(value))
                if not c_value:
                    raise MemoryError()

            c_dtd = self._get_c_dtd()
            if not c_dtd:
                tree.xmlFree(c_value)
                raise MemoryError()
            if c_dtd.ExternalID:
                tree.xmlFree(<void*>c_dtd.ExternalID)
            c_dtd.ExternalID = c_value

    property system_url:
        """System ID of the DOCTYPE.

        Mutable.  May be set to a valid string or None.  If a DTD does not
        exist, setting this variable (even to None) will create one.
        """
        def __get__(self):
            root_name, public_id, system_url = self._doc.getdoctype()
            return system_url

        def __set__(self, value):
            cdef xmlChar* c_value = NULL
            if value is not None:
                bvalue = _utf8(value)
                # sys_url may be any valid unicode string that can be
                # enclosed in single quotes or quotes.
                if b"'" in bvalue and b'"' in bvalue:
                    raise ValueError(
                        'System URL may not contain both single (\') and double quotes (").')
                c_value = tree.xmlStrdup(_xcstr(bvalue))
                if not c_value:
                    raise MemoryError()

            c_dtd = self._get_c_dtd()
            if not c_dtd:
                tree.xmlFree(c_value)
                raise MemoryError()
            if c_dtd.SystemID:
                tree.xmlFree(<void*>c_dtd.SystemID)
            c_dtd.SystemID = c_value

    @property
    def xml_version(self):
        """Returns the XML version as declared by the document."""
        xml_version, encoding = self._doc.getxmlinfo()
        return xml_version

    @property
    def encoding(self):
        """Returns the encoding name as declared by the document."""
        xml_version, encoding = self._doc.getxmlinfo()
        return encoding

    @property
    def standalone(self):
        """Returns the standalone flag as declared by the document.  The possible
        values are True (``standalone='yes'``), False
        (``standalone='no'`` or flag not provided in the declaration),
        and None (unknown or no declaration found).  Note that a
        normal truth test on this value will always tell if the
        ``standalone`` flag was set to ``'yes'`` or not.
        """
        return self._doc.isstandalone()

    property URL:
        "The source URL of the document (or None if unknown)."
        def __get__(self):
            if self._doc._c_doc.URL is NULL:
                return None
            return _decodeFilename(self._doc._c_doc.URL)
        def __set__(self, url):
            url = _encodeFilename(url)
            c_oldurl = self._doc._c_doc.URL
            if url is None:
                self._doc._c_doc.URL = NULL
            else:
                self._doc._c_doc.URL = tree.xmlStrdup(_xcstr(url))
            if c_oldurl is not NULL:
                tree.xmlFree(<void*>c_oldurl)

    @property
    def doctype(self):
        """Returns a DOCTYPE declaration string for the document."""
        root_name, public_id, system_url = self._doc.getdoctype()
        if system_url:
            # If '"' in system_url, we must escape it with single
            # quotes, otherwise escape with double quotes. If url
            # contains both a single quote and a double quote, XML
            # standard is being violated.
            if '"' in system_url:
                quoted_system_url = f"'{system_url}'"
            else:
                quoted_system_url = f'"{system_url}"'
        if public_id:
            if system_url:
                return f'<!DOCTYPE {root_name} PUBLIC "{public_id}" {quoted_system_url}>'
            else:
                return f'<!DOCTYPE {root_name} PUBLIC "{public_id}">'
        elif system_url:
            return f'<!DOCTYPE {root_name} SYSTEM {quoted_system_url}>'
        elif self._doc.hasdoctype():
            return f'<!DOCTYPE {root_name}>'
        else:
            return ''

    @property
    def internalDTD(self):
        """Returns a DTD validator based on the internal subset of the document."""
        return _dtdFactory(self._doc._c_doc.intSubset)

    @property
    def externalDTD(self):
        """Returns a DTD validator based on the external subset of the document."""
        return _dtdFactory(self._doc._c_doc.extSubset)


@cython.no_gc_clear
cdef public class _Element [ type LxmlElementType, object LxmlElement ]:
    """Element class.

    References a document object and a libxml node.

    By pointing to a Document instance, a reference is kept to
    _Document as long as there is some pointer to a node in it.
    """
    cdef _Document _doc
    cdef xmlNode* _c_node
    cdef object _tag

    def _init(self):
        """_init(self)

        Called after object initialisation.  Custom subclasses may override
        this if they recursively call _init() in the superclasses.
        """

    @cython.linetrace(False)
    @cython.profile(False)
    def __dealloc__(self):
        #print("trying to free node:", <int>self._c_node)
        #displayNode(self._c_node, 0)
        if self._c_node is not NULL:
            _unregisterProxy(self)
            attemptDeallocation(self._c_node)

    # MANIPULATORS

    def __setitem__(self, x, value):
        """__setitem__(self, x, value)

        Replaces the given subelement index or slice.
        """
        cdef xmlNode* c_node = NULL
        cdef xmlNode* c_next
        cdef xmlDoc* c_source_doc
        cdef _Element element
        cdef bint left_to_right
        cdef Py_ssize_t slicelength = 0, step = 0
        _assertValidNode(self)
        if value is None:
            raise ValueError, "cannot assign None"
        if isinstance(x, slice):
            # slice assignment
            _findChildSlice(<slice>x, self._c_node, &c_node, &step, &slicelength)
            if step > 0:
                left_to_right = 1
            else:
                left_to_right = 0
                step = -step
            _replaceSlice(self, c_node, slicelength, step, left_to_right, value)
            return
        else:
            # otherwise: normal item assignment
            element = value
            _assertValidNode(element)
            c_node = _findChild(self._c_node, x)
            if c_node is NULL:
                raise IndexError, "list index out of range"
            c_source_doc = element._c_node.doc
            c_next = element._c_node.next
            _removeText(c_node.next)
            tree.xmlReplaceNode(c_node, element._c_node)
            _moveTail(c_next, element._c_node)
            moveNodeToDocument(self._doc, c_source_doc, element._c_node)
            if not attemptDeallocation(c_node):
                moveNodeToDocument(self._doc, c_node.doc, c_node)

    def __delitem__(self, x):
        """__delitem__(self, x)

        Deletes the given subelement or a slice.
        """
        cdef xmlNode* c_node = NULL
        cdef xmlNode* c_next
        cdef Py_ssize_t step = 0, slicelength = 0
        _assertValidNode(self)
        if isinstance(x, slice):
            # slice deletion
            if _isFullSlice(<slice>x):
                c_node = self._c_node.children
                if c_node is not NULL:
                    if not _isElement(c_node):
                        c_node = _nextElement(c_node)
                    while c_node is not NULL:
                        c_next = _nextElement(c_node)
                        _removeNode(self._doc, c_node)
                        c_node = c_next
            else:
                _findChildSlice(<slice>x, self._c_node, &c_node, &step, &slicelength)
                _deleteSlice(self._doc, c_node, slicelength, step)
        else:
            # item deletion
            c_node = _findChild(self._c_node, x)
            if c_node is NULL:
                raise IndexError, f"index out of range: {x}"
            _removeNode(self._doc, c_node)

    def __deepcopy__(self, memo):
        "__deepcopy__(self, memo)"
        return self.__copy__()

    def __copy__(self):
        "__copy__(self)"
        cdef xmlDoc* c_doc
        cdef xmlNode* c_node
        cdef _Document new_doc
        _assertValidNode(self)
        c_doc = _copyDocRoot(self._doc._c_doc, self._c_node) # recursive
        new_doc = _documentFactory(c_doc, self._doc._parser)
        root = new_doc.getroot()
        if root is not None:
            return root
        # Comment/PI
        c_node = c_doc.children
        while c_node is not NULL and c_node.type != self._c_node.type:
            c_node = c_node.next
        if c_node is NULL:
            return None
        return _elementFactory(new_doc, c_node)

    def set(self, key, value):
        """set(self, key, value)

        Sets an element attribute.
        In HTML documents (not XML or XHTML), the value None is allowed and creates
        an attribute without value (just the attribute name).
        """
        _assertValidNode(self)
        _setAttributeValue(self, key, value)

    def append(self, _Element element not None):
        """append(self, element)

        Adds a subelement to the end of this element.
        """
        _assertValidNode(self)
        _assertValidNode(element)
        _appendChild(self, element)

    def addnext(self, _Element element not None):
        """addnext(self, element)

        Adds the element as a following sibling directly after this
        element.

        This is normally used to set a processing instruction or comment after
        the root node of a document.  Note that tail text is automatically
        discarded when adding at the root level.
        """
        _assertValidNode(self)
        _assertValidNode(element)
        if self._c_node.parent != NULL and not _isElement(self._c_node.parent):
            if element._c_node.type not in (tree.XML_PI_NODE, tree.XML_COMMENT_NODE):
                raise TypeError, "Only processing instructions and comments can be siblings of the root element"
            element.tail = None
        _appendSibling(self, element)

    def addprevious(self, _Element element not None):
        """addprevious(self, element)

        Adds the element as a preceding sibling directly before this
        element.

        This is normally used to set a processing instruction or comment
        before the root node of a document.  Note that tail text is
        automatically discarded when adding at the root level.
        """
        _assertValidNode(self)
        _assertValidNode(element)
        if self._c_node.parent != NULL and not _isElement(self._c_node.parent):
            if element._c_node.type != tree.XML_PI_NODE:
                if element._c_node.type != tree.XML_COMMENT_NODE:
                    raise TypeError, "Only processing instructions and comments can be siblings of the root element"
            element.tail = None
        _prependSibling(self, element)

    def extend(self, elements):
        """extend(self, elements)

        Extends the current children by the elements in the iterable.
        """
        cdef _Element element
        _assertValidNode(self)
        for element in elements:
            if element is None:
                raise TypeError, "Node must not be None"
            _assertValidNode(element)
            _appendChild(self, element)

    def clear(self, bint keep_tail=False):
        """clear(self, keep_tail=False)

        Resets an element.  This function removes all subelements, clears
        all attributes and sets the text and tail properties to None.

        Pass ``keep_tail=True`` to leave the tail text untouched.
        """
        cdef xmlAttr* c_attr
        cdef xmlAttr* c_attr_next
        cdef xmlNode* c_node
        cdef xmlNode* c_node_next
        _assertValidNode(self)
        c_node = self._c_node
        # remove self.text and self.tail
        _removeText(c_node.children)
        if not keep_tail:
            _removeText(c_node.next)
        # remove all attributes
        c_attr = c_node.properties
        if c_attr:
            c_node.properties = NULL
            tree.xmlFreePropList(c_attr)
        # remove all subelements
        c_node = c_node.children
        if c_node and not _isElement(c_node):
            c_node = _nextElement(c_node)
        while c_node is not NULL:
            c_node_next = _nextElement(c_node)
            _removeNode(self._doc, c_node)
            c_node = c_node_next

    def insert(self, index: int, _Element element not None):
        """insert(self, index, element)

        Inserts a subelement at the given position in this element
        """
        cdef xmlNode* c_node
        cdef xmlNode* c_next
        cdef xmlDoc* c_source_doc
        _assertValidNode(self)
        _assertValidNode(element)
        c_node = _findChild(self._c_node, index)
        if c_node is NULL:
            _appendChild(self, element)
            return
        # prevent cycles
        if _isAncestorOrSame(element._c_node, self._c_node):
            raise ValueError("cannot append parent to itself")
        c_source_doc = element._c_node.doc
        c_next = element._c_node.next
        tree.xmlAddPrevSibling(c_node, element._c_node)
        _moveTail(c_next, element._c_node)
        moveNodeToDocument(self._doc, c_source_doc, element._c_node)

    def remove(self, _Element element not None):
        """remove(self, element)

        Removes a matching subelement. Unlike the find methods, this
        method compares elements based on identity, not on tag value
        or contents.
        """
        cdef xmlNode* c_node
        cdef xmlNode* c_next
        _assertValidNode(self)
        _assertValidNode(element)
        c_node = element._c_node
        if c_node.parent is not self._c_node:
            raise ValueError, "Element is not a child of this node."
        c_next = element._c_node.next
        tree.xmlUnlinkNode(c_node)
        _moveTail(c_next, c_node)
        # fix namespace declarations
        moveNodeToDocument(self._doc, c_node.doc, c_node)

    def replace(self, _Element old_element not None,
                _Element new_element not None):
        """replace(self, old_element, new_element)

        Replaces a subelement with the element passed as second argument.
        """
        cdef xmlNode* c_old_node
        cdef xmlNode* c_old_next
        cdef xmlNode* c_new_node
        cdef xmlNode* c_new_next
        cdef xmlDoc* c_source_doc
        _assertValidNode(self)
        _assertValidNode(old_element)
        _assertValidNode(new_element)
        c_old_node = old_element._c_node
        if c_old_node.parent is not self._c_node:
            raise ValueError, "Element is not a child of this node."
        c_new_node = new_element._c_node
        # prevent cycles
        if _isAncestorOrSame(c_new_node, self._c_node):
            raise ValueError("cannot append parent to itself")
        # replace node
        c_old_next = c_old_node.next
        c_new_next = c_new_node.next
        c_source_doc = c_new_node.doc
        tree.xmlReplaceNode(c_old_node, c_new_node)
        _moveTail(c_new_next, c_new_node)
        _moveTail(c_old_next, c_old_node)
        moveNodeToDocument(self._doc, c_source_doc, c_new_node)
        # fix namespace declarations
        moveNodeToDocument(self._doc, c_old_node.doc, c_old_node)

    # PROPERTIES
    property tag:
        """Element tag
        """
        def __get__(self):
            if self._tag is not None:
                return self._tag
            _assertValidNode(self)
            self._tag = _namespacedName(self._c_node)
            return self._tag

        def __set__(self, value):
            cdef _BaseParser parser
            _assertValidNode(self)
            ns, name = _getNsTag(value)
            parser = self._doc._parser
            if parser is not None and parser._for_html:
                _htmlTagValidOrRaise(name)
            else:
                _tagValidOrRaise(name)
            self._tag = value
            tree.xmlNodeSetName(self._c_node, _xcstr(name))
            if ns is None:
                self._c_node.ns = NULL
            else:
                self._doc._setNodeNs(self._c_node, _xcstr(ns))

    @property
    def attrib(self):
        """Element attribute dictionary. Where possible, use get(), set(),
        keys(), values() and items() to access element attributes.
        """
        return _Attrib.__new__(_Attrib, self)

    property text:
        """Text before the first subelement. This is either a string or
        the value None, if there was no text.
        """
        def __get__(self):
            _assertValidNode(self)
            return _collectText(self._c_node.children)

        def __set__(self, value):
            _assertValidNode(self)
            if isinstance(value, QName):
                value = _resolveQNameText(self, value).decode('utf8')
            _setNodeText(self._c_node, value)

        # using 'del el.text' is the wrong thing to do
        #def __del__(self):
        #    _setNodeText(self._c_node, None)

    property tail:
        """Text after this element's end tag, but before the next sibling
        element's start tag. This is either a string or the value None, if
        there was no text.
        """
        def __get__(self):
            _assertValidNode(self)
            return _collectText(self._c_node.next)

        def __set__(self, value):
            _assertValidNode(self)
            _setTailText(self._c_node, value)

        # using 'del el.tail' is the wrong thing to do
        #def __del__(self):
        #    _setTailText(self._c_node, None)

    # not in ElementTree, read-only
    @property
    def prefix(self):
        """Namespace prefix or None.
        """
        if self._c_node.ns is not NULL:
            if self._c_node.ns.prefix is not NULL:
                return funicode(self._c_node.ns.prefix)
        return None

    # not in ElementTree, read-only
    property sourceline:
        """Original line number as found by the parser or None if unknown.
        """
        def __get__(self):
            cdef long line
            _assertValidNode(self)
            line = tree.xmlGetLineNo(self._c_node)
            return line if line > 0 else None

        def __set__(self, line):
            _assertValidNode(self)
            if line <= 0:
                self._c_node.line = 0
            else:
                self._c_node.line = line

    # not in ElementTree, read-only
    @property
    def nsmap(self):
        """Namespace prefix->URI mapping known in the context of this
        Element.  This includes all namespace declarations of the
        parents.

        Note that changing the returned dict has no effect on the Element.
        """
        _assertValidNode(self)
        return _build_nsmap(self._c_node)

    # not in ElementTree, read-only
    property base:
        """The base URI of the Element (xml:base or HTML base URL).
        None if the base URI is unknown.

        Note that the value depends on the URL of the document that
        holds the Element if there is no xml:base attribute on the
        Element or its ancestors.

        Setting this property will set an xml:base attribute on the
        Element, regardless of the document type (XML or HTML).
        """
        def __get__(self):
            _assertValidNode(self)
            c_base = tree.xmlNodeGetBase(self._doc._c_doc, self._c_node)
            if c_base is NULL:
                if self._doc._c_doc.URL is NULL:
                    return None
                return _decodeFilename(self._doc._c_doc.URL)
            try:
                base = _decodeFilename(c_base)
            finally:
                tree.xmlFree(c_base)
            return base

        def __set__(self, url):
            _assertValidNode(self)
            if url is None:
                c_base = <const_xmlChar*>NULL
            else:
                url = _encodeFilename(url)
                c_base = _xcstr(url)
            tree.xmlNodeSetBase(self._c_node, c_base)

    # ACCESSORS
    def __repr__(self):
        "__repr__(self)"
        return "<Element %s at 0x%x>" % (self.tag, id(self))

    def __getitem__(self, x):
        """Returns the subelement at the given position or the requested
        slice.
        """
        cdef xmlNode* c_node = NULL
        cdef Py_ssize_t step = 0, slicelength = 0
        cdef Py_ssize_t c, i
        cdef _node_to_node_function next_element
        cdef list result
        _assertValidNode(self)
        if isinstance(x, slice):
            # slicing
            if _isFullSlice(<slice>x):
                return _collectChildren(self)
            _findChildSlice(<slice>x, self._c_node, &c_node, &step, &slicelength)
            if c_node is NULL:
                return []
            if step > 0:
                next_element = _nextElement
            else:
                step = -step
                next_element = _previousElement
            result = []
            c = 0
            while c_node is not NULL and c < slicelength:
                result.append(_elementFactory(self._doc, c_node))
                c += 1
                for i in range(step):
                    c_node = next_element(c_node)
                    if c_node is NULL:
                        break
            return result
        else:
            # indexing
            c_node = _findChild(self._c_node, x)
            if c_node is NULL:
                raise IndexError, "list index out of range"
            return _elementFactory(self._doc, c_node)

    def __len__(self):
        """__len__(self)

        Returns the number of subelements.
        """
        _assertValidNode(self)
        return _countElements(self._c_node.children)

    def __bool__(self):
        """__bool__(self)"""
        import warnings
        warnings.warn(
            "Truth-testing of elements was a source of confusion and will always "
            "return True in future versions. "
            "Use specific 'len(elem)' or 'elem is not None' test instead.",
            FutureWarning
            )
        # emulate old behaviour
        _assertValidNode(self)
        return _hasChild(self._c_node)

    def __contains__(self, element):
        "__contains__(self, element)"
        cdef xmlNode* c_node
        _assertValidNode(self)
        if not isinstance(element, _Element):
            return 0
        c_node = (<_Element>element)._c_node
        return c_node is not NULL and c_node.parent is self._c_node

    def __iter__(self):
        "__iter__(self)"
        return ElementChildIterator(self)

    def __reversed__(self):
        "__reversed__(self)"
        return ElementChildIterator(self, reversed=True)

    def index(self, child: _Element, start: int = None, stop: int = None):
        """index(self, child, start=None, stop=None)

        Find the position of the child within the parent.

        This method is not part of the original ElementTree API.
        """
        cdef Py_ssize_t k, l
        cdef Py_ssize_t c_start, c_stop
        cdef xmlNode* c_child
        cdef xmlNode* c_start_node
        _assertValidNode(self)
        _assertValidNode(child)
        c_child = child._c_node
        if c_child.parent is not self._c_node:
            raise ValueError, "Element is not a child of this node."

        # handle the unbounded search straight away (normal case)
        if stop is None and (start is None or start == 0):
            k = 0
            c_child = c_child.prev
            while c_child is not NULL:
                if _isElement(c_child):
                    k += 1
                c_child = c_child.prev
            return k

        # check indices
        if start is None:
            c_start = 0
        else:
            c_start = start
        if stop is None:
            c_stop = 0
        else:
            c_stop = stop
            if c_stop == 0 or \
                   c_start >= c_stop and (c_stop > 0 or c_start < 0):
                raise ValueError, "list.index(x): x not in slice"

        # for negative slice indices, check slice before searching index
        if c_start < 0 or c_stop < 0:
            # start from right, at most up to leftmost(c_start, c_stop)
            if c_start < c_stop:
                k = -c_start
            else:
                k = -c_stop
            c_start_node = self._c_node.last
            l = 1
            while c_start_node != c_child and l < k:
                if _isElement(c_start_node):
                    l += 1
                c_start_node = c_start_node.prev
            if c_start_node == c_child:
                # found! before slice end?
                if c_stop < 0 and l <= -c_stop:
                    raise ValueError, "list.index(x): x not in slice"
            elif c_start < 0:
                raise ValueError, "list.index(x): x not in slice"

        # now determine the index backwards from child
        c_child = c_child.prev
        k = 0
        if c_stop > 0:
            # we can optimize: stop after c_stop elements if not found
            while c_child != NULL and k < c_stop:
                if _isElement(c_child):
                    k += 1
                c_child = c_child.prev
            if k < c_stop:
                return k
        else:
            # traverse all
            while c_child != NULL:
                if _isElement(c_child):
                    k = k + 1
                c_child = c_child.prev
            if c_start > 0:
                if k >= c_start:
                    return k
            else:
                return k
        if c_start != 0 or c_stop != 0:
            raise ValueError, "list.index(x): x not in slice"
        else:
            raise ValueError, "list.index(x): x not in list"

    def get(self, key, default=None):
        """get(self, key, default=None)

        Gets an element attribute.
        """
        _assertValidNode(self)
        return _getAttributeValue(self, key, default)

    def keys(self):
        """keys(self)

        Gets a list of attribute names.  The names are returned in an
        arbitrary order (just like for an ordinary Python dictionary).
        """
        _assertValidNode(self)
        return _collectAttributes(self._c_node, 1)

    def values(self):
        """values(self)

        Gets element attribute values as a sequence of strings.  The
        attributes are returned in an arbitrary order.
        """
        _assertValidNode(self)
        return _collectAttributes(self._c_node, 2)

    def items(self):
        """items(self)

        Gets element attributes, as a sequence. The attributes are returned in
        an arbitrary order.
        """
        _assertValidNode(self)
        return _collectAttributes(self._c_node, 3)

    def getchildren(self):
        """getchildren(self)

        Returns all direct children.  The elements are returned in document
        order.

        :deprecated: Note that this method has been deprecated as of
          ElementTree 1.3 and lxml 2.0.  New code should use
          ``list(element)`` or simply iterate over elements.
        """
        _assertValidNode(self)
        return _collectChildren(self)

    def getparent(self):
        """getparent(self)

        Returns the parent of this element or None for the root element.
        """
        cdef xmlNode* c_node
        #_assertValidNode(self) # not needed
        c_node = _parentElement(self._c_node)
        if c_node is NULL:
            return None
        return _elementFactory(self._doc, c_node)

    def getnext(self):
        """getnext(self)

        Returns the following sibling of this element or None.
        """
        cdef xmlNode* c_node
        #_assertValidNode(self) # not needed
        c_node = _nextElement(self._c_node)
        if c_node is NULL:
            return None
        return _elementFactory(self._doc, c_node)

    def getprevious(self):
        """getprevious(self)

        Returns the preceding sibling of this element or None.
        """
        cdef xmlNode* c_node
        #_assertValidNode(self) # not needed
        c_node = _previousElement(self._c_node)
        if c_node is NULL:
            return None
        return _elementFactory(self._doc, c_node)

    def itersiblings(self, tag=None, *tags, preceding=False):
        """itersiblings(self, tag=None, *tags, preceding=False)

        Iterate over the following or preceding siblings of this element.

        The direction is determined by the 'preceding' keyword which
        defaults to False, i.e. forward iteration over the following
        siblings.  When True, the iterator yields the preceding
        siblings in reverse document order, i.e. starting right before
        the current element and going backwards.

        Can be restricted to find only elements with specific tags,
        see `iter`.
        """
        if preceding:
            if self._c_node and not self._c_node.prev:
                return ITER_EMPTY
        elif self._c_node and not self._c_node.next:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return SiblingsIterator(self, tags, preceding=preceding)

    def iterancestors(self, tag=None, *tags):
        """iterancestors(self, tag=None, *tags)

        Iterate over the ancestors of this element (from parent to parent).

        Can be restricted to find only elements with specific tags,
        see `iter`.
        """
        if self._c_node and not self._c_node.parent:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return AncestorsIterator(self, tags)

    def iterdescendants(self, tag=None, *tags):
        """iterdescendants(self, tag=None, *tags)

        Iterate over the descendants of this element in document order.

        As opposed to ``el.iter()``, this iterator does not yield the element
        itself.  The returned elements can be restricted to find only elements
        with specific tags, see `iter`.
        """
        if self._c_node and not self._c_node.children:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return ElementDepthFirstIterator(self, tags, inclusive=False)

    def iterchildren(self, tag=None, *tags, reversed=False):
        """iterchildren(self, tag=None, *tags, reversed=False)

        Iterate over the children of this element.

        As opposed to using normal iteration on this element, the returned
        elements can be reversed with the 'reversed' keyword and restricted
        to find only elements with specific tags, see `iter`.
        """
        if self._c_node and not self._c_node.children:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return ElementChildIterator(self, tags, reversed=reversed)

    def getroottree(self):
        """getroottree(self)

        Return an ElementTree for the root node of the document that
        contains this element.

        This is the same as following element.getparent() up the tree until it
        returns None (for the root element) and then build an ElementTree for
        the last parent that was returned."""
        _assertValidDoc(self._doc)
        return _elementTreeFactory(self._doc, None)

    def getiterator(self, tag=None, *tags):
        """getiterator(self, tag=None, *tags)

        Returns a sequence or iterator of all elements in the subtree in
        document order (depth first pre-order), starting with this
        element.

        Can be restricted to find only elements with specific tags,
        see `iter`.

        :deprecated: Note that this method is deprecated as of
          ElementTree 1.3 and lxml 2.0.  It returns an iterator in
          lxml, which diverges from the original ElementTree
          behaviour.  If you want an efficient iterator, use the
          ``element.iter()`` method instead.  You should only use this
          method in new code if you require backwards compatibility
          with older versions of lxml or ElementTree.
        """
        if tag is not None:
            tags += (tag,)
        return ElementDepthFirstIterator(self, tags)

    def iter(self, tag=None, *tags):
        """iter(self, tag=None, *tags)

        Iterate over all elements in the subtree in document order (depth
        first pre-order), starting with this element.

        Can be restricted to find only elements with specific tags:
        pass ``"{ns}localname"`` as tag. Either or both of ``ns`` and
        ``localname`` can be ``*`` for a wildcard; ``ns`` can be empty
        for no namespace. ``"localname"`` is equivalent to ``"{}localname"``
        (i.e. no namespace) but ``"*"`` is ``"{*}*"`` (any or no namespace),
        not ``"{}*"``.

        You can also pass the Element, Comment, ProcessingInstruction and
        Entity factory functions to look only for the specific element type.

        Passing multiple tags (or a sequence of tags) instead of a single tag
        will let the iterator return all elements matching any of these tags,
        in document order.
        """
        if tag is not None:
            tags += (tag,)
        return ElementDepthFirstIterator(self, tags)

    def itertext(self, tag=None, *tags, with_tail=True):
        """itertext(self, tag=None, *tags, with_tail=True)

        Iterates over the text content of a subtree.

        You can pass tag names to restrict text content to specific elements,
        see `iter`.

        You can set the ``with_tail`` keyword argument to ``False`` to skip
        over tail text.
        """
        if tag is not None:
            tags += (tag,)
        return ElementTextIterator(self, tags, with_tail=with_tail)

    def makeelement(self, _tag, attrib=None, nsmap=None, **_extra):
        """makeelement(self, _tag, attrib=None, nsmap=None, **_extra)

        Creates a new element associated with the same document.
        """
        _assertValidDoc(self._doc)
        return _makeElement(_tag, NULL, self._doc, None, None, None,
                            attrib, nsmap, _extra)

    def find(self, path, namespaces=None):
        """find(self, path, namespaces=None)

        Finds the first matching subelement, by tag name or path.

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        if isinstance(path, QName):
            path = (<QName>path).text
        return _elementpath.find(self, path, namespaces, with_prefixes=not _isHtmlDocument(self))

    def findtext(self, path, default=None, namespaces=None):
        """findtext(self, path, default=None, namespaces=None)

        Finds text for the first matching subelement, by tag name or path.

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        if isinstance(path, QName):
            path = (<QName>path).text
        return _elementpath.findtext(self, path, default, namespaces, with_prefixes=not _isHtmlDocument(self))

    def findall(self, path, namespaces=None):
        """findall(self, path, namespaces=None)

        Finds all matching subelements, by tag name or path.

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        if isinstance(path, QName):
            path = (<QName>path).text
        return _elementpath.findall(self, path, namespaces, with_prefixes=not _isHtmlDocument(self))

    def iterfind(self, path, namespaces=None):
        """iterfind(self, path, namespaces=None)

        Iterates over all matching subelements, by tag name or path.

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        if isinstance(path, QName):
            path = (<QName>path).text
        return _elementpath.iterfind(self, path, namespaces, with_prefixes=not _isHtmlDocument(self))

    def xpath(self, _path, *, namespaces=None, extensions=None,
              smart_strings=True, **_variables):
        """xpath(self, _path, namespaces=None, extensions=None, smart_strings=True, **_variables)

        Evaluate an xpath expression using the element as context node.
        """
        evaluator = XPathElementEvaluator(self, namespaces=namespaces,
                                          extensions=extensions,
                                          smart_strings=smart_strings)
        return evaluator(_path, **_variables)

    def cssselect(self, expr, *, translator='xml'):
        """
        Run the CSS expression on this element and its children,
        returning a list of the results.

        Equivalent to lxml.cssselect.CSSSelect(expr)(self) -- note
        that pre-compiling the expression can provide a substantial
        speedup.
        """
        # Do the import here to make the dependency optional.
        from lxml.cssselect import CSSSelector
        return CSSSelector(expr, translator=translator)(self)


@cython.linetrace(False)
cdef _Element _elementFactory(_Document doc, xmlNode* c_node):
    cdef _Element result
    result = getProxy(c_node)
    if result is not None:
        return result
    if c_node is NULL:
        return None

    element_class = <type> LOOKUP_ELEMENT_CLASS(
        ELEMENT_CLASS_LOOKUP_STATE, doc, c_node)
    if type(element_class) is not type:
        if not isinstance(element_class, type):
            raise TypeError(f"Element class is not a type, got {type(element_class)}")
    if hasProxy(c_node):
        # prevent re-entry race condition - we just called into Python
        return getProxy(c_node)
    result = element_class.__new__(element_class)
    if hasProxy(c_node):
        # prevent re-entry race condition - we just called into Python
        result._c_node = NULL
        return getProxy(c_node)

    _registerProxy(result, doc, c_node)
    if element_class is not _Element:
        result._init()
    return result


@cython.internal
cdef class __ContentOnlyElement(_Element):
    cdef int _raiseImmutable(self) except -1:
        raise TypeError, "this element does not have children or attributes"

    def set(self, key, value):
        "set(self, key, value)"
        self._raiseImmutable()

    def append(self, value):
        "append(self, value)"
        self._raiseImmutable()

    def insert(self, index, value):
        "insert(self, index, value)"
        self._raiseImmutable()

    def __setitem__(self, index, value):
        "__setitem__(self, index, value)"
        self._raiseImmutable()

    @property
    def attrib(self):
        return IMMUTABLE_EMPTY_MAPPING

    property text:
        def __get__(self):
            _assertValidNode(self)
            return funicodeOrEmpty(self._c_node.content)

        def __set__(self, value):
            cdef tree.xmlDict* c_dict
            _assertValidNode(self)
            if value is None:
                c_text = <const_xmlChar*>NULL
            else:
                value = _utf8(value)
                c_text = _xcstr(value)
            tree.xmlNodeSetContent(self._c_node, c_text)

    # ACCESSORS
    def __getitem__(self, x):
        "__getitem__(self, x)"
        if isinstance(x, slice):
            return []
        else:
            raise IndexError, "list index out of range"

    def __len__(self):
        "__len__(self)"
        return 0

    def get(self, key, default=None):
        "get(self, key, default=None)"
        return None

    def keys(self):
        "keys(self)"
        return []

    def items(self):
        "items(self)"
        return []

    def values(self):
        "values(self)"
        return []

cdef class _Comment(__ContentOnlyElement):
    @property
    def tag(self):
        return Comment

    def __repr__(self):
        return "<!--%s-->" % self.text

cdef class _ProcessingInstruction(__ContentOnlyElement):
    @property
    def tag(self):
        return ProcessingInstruction

    property target:
        # not in ElementTree
        def __get__(self):
            _assertValidNode(self)
            return funicode(self._c_node.name)

        def __set__(self, value):
            _assertValidNode(self)
            value = _utf8(value)
            c_text = _xcstr(value)
            tree.xmlNodeSetName(self._c_node, c_text)

    def __repr__(self):
        text = self.text
        if text:
            return "<?%s %s?>" % (self.target, text)
        else:
            return "<?%s?>" % self.target

    def get(self, key, default=None):
        """get(self, key, default=None)

        Try to parse pseudo-attributes from the text content of the
        processing instruction, search for one with the given key as
        name and return its associated value.

        Note that this is only a convenience method for the most
        common case that all text content is structured in
        attribute-like name-value pairs with properly quoted values.
        It is not guaranteed to work for all possible text content.
        """
        return self.attrib.get(key, default)

    @property
    def attrib(self):
        """Returns a dict containing all pseudo-attributes that can be
        parsed from the text content of this processing instruction.
        Note that modifying the dict currently has no effect on the
        XML node, although this is not guaranteed to stay this way.
        """
        return { attr : (value1 or value2)
                 for attr, value1, value2 in _FIND_PI_ATTRIBUTES(' ' + self.text) }

cdef object _FIND_PI_ATTRIBUTES = re.compile(r'\s+(\w+)\s*=\s*(?:\'([^\']*)\'|"([^"]*)")', re.U).findall

cdef class _Entity(__ContentOnlyElement):
    @property
    def tag(self):
        return Entity

    property name:
        # not in ElementTree
        def __get__(self):
            _assertValidNode(self)
            return funicode(self._c_node.name)

        def __set__(self, value):
            _assertValidNode(self)
            value_utf = _utf8(value)
            if b'&' in value_utf or b';' in value_utf:
                raise ValueError, f"Invalid entity name '{value}'"
            tree.xmlNodeSetName(self._c_node, _xcstr(value_utf))

    @property
    def text(self):
        # FIXME: should this be None or '&[VALUE];' or the resolved
        # entity value ?
        _assertValidNode(self)
        return f'&{funicode(self._c_node.name)};'

    def __repr__(self):
        return "&%s;" % self.name


cdef class QName:
    """QName(text_or_uri_or_element, tag=None)

    QName wrapper for qualified XML names.

    Pass a tag name by itself or a namespace URI and a tag name to
    create a qualified name.  Alternatively, pass an Element to
    extract its tag name.  ``None`` as first argument is ignored in
    order to allow for generic 2-argument usage.

    The ``text`` property holds the qualified name in
    ``{namespace}tagname`` notation.  The ``namespace`` and
    ``localname`` properties hold the respective parts of the tag
    name.

    You can pass QName objects wherever a tag name is expected.  Also,
    setting Element text from a QName will resolve the namespace prefix
    on assignment and set a qualified text value.  This is helpful in XML
    languages like SOAP or XML-Schema that use prefixed tag names in
    their text content.
    """
    cdef readonly unicode text
    cdef readonly unicode localname
    cdef readonly unicode namespace
    def __init__(self, text_or_uri_or_element, tag=None):
        if text_or_uri_or_element is None:
            # Allow None as no namespace.
            text_or_uri_or_element, tag = tag, None
        if not _isString(text_or_uri_or_element):
            if isinstance(text_or_uri_or_element, _Element):
                text_or_uri_or_element = (<_Element>text_or_uri_or_element).tag
                if not _isString(text_or_uri_or_element):
                    raise ValueError, f"Invalid input tag of type {type(text_or_uri_or_element)!r}"
            elif isinstance(text_or_uri_or_element, QName):
                text_or_uri_or_element = (<QName>text_or_uri_or_element).text
            elif text_or_uri_or_element is not None:
                text_or_uri_or_element = unicode(text_or_uri_or_element)
            else:
                raise ValueError, f"Invalid input tag of type {type(text_or_uri_or_element)!r}"

        ns_utf, tag_utf = _getNsTag(text_or_uri_or_element)
        if tag is not None:
            # either ('ns', 'tag') or ('{ns}oldtag', 'newtag')
            if ns_utf is None:
                ns_utf = tag_utf # case 1: namespace ended up as tag name
            tag_utf = _utf8(tag)
        _tagValidOrRaise(tag_utf)
        self.localname = (<bytes>tag_utf).decode('utf8')
        if ns_utf is None:
            self.namespace = None
            self.text = self.localname
        else:
            self.namespace = (<bytes>ns_utf).decode('utf8')
            self.text = "{%s}%s" % (self.namespace, self.localname)
    def __str__(self):
        return self.text
    def __hash__(self):
        return hash(self.text)
    def __richcmp__(self, other, int op):
        try:
            if type(other) is QName:
                other = (<QName>other).text
            elif not isinstance(other, unicode):
                other = unicode(other)
        except (ValueError, UnicodeDecodeError):
            return NotImplemented
        return python.PyObject_RichCompare(self.text, other, op)


cdef public class _ElementTree [ type LxmlElementTreeType,
                                 object LxmlElementTree ]:
    cdef _Document _doc
    cdef _Element _context_node

    # Note that _doc is only used to store the original document if we do not
    # have a _context_node.  All methods should prefer self._context_node._doc
    # to honour tree restructuring.  _doc can happily be None!

    @cython.final
    cdef int _assertHasRoot(self) except -1:
        """We have to take care here: the document may not have a root node!
        This can happen if ElementTree() is called without any argument and
        the caller 'forgets' to call parse() afterwards, so this is a bug in
        the caller program.
        """
        assert self._context_node is not None, \
               "ElementTree not initialized, missing root"
        return 0

    def parse(self, source, _BaseParser parser=None, *, base_url=None):
        """parse(self, source, parser=None, base_url=None)

        Updates self with the content of source and returns its root.
        """
        cdef _Document doc = None
        try:
            doc = _parseDocument(source, parser, base_url)
        except _TargetParserResult as result_container:
            # raises a TypeError if we don't get an _Element
            self._context_node = result_container.result
        else:
            self._context_node = doc.getroot()
        self._doc = None if self._context_node is not None else doc
        return self._context_node

    def _setroot(self, _Element root not None):
        """_setroot(self, root)

        Relocate the ElementTree to a new root node.
        """
        _assertValidNode(root)
        if root._c_node.type != tree.XML_ELEMENT_NODE:
            raise TypeError, "Only elements can be the root of an ElementTree"
        self._context_node = root
        self._doc = None

    def getroot(self):
        """getroot(self)

        Gets the root element for this tree.
        """
        return self._context_node

    def __copy__(self):
        return _elementTreeFactory(self._doc, self._context_node)

    def __deepcopy__(self, memo):
        cdef _Element root
        cdef _Document doc
        cdef xmlDoc* c_doc
        if self._context_node is not None:
            root = self._context_node.__copy__()
            assert root is not None
            _assertValidNode(root)
            _copyNonElementSiblings(self._context_node._c_node, root._c_node)
            return _elementTreeFactory(None, root)
        elif self._doc is not None:
            _assertValidDoc(self._doc)
            c_doc = tree.xmlCopyDoc(self._doc._c_doc, 1)
            if c_doc is NULL:
                raise MemoryError()
            doc = _documentFactory(c_doc, self._doc._parser)
            return _elementTreeFactory(doc, None)
        else:
            # so what ...
            return self

    # not in ElementTree
    @property
    def docinfo(self) -> DocInfo:
        """Information about the document provided by parser and DTD."""
        self._assertHasRoot()
        return DocInfo(self._context_node._doc)

    # not in ElementTree, read-only
    @property
    def parser(self):
        """The parser that was used to parse the document in this ElementTree.
        """
        if self._context_node is not None and \
               self._context_node._doc is not None:
            return self._context_node._doc._parser
        if self._doc is not None:
            return self._doc._parser
        return None

    def write(self, file, *, encoding=None, method="xml",
              bint pretty_print=False, xml_declaration=None, bint with_tail=True,
              standalone=None, doctype=None, compression=0,
              bint exclusive=False, inclusive_ns_prefixes=None,
              bint with_comments=True, bint strip_text=False,
              docstring=None):
        """write(self, file, encoding=None, method="xml",
                  pretty_print=False, xml_declaration=None, with_tail=True,
                  standalone=None, doctype=None, compression=0,
                  exclusive=False, inclusive_ns_prefixes=None,
                  with_comments=True, strip_text=False)

        Write the tree to a filename, file or file-like object.

        Defaults to ASCII encoding and writing a declaration as needed.

        The keyword argument 'method' selects the output method:
        'xml', 'html', 'text', 'c14n' or 'c14n2'.  Default is 'xml'.

        With ``method="c14n"`` (C14N version 1), the options ``exclusive``,
        ``with_comments`` and ``inclusive_ns_prefixes`` request exclusive
        C14N, include comments, and list the inclusive prefixes respectively.

        With ``method="c14n2"`` (C14N version 2), the ``with_comments`` and
        ``strip_text`` options control the output of comments and text space
        according to C14N 2.0.

        Passing a boolean value to the ``standalone`` option will
        output an XML declaration with the corresponding
        ``standalone`` flag.

        The ``doctype`` option allows passing in a plain string that will
        be serialised before the XML tree.  Note that passing in non
        well-formed content here will make the XML output non well-formed.
        Also, an existing doctype in the document tree will not be removed
        when serialising an ElementTree instance.

        The ``compression`` option enables GZip compression level 1-9.

        The ``inclusive_ns_prefixes`` should be a list of namespace strings
        (i.e. ['xs', 'xsi']) that will be promoted to the top-level element
        during exclusive C14N serialisation.  This parameter is ignored if
        exclusive mode=False.

        If exclusive=True and no list is provided, a namespace will only be
        rendered if it is used by the immediate parent or one of its attributes
        and its prefix and values have not already been rendered by an ancestor
        of the namespace node's parent element.
        """
        cdef bint write_declaration
        cdef int is_standalone

        self._assertHasRoot()
        _assertValidNode(self._context_node)
        if compression is None or compression < 0:
            compression = 0

        # C14N serialisation
        if method in ('c14n', 'c14n2'):
            if encoding is not None:
                raise ValueError("Cannot specify encoding with C14N")
            if xml_declaration:
                raise ValueError("Cannot enable XML declaration in C14N")

            if method == 'c14n':
                _tofilelikeC14N(file, self._context_node, exclusive, with_comments,
                                compression, inclusive_ns_prefixes)
            else:  # c14n2
                with _open_utf8_file(file, compression=compression) as f:
                    target = C14NWriterTarget(
                        f.write, with_comments=with_comments, strip_text=strip_text)
                    _tree_to_target(self, target)
            return

        if not with_comments:
            raise ValueError("Can only discard comments in C14N serialisation")
        # suppress decl. in default case (purely for ElementTree compatibility)
        if xml_declaration is not None:
            write_declaration = xml_declaration
            if encoding is None:
                encoding = 'ASCII'
            else:
                encoding = encoding.upper()
        elif encoding is None:
            encoding = 'ASCII'
            write_declaration = 0
        else:
            encoding = encoding.upper()
            write_declaration = encoding not in (
                'US-ASCII', 'ASCII', 'UTF8', 'UTF-8')
        if standalone is None:
            is_standalone = -1
        elif standalone:
            write_declaration = 1
            is_standalone = 1
        else:
            write_declaration = 1
            is_standalone = 0

        if docstring is not None and doctype is None:
            import warnings
            warnings.warn(
                "The 'docstring' option is deprecated. Use 'doctype' instead.",
                DeprecationWarning)
            doctype = docstring

        _tofilelike(file, self._context_node, encoding, doctype, method,
                    write_declaration, 1, pretty_print, with_tail,
                    is_standalone, compression)

    def getpath(self, _Element element not None):
        """getpath(self, element)

        Returns a structural, absolute XPath expression to find the element.

        For namespaced elements, the expression uses prefixes from the
        document, which therefore need to be provided in order to make any
        use of the expression in XPath.

        Also see the method getelementpath(self, element), which returns a
        self-contained ElementPath expression.
        """
        cdef _Document doc
        cdef _Element root
        cdef xmlDoc* c_doc
        _assertValidNode(element)
        if self._context_node is not None:
            root = self._context_node
            doc = root._doc
        elif self._doc is not None:
            doc = self._doc
            root = doc.getroot()
        else:
            raise ValueError, "Element is not in this tree."
        _assertValidDoc(doc)
        _assertValidNode(root)
        if element._doc is not doc:
            raise ValueError, "Element is not in this tree."

        c_doc = _fakeRootDoc(doc._c_doc, root._c_node)
        c_path = tree.xmlGetNodePath(element._c_node)
        _destroyFakeDoc(doc._c_doc, c_doc)
        if c_path is NULL:
            raise MemoryError()
        path = funicode(c_path)
        tree.xmlFree(c_path)
        return path

    def getelementpath(self, _Element element not None):
        """getelementpath(self, element)

        Returns a structural, absolute ElementPath expression to find the
        element.  This path can be used in the .find() method to look up
        the element, provided that the elements along the path and their
        list of immediate children were not modified in between.

        ElementPath has the advantage over an XPath expression (as returned
        by the .getpath() method) that it does not require additional prefix
        declarations.  It is always self-contained.
        """
        cdef _Element root
        cdef Py_ssize_t count
        _assertValidNode(element)
        if element._c_node.type != tree.XML_ELEMENT_NODE:
            raise ValueError, "input is not an Element"
        if self._context_node is not None:
            root = self._context_node
        elif self._doc is not None:
            root = self._doc.getroot()
        else:
            raise ValueError, "Element is not in this tree"
        _assertValidNode(root)
        if element._doc is not root._doc:
            raise ValueError, "Element is not in this tree"

        path = []
        c_element = element._c_node
        while c_element is not root._c_node:
            c_name = c_element.name
            c_href = _getNs(c_element)
            tag = _namespacedNameFromNsName(c_href, c_name)
            if c_href is NULL:
                c_href = <const_xmlChar*>b''  # no namespace (NULL is wildcard)
            # use tag[N] if there are preceding siblings with the same tag
            count = 0
            c_node = c_element.prev
            while c_node is not NULL:
                if c_node.type == tree.XML_ELEMENT_NODE:
                    if _tagMatches(c_node, c_href, c_name):
                        count += 1
                c_node = c_node.prev
            if count:
                tag = f'{tag}[{count+1}]'
            else:
                # use tag[1] if there are following siblings with the same tag
                c_node = c_element.next
                while c_node is not NULL:
                    if c_node.type == tree.XML_ELEMENT_NODE:
                        if _tagMatches(c_node, c_href, c_name):
                            tag += '[1]'
                            break
                    c_node = c_node.next

            path.append(tag)
            c_element = c_element.parent
            if c_element is NULL or c_element.type != tree.XML_ELEMENT_NODE:
                raise ValueError, "Element is not in this tree."
        if not path:
            return '.'
        path.reverse()
        return '/'.join(path)

    def getiterator(self, tag=None, *tags):
        """getiterator(self, *tags, tag=None)

        Returns a sequence or iterator of all elements in document order
        (depth first pre-order), starting with the root element.

        Can be restricted to find only elements with specific tags,
        see `_Element.iter`.

        :deprecated: Note that this method is deprecated as of
          ElementTree 1.3 and lxml 2.0.  It returns an iterator in
          lxml, which diverges from the original ElementTree
          behaviour.  If you want an efficient iterator, use the
          ``tree.iter()`` method instead.  You should only use this
          method in new code if you require backwards compatibility
          with older versions of lxml or ElementTree.
        """
        root = self.getroot()
        if root is None:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return root.getiterator(*tags)

    def iter(self, tag=None, *tags):
        """iter(self, tag=None, *tags)

        Creates an iterator for the root element.  The iterator loops over
        all elements in this tree, in document order.  Note that siblings
        of the root element (comments or processing instructions) are not
        returned by the iterator.

        Can be restricted to find only elements with specific tags,
        see `_Element.iter`.
        """
        root = self.getroot()
        if root is None:
            return ITER_EMPTY
        if tag is not None:
            tags += (tag,)
        return root.iter(*tags)

    def find(self, path, namespaces=None):
        """find(self, path, namespaces=None)

        Finds the first toplevel element with given tag.  Same as
        ``tree.getroot().find(path)``.

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        self._assertHasRoot()
        root = self.getroot()
        if _isString(path):
            if path[:1] == "/":
                path = "." + path
                from warnings import warn
                warn(
                    "This search incorrectly ignores the root element, and will be "
                    "fixed in a future version.  If you rely on the current "
                    f"behaviour, change it to {path!r}",
                    FutureWarning, stacklevel=1
                )
        return root.find(path, namespaces)

    def findtext(self, path, default=None, namespaces=None):
        """findtext(self, path, default=None, namespaces=None)

        Finds the text for the first element matching the ElementPath
        expression.  Same as getroot().findtext(path)

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        self._assertHasRoot()
        root = self.getroot()
        if _isString(path):
            if path[:1] == "/":
                path = "." + path
                from warnings import warn
                warn(
                    "This search incorrectly ignores the root element, and will be "
                    "fixed in a future version.  If you rely on the current "
                    f"behaviour, change it to {path!r}",
                    FutureWarning, stacklevel=1
                )
        return root.findtext(path, default, namespaces)

    def findall(self, path, namespaces=None):
        """findall(self, path, namespaces=None)

        Finds all elements matching the ElementPath expression.  Same as
        getroot().findall(path).

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        self._assertHasRoot()
        root = self.getroot()
        if _isString(path):
            if path[:1] == "/":
                path = "." + path
                from warnings import warn
                warn(
                    "This search incorrectly ignores the root element, and will be "
                    "fixed in a future version.  If you rely on the current "
                    f"behaviour, change it to {path!r}",
                    FutureWarning, stacklevel=1
                )
        return root.findall(path, namespaces)

    def iterfind(self, path, namespaces=None):
        """iterfind(self, path, namespaces=None)

        Iterates over all elements matching the ElementPath expression.
        Same as getroot().iterfind(path).

        The optional ``namespaces`` argument accepts a
        prefix-to-namespace mapping that allows the usage of XPath
        prefixes in the path expression.
        """
        self._assertHasRoot()
        root = self.getroot()
        if _isString(path):
            if path[:1] == "/":
                path = "." + path
                from warnings import warn
                warn(
                    "This search incorrectly ignores the root element, and will be "
                    "fixed in a future version.  If you rely on the current "
                    f"behaviour, change it to {path!r}",
                    FutureWarning, stacklevel=1
                )
        return root.iterfind(path, namespaces)

    def xpath(self, _path, *, namespaces=None, extensions=None,
              smart_strings=True, **_variables):
        """xpath(self, _path, namespaces=None, extensions=None, smart_strings=True, **_variables)

        XPath evaluate in context of document.

        ``namespaces`` is an optional dictionary with prefix to namespace URI
        mappings, used by XPath.  ``extensions`` defines additional extension
        functions.

        Returns a list (nodeset), or bool, float or string.

        In case of a list result, return Element for element nodes,
        string for text and attribute values.

        Note: if you are going to apply multiple XPath expressions
        against the same document, it is more efficient to use
        XPathEvaluator directly.
        """
        self._assertHasRoot()
        evaluator = XPathDocumentEvaluator(self, namespaces=namespaces,
                                           extensions=extensions,
                                           smart_strings=smart_strings)
        return evaluator(_path, **_variables)

    def xslt(self, _xslt, extensions=None, access_control=None, **_kw):
        """xslt(self, _xslt, extensions=None, access_control=None, **_kw)

        Transform this document using other document.

        xslt is a tree that should be XSLT
        keyword parameters are XSLT transformation parameters.

        Returns the transformed tree.

        Note: if you are going to apply the same XSLT stylesheet against
        multiple documents, it is more efficient to use the XSLT
        class directly.
        """
        self._assertHasRoot()
        style = XSLT(_xslt, extensions=extensions,
                     access_control=access_control)
        return style(self, **_kw)

    def relaxng(self, relaxng):
        """relaxng(self, relaxng)

        Validate this document using other document.

        The relaxng argument is a tree that should contain a Relax NG schema.

        Returns True or False, depending on whether validation
        succeeded.

        Note: if you are going to apply the same Relax NG schema against
        multiple documents, it is more efficient to use the RelaxNG
        class directly.
        """
        self._assertHasRoot()
        schema = RelaxNG(relaxng)
        return schema.validate(self)

    def xmlschema(self, xmlschema):
        """xmlschema(self, xmlschema)

        Validate this document using other document.

        The xmlschema argument is a tree that should contain an XML Schema.

        Returns True or False, depending on whether validation
        succeeded.

        Note: If you are going to apply the same XML Schema against
        multiple documents, it is more efficient to use the XMLSchema
        class directly.
        """
        self._assertHasRoot()
        schema = XMLSchema(xmlschema)
        return schema.validate(self)

    def xinclude(self):
        """xinclude(self)

        Process the XInclude nodes in this document and include the
        referenced XML fragments.

        There is support for loading files through the file system, HTTP and
        FTP.

        Note that XInclude does not support custom resolvers in Python space
        due to restrictions of libxml2 <= 2.6.29.
        """
        self._assertHasRoot()
        XInclude()(self._context_node)

    def write_c14n(self, file, *, bint exclusive=False, bint with_comments=True,
                   compression=0, inclusive_ns_prefixes=None):
        """write_c14n(self, file, exclusive=False, with_comments=True,
                       compression=0, inclusive_ns_prefixes=None)

        C14N write of document. Always writes UTF-8.

        The ``compression`` option enables GZip compression level 1-9.

        The ``inclusive_ns_prefixes`` should be a list of namespace strings
        (i.e. ['xs', 'xsi']) that will be promoted to the top-level element
        during exclusive C14N serialisation.  This parameter is ignored if
        exclusive mode=False.

        If exclusive=True and no list is provided, a namespace will only be
        rendered if it is used by the immediate parent or one of its attributes
        and its prefix and values have not already been rendered by an ancestor
        of the namespace node's parent element.

        NOTE: This method is deprecated as of lxml 4.4 and will be removed in a
        future release.  Use ``.write(f, method="c14n")`` instead.
        """
        self._assertHasRoot()
        _assertValidNode(self._context_node)
        if compression is None or compression < 0:
            compression = 0

        _tofilelikeC14N(file, self._context_node, exclusive, with_comments,
                        compression, inclusive_ns_prefixes)

cdef _ElementTree _elementTreeFactory(_Document doc, _Element context_node):
    return _newElementTree(doc, context_node, _ElementTree)

cdef _ElementTree _newElementTree(_Document doc, _Element context_node,
                                  object baseclass):
    cdef _ElementTree result
    result = baseclass()
    if context_node is None and doc is not None:
        context_node = doc.getroot()
    if context_node is None:
        _assertValidDoc(doc)
        result._doc = doc
    else:
        _assertValidNode(context_node)
    result._context_node = context_node
    return result


@cython.final
@cython.freelist(16)
cdef class _Attrib:
    """A dict-like proxy for the ``Element.attrib`` property.
    """
    cdef _Element _element
    def __cinit__(self, _Element element not None):
        _assertValidNode(element)
        self._element = element

    # MANIPULATORS
    def __setitem__(self, key, value):
        _assertValidNode(self._element)
        _setAttributeValue(self._element, key, value)

    def __delitem__(self, key):
        _assertValidNode(self._element)
        _delAttribute(self._element, key)

    def update(self, sequence_or_dict):
        _assertValidNode(self._element)
        if isinstance(sequence_or_dict, (dict, _Attrib)):
            sequence_or_dict = sequence_or_dict.items()
        for key, value in sequence_or_dict:
            _setAttributeValue(self._element, key, value)

    def pop(self, key, *default):
        if len(default) > 1:
            raise TypeError, f"pop expected at most 2 arguments, got {len(default)+1}"
        _assertValidNode(self._element)
        result = _getAttributeValue(self._element, key, None)
        if result is None:
            if not default:
                raise KeyError, key
            result = default[0]
        else:
            _delAttribute(self._element, key)
        return result

    def clear(self):
        _assertValidNode(self._element)
        c_attrs = self._element._c_node.properties
        if c_attrs:
            self._element._c_node.properties = NULL
            tree.xmlFreePropList(c_attrs)

    # ACCESSORS
    def __repr__(self):
        _assertValidNode(self._element)
        return repr(dict( _collectAttributes(self._element._c_node, 3) ))

    def __copy__(self):
        _assertValidNode(self._element)
        return dict(_collectAttributes(self._element._c_node, 3))

    def __deepcopy__(self, memo):
        _assertValidNode(self._element)
        return dict(_collectAttributes(self._element._c_node, 3))

    def __getitem__(self, key):
        _assertValidNode(self._element)
        result = _getAttributeValue(self._element, key, None)
        if result is None:
            raise KeyError, key
        return result

    def __bool__(self):
        _assertValidNode(self._element)
        cdef xmlAttr* c_attr = self._element._c_node.properties
        while c_attr is not NULL:
            if c_attr.type == tree.XML_ATTRIBUTE_NODE:
                return 1
            c_attr = c_attr.next
        return 0

    def __len__(self):
        _assertValidNode(self._element)
        cdef xmlAttr* c_attr = self._element._c_node.properties
        cdef Py_ssize_t c = 0
        while c_attr is not NULL:
            if c_attr.type == tree.XML_ATTRIBUTE_NODE:
                c += 1
            c_attr = c_attr.next
        return c

    def get(self, key, default=None):
        _assertValidNode(self._element)
        return _getAttributeValue(self._element, key, default)

    def keys(self):
        _assertValidNode(self._element)
        return _collectAttributes(self._element._c_node, 1)

    def __iter__(self):
        _assertValidNode(self._element)
        return iter(_collectAttributes(self._element._c_node, 1))

    def iterkeys(self):
        _assertValidNode(self._element)
        return iter(_collectAttributes(self._element._c_node, 1))

    def values(self):
        _assertValidNode(self._element)
        return _collectAttributes(self._element._c_node, 2)

    def itervalues(self):
        _assertValidNode(self._element)
        return iter(_collectAttributes(self._element._c_node, 2))

    def items(self):
        _assertValidNode(self._element)
        return _collectAttributes(self._element._c_node, 3)

    def iteritems(self):
        _assertValidNode(self._element)
        return iter(_collectAttributes(self._element._c_node, 3))

    def has_key(self, key):
        _assertValidNode(self._element)
        return key in self

    def __contains__(self, key):
        _assertValidNode(self._element)
        cdef xmlNode* c_node
        ns, tag = _getNsTag(key)
        c_node = self._element._c_node
        c_href = <const_xmlChar*>NULL if ns is None else _xcstr(ns)
        return 1 if tree.xmlHasNsProp(c_node, _xcstr(tag), c_href) else 0

    def __richcmp__(self, other, int op):
        try:
            one = dict(self.items())
            if not isinstance(other, dict):
                other = dict(other)
        except (TypeError, ValueError):
            return NotImplemented
        return python.PyObject_RichCompare(one, other, op)

MutableMapping.register(_Attrib)


@cython.final
@cython.internal
cdef class _AttribIterator:
    """Attribute iterator - for internal use only!
    """
    # XML attributes must not be removed while running!
    cdef _Element _node
    cdef xmlAttr* _c_attr
    cdef int _keysvalues # 1 - keys, 2 - values, 3 - items (key, value)
    def __iter__(self):
        return self

    def __next__(self):
        cdef xmlAttr* c_attr
        if self._node is None:
            raise StopIteration
        c_attr = self._c_attr
        while c_attr is not NULL and c_attr.type != tree.XML_ATTRIBUTE_NODE:
            c_attr = c_attr.next
        if c_attr is NULL:
            self._node = None
            raise StopIteration

        self._c_attr = c_attr.next
        if self._keysvalues == 1:
            return _namespacedName(<xmlNode*>c_attr)
        elif self._keysvalues == 2:
            return _attributeValue(self._node._c_node, c_attr)
        else:
            return (_namespacedName(<xmlNode*>c_attr),
                    _attributeValue(self._node._c_node, c_attr))

cdef object _attributeIteratorFactory(_Element element, int keysvalues):
    cdef _AttribIterator attribs
    if element._c_node.properties is NULL:
        return ITER_EMPTY
    attribs = _AttribIterator()
    attribs._node = element
    attribs._c_attr = element._c_node.properties
    attribs._keysvalues = keysvalues
    return attribs


cdef public class _ElementTagMatcher [ object LxmlElementTagMatcher,
                                       type LxmlElementTagMatcherType ]:
    """
    Dead but public. :)
    """
    cdef object _pystrings
    cdef int _node_type
    cdef char* _href
    cdef char* _name
    cdef _initTagMatch(self, tag):
        self._href = NULL
        self._name = NULL
        if tag is None:
            self._node_type = 0
        elif tag is Comment:
            self._node_type = tree.XML_COMMENT_NODE
        elif tag is ProcessingInstruction:
            self._node_type = tree.XML_PI_NODE
        elif tag is Entity:
            self._node_type = tree.XML_ENTITY_REF_NODE
        elif tag is Element:
            self._node_type = tree.XML_ELEMENT_NODE
        else:
            self._node_type = tree.XML_ELEMENT_NODE
            self._pystrings = _getNsTag(tag)
            if self._pystrings[0] is not None:
                self._href = _cstr(self._pystrings[0])
            self._name = _cstr(self._pystrings[1])
            if self._name[0] == c'*' and self._name[1] == c'\0':
                self._name = NULL

cdef public class _ElementIterator(_ElementTagMatcher) [
    object LxmlElementIterator, type LxmlElementIteratorType ]:
    """
    Dead but public. :)
    """
    # we keep Python references here to control GC
    cdef _Element _node
    cdef _node_to_node_function _next_element
    def __iter__(self):
        return self

    cdef void _storeNext(self, _Element node):
        cdef xmlNode* c_node
        c_node = self._next_element(node._c_node)
        while c_node is not NULL and \
                  self._node_type != 0 and \
                  (<tree.xmlElementType>self._node_type != c_node.type or
                   not _tagMatches(c_node, <const_xmlChar*>self._href, <const_xmlChar*>self._name)):
            c_node = self._next_element(c_node)
        if c_node is NULL:
            self._node = None
        else:
            # Python ref:
            self._node = _elementFactory(node._doc, c_node)

    def __next__(self):
        cdef xmlNode* c_node
        cdef _Element current_node
        if self._node is None:
            raise StopIteration
        # Python ref:
        current_node = self._node
        self._storeNext(current_node)
        return current_node

@cython.final
@cython.internal
cdef class _MultiTagMatcher:
    """
    Match an xmlNode against a list of tags.
    """
    cdef list _py_tags
    cdef qname* _cached_tags
    cdef size_t _tag_count
    cdef size_t _cached_size
    cdef _Document _cached_doc
    cdef int _node_types

    def __cinit__(self, tags):
        self._py_tags = []
        self.initTagMatch(tags)

    def __dealloc__(self):
        self._clear()

    cdef bint rejectsAll(self) noexcept:
        return not self._tag_count and not self._node_types

    cdef bint rejectsAllAttributes(self) noexcept:
        return not self._tag_count

    cdef bint matchesType(self, int node_type) noexcept:
        if node_type == tree.XML_ELEMENT_NODE and self._tag_count:
            return True
        return self._node_types & (1 << node_type)

    cdef void _clear(self) noexcept:
        cdef size_t i, count
        count = self._tag_count
        self._tag_count = 0
        if self._cached_tags:
            for i in range(count):
                cpython.ref.Py_XDECREF(self._cached_tags[i].href)
            python.lxml_free(self._cached_tags)
            self._cached_tags = NULL

    cdef initTagMatch(self, tags):
        self._cached_doc = None
        del self._py_tags[:]
        self._clear()
        if tags is None or tags == ():
            # no selection in tags argument => match anything
            self._node_types = (
                1 << tree.XML_COMMENT_NODE |
                1 << tree.XML_PI_NODE |
                1 << tree.XML_ENTITY_REF_NODE |
                1 << tree.XML_ELEMENT_NODE)
        else:
            self._node_types = 0
            self._storeTags(tags, set())

    cdef _storeTags(self, tag, set seen):
        if tag is Comment:
            self._node_types |= 1 << tree.XML_COMMENT_NODE
        elif tag is ProcessingInstruction:
            self._node_types |= 1 << tree.XML_PI_NODE
        elif tag is Entity:
            self._node_types |= 1 << tree.XML_ENTITY_REF_NODE
        elif tag is Element:
            self._node_types |= 1 << tree.XML_ELEMENT_NODE
        elif python._isString(tag):
            if tag in seen:
                return
            seen.add(tag)
            if tag in ('*', '{*}*'):
                self._node_types |= 1 << tree.XML_ELEMENT_NODE
            else:
                href, name = _getNsTag(tag)
                if name == b'*':
                    name = None
                if href is None:
                    href = b''  # no namespace
                elif href == b'*':
                    href = None  # wildcard: any namespace, including none
                self._py_tags.append((href, name))
        elif isinstance(tag, QName):
            self._storeTags(tag.text, seen)
        else:
            # support a sequence of tags
            for item in tag:
                self._storeTags(item, seen)

    cdef inline int cacheTags(self, _Document doc, bint force_into_dict=False) except -1:
        """
        Look up the tag names in the doc dict to enable string pointer comparisons.
        """
        cdef size_t dict_size = tree.xmlDictSize(doc._c_doc.dict)
        if doc is self._cached_doc and dict_size == self._cached_size:
            # doc and dict didn't change => names already cached
            return 0
        self._tag_count = 0
        if not self._py_tags:
            self._cached_doc = doc
            self._cached_size = dict_size
            return 0
        if not self._cached_tags:
            self._cached_tags = <qname*>python.lxml_malloc(len(self._py_tags), sizeof(qname))
            if not self._cached_tags:
                self._cached_doc = None
                raise MemoryError()
        self._tag_count = <size_t>_mapTagsToQnameMatchArray(
            doc._c_doc, self._py_tags, self._cached_tags, force_into_dict)
        self._cached_doc = doc
        self._cached_size = dict_size
        return 0

    cdef inline bint matches(self, xmlNode* c_node) noexcept:
        cdef qname* c_qname
        if self._node_types & (1 << c_node.type):
            return True
        elif c_node.type == tree.XML_ELEMENT_NODE:
            for c_qname in self._cached_tags[:self._tag_count]:
                if _tagMatchesExactly(c_node, c_qname):
                    return True
        return False

    cdef inline bint matchesNsTag(self, const_xmlChar* c_href,
                                  const_xmlChar* c_name) noexcept:
        cdef qname* c_qname
        if self._node_types & (1 << tree.XML_ELEMENT_NODE):
            return True
        for c_qname in self._cached_tags[:self._tag_count]:
            if _nsTagMatchesExactly(c_href, c_name, c_qname):
                return True
        return False

    cdef inline bint matchesAttribute(self, xmlAttr* c_attr) noexcept:
        """Attribute matches differ from Element matches in that they do
        not care about node types.
        """
        cdef qname* c_qname
        for c_qname in self._cached_tags[:self._tag_count]:
            if _tagMatchesExactly(<xmlNode*>c_attr, c_qname):
                return True
        return False

cdef class _ElementMatchIterator:
    cdef _Element _node
    cdef _node_to_node_function _next_element
    cdef _MultiTagMatcher _matcher

    @cython.final
    cdef _initTagMatcher(self, tags):
        self._matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, tags)

    def __iter__(self):
        return self

    @cython.final
    cdef int _storeNext(self, _Element node) except -1:
        self._matcher.cacheTags(node._doc)
        c_node = self._next_element(node._c_node)
        while c_node is not NULL and not self._matcher.matches(c_node):
            c_node = self._next_element(c_node)
        # store Python ref to next node to make sure it's kept alive
        self._node = _elementFactory(node._doc, c_node) if c_node is not NULL else None
        return 0

    def __next__(self):
        cdef _Element current_node = self._node
        if current_node is None:
            raise StopIteration
        self._storeNext(current_node)
        return current_node

cdef class ElementChildIterator(_ElementMatchIterator):
    """ElementChildIterator(self, node, tag=None, reversed=False)
    Iterates over the children of an element.
    """
    def __cinit__(self, _Element node not None, tag=None, *, bint reversed=False):
        cdef xmlNode* c_node
        _assertValidNode(node)
        self._initTagMatcher(tag)
        if reversed:
            c_node = _findChildBackwards(node._c_node, 0)
            self._next_element = _previousElement
        else:
            c_node = _findChildForwards(node._c_node, 0)
            self._next_element = _nextElement
        self._matcher.cacheTags(node._doc)
        while c_node is not NULL and not self._matcher.matches(c_node):
            c_node = self._next_element(c_node)
        # store Python ref to next node to make sure it's kept alive
        self._node = _elementFactory(node._doc, c_node) if c_node is not NULL else None

cdef class SiblingsIterator(_ElementMatchIterator):
    """SiblingsIterator(self, node, tag=None, preceding=False)
    Iterates over the siblings of an element.

    You can pass the boolean keyword ``preceding`` to specify the direction.
    """
    def __cinit__(self, _Element node not None, tag=None, *, bint preceding=False):
        _assertValidNode(node)
        self._initTagMatcher(tag)
        if preceding:
            self._next_element = _previousElement
        else:
            self._next_element = _nextElement
        self._storeNext(node)

cdef class AncestorsIterator(_ElementMatchIterator):
    """AncestorsIterator(self, node, tag=None)
    Iterates over the ancestors of an element (from parent to parent).
    """
    def __cinit__(self, _Element node not None, tag=None):
        _assertValidNode(node)
        self._initTagMatcher(tag)
        self._next_element = _parentElement
        self._storeNext(node)

cdef class ElementDepthFirstIterator:
    """ElementDepthFirstIterator(self, node, tag=None, inclusive=True)
    Iterates over an element and its sub-elements in document order (depth
    first pre-order).

    Note that this also includes comments, entities and processing
    instructions.  To filter them out, check if the ``tag`` property
    of the returned element is a string (i.e. not None and not a
    factory function), or pass the ``Element`` factory for the ``tag``
    argument to receive only Elements.

    If the optional ``tag`` argument is not None, the iterator returns only
    the elements that match the respective name and namespace.

    The optional boolean argument 'inclusive' defaults to True and can be set
    to False to exclude the start element itself.

    Note that the behaviour of this iterator is completely undefined if the
    tree it traverses is modified during iteration.
    """
    # we keep Python references here to control GC
    # keep the next Element after the one we return, and the (s)top node
    cdef _Element _next_node
    cdef _Element _top_node
    cdef _MultiTagMatcher _matcher
    def __cinit__(self, _Element node not None, tag=None, *, bint inclusive=True):
        _assertValidNode(node)
        self._top_node  = node
        self._next_node = node
        self._matcher = _MultiTagMatcher.__new__(_MultiTagMatcher, tag)
        self._matcher.cacheTags(node._doc)
        if not inclusive or not self._matcher.matches(node._c_node):
            # find start node (this cannot raise StopIteration, self._next_node != None)
            next(self)

    def __iter__(self):
        return self

    def __next__(self):
        cdef xmlNode* c_node
        cdef _Element current_node = self._next_node
        if current_node is None:
            raise StopIteration
        c_node = current_node._c_node
        self._matcher.cacheTags(current_node._doc)
        if not self._matcher._tag_count:
            # no tag name was found in the dict => not in document either
            # try to match by node type
            c_node = self._nextNodeAnyTag(c_node)
        else:
            c_node = self._nextNodeMatchTag(c_node)
        if c_node is NULL:
            self._next_node = None
        else:
            self._next_node = _elementFactory(current_node._doc, c_node)
        return current_node

    @cython.final
    cdef xmlNode* _nextNodeAnyTag(self, xmlNode* c_node) noexcept:
        cdef int node_types = self._matcher._node_types
        if not node_types:
            return NULL
        tree.BEGIN_FOR_EACH_ELEMENT_FROM(self._top_node._c_node, c_node, 0)
        if node_types & (1 << c_node.type):
            return c_node
        tree.END_FOR_EACH_ELEMENT_FROM(c_node)
        return NULL

    @cython.final
    cdef xmlNode* _nextNodeMatchTag(self, xmlNode* c_node) noexcept:
        tree.BEGIN_FOR_EACH_ELEMENT_FROM(self._top_node._c_node, c_node, 0)
        if self._matcher.matches(c_node):
            return c_node
        tree.END_FOR_EACH_ELEMENT_FROM(c_node)
        return NULL


cdef class ElementTextIterator:
    """ElementTextIterator(self, element, tag=None, with_tail=True)
    Iterates over the text content of a subtree.

    You can pass the ``tag`` keyword argument to restrict text content to a
    specific tag name.

    You can set the ``with_tail`` keyword argument to ``False`` to skip over
    tail text (e.g. if you know that it's only whitespace from pretty-printing).
    """
    cdef object _events
    cdef _Element _start_element
    def __cinit__(self, _Element element not None, tag=None, *, bint with_tail=True):
        _assertValidNode(element)
        if with_tail:
            events = ("start", "comment", "pi", "end")
        else:
            events = ("start",)
        self._start_element = element
        self._events = iterwalk(element, events=events, tag=tag)

    def __iter__(self):
        return self

    def __next__(self):
        cdef _Element element
        result = None
        while result is None:
            event, element = next(self._events)  # raises StopIteration
            if event == "start":
                result = element.text
            elif element is not self._start_element:
                result = element.tail
        return result


cdef xmlNode* _createElement(xmlDoc* c_doc, object name_utf) except NULL:
    cdef xmlNode* c_node
    c_node = tree.xmlNewDocNode(c_doc, NULL, _xcstr(name_utf), NULL)
    return c_node

cdef xmlNode* _createComment(xmlDoc* c_doc, const_xmlChar* text) noexcept:
    cdef xmlNode* c_node
    c_node = tree.xmlNewDocComment(c_doc, text)
    return c_node

cdef xmlNode* _createPI(xmlDoc* c_doc, const_xmlChar* target, const_xmlChar* text) noexcept:
    cdef xmlNode* c_node
    c_node = tree.xmlNewDocPI(c_doc, target, text)
    return c_node

cdef xmlNode* _createEntity(xmlDoc* c_doc, const_xmlChar* name) noexcept:
    cdef xmlNode* c_node
    c_node = tree.xmlNewReference(c_doc, name)
    return c_node

# module-level API for ElementTree

from abc import ABC

class Element(ABC):
    """Element(_tag, attrib=None, nsmap=None, **_extra)

    Element factory, as a class.

    An instance of this class is an object implementing the
    Element interface.

    >>> element = Element("test")
    >>> type(element)
    <class 'lxml.etree._Element'>
    >>> isinstance(element, Element)
    True
    >>> issubclass(_Element, Element)
    True

    Also look at the `_Element.makeelement()` and
    `_BaseParser.makeelement()` methods, which provide a faster way to
    create an Element within a specific document or parser context.
    """
    def __new__(cls, _tag, attrib=None, nsmap=None, **_extra):
          return _makeElement(_tag, NULL, None, None, None, None,
                              attrib, nsmap, _extra)

# Register _Element as a virtual subclass of Element
Element.register(_Element)


def Comment(text=None):
    """Comment(text=None)

    Comment element factory. This factory function creates a special element that will
    be serialized as an XML comment.
    """
    cdef _Document doc
    cdef xmlNode*  c_node
    cdef xmlDoc*   c_doc

    if text is None:
        text = b''
    else:
        text = _utf8(text)
        if b'--' in text or text.endswith(b'-'):
            raise ValueError("Comment may not contain '--' or end with '-'")

    c_doc = _newXMLDoc()
    doc = _documentFactory(c_doc, None)
    c_node = _createComment(c_doc, _xcstr(text))
    tree.xmlAddChild(<xmlNode*>c_doc, c_node)
    return _elementFactory(doc, c_node)


def ProcessingInstruction(target, text=None):
    """ProcessingInstruction(target, text=None)

    ProcessingInstruction element factory. This factory function creates a
    special element that will be serialized as an XML processing instruction.
    """
    cdef _Document doc
    cdef xmlNode*  c_node
    cdef xmlDoc*   c_doc

    target = _utf8(target)
    _tagValidOrRaise(target)
    if target.lower() == b'xml':
        raise ValueError, f"Invalid PI name '{target}'"

    if text is None:
        text = b''
    else:
        text = _utf8(text)
        if b'?>' in text:
            raise ValueError, "PI text must not contain '?>'"

    c_doc = _newXMLDoc()
    doc = _documentFactory(c_doc, None)
    c_node = _createPI(c_doc, _xcstr(target), _xcstr(text))
    tree.xmlAddChild(<xmlNode*>c_doc, c_node)
    return _elementFactory(doc, c_node)

PI = ProcessingInstruction


cdef class CDATA:
    """CDATA(data)

    CDATA factory.  This factory creates an opaque data object that
    can be used to set Element text.  The usual way to use it is::

        >>> el = Element('content')
        >>> el.text = CDATA('a string')

        >>> print(el.text)
        a string
        >>> print(tostring(el, encoding="unicode"))
        <content><![CDATA[a string]]></content>
    """
    cdef bytes _utf8_data
    def __cinit__(self, data):
        self._utf8_data = _utf8(data)


def Entity(name):
    """Entity(name)

    Entity factory.  This factory function creates a special element
    that will be serialized as an XML entity reference or character
    reference.  Note, however, that entities will not be automatically
    declared in the document.  A document that uses entity references
    requires a DTD to define the entities.
    """
    cdef _Document doc
    cdef xmlNode*  c_node
    cdef xmlDoc*   c_doc
    name_utf = _utf8(name)
    c_name = _xcstr(name_utf)
    if c_name[0] == c'#':
        if not _characterReferenceIsValid(c_name + 1):
            raise ValueError, f"Invalid character reference: '{name}'"
    elif not _xmlNameIsValid(c_name):
        raise ValueError, f"Invalid entity reference: '{name}'"
    c_doc = _newXMLDoc()
    doc = _documentFactory(c_doc, None)
    c_node = _createEntity(c_doc, c_name)
    tree.xmlAddChild(<xmlNode*>c_doc, c_node)
    return _elementFactory(doc, c_node)


def SubElement(_Element _parent not None, _tag,
               attrib=None, nsmap=None, **_extra):
    """SubElement(_parent, _tag, attrib=None, nsmap=None, **_extra)

    Subelement factory.  This function creates an element instance, and
    appends it to an existing element.
    """
    return _makeSubElement(_parent, _tag, None, None, attrib, nsmap, _extra)

from typing import Generic, TypeVar

T = TypeVar("T")

class ElementTree(ABC, Generic[T]):
    def __new__(cls, _Element element=None, *, file=None, _BaseParser parser=None):
        """ElementTree(element=None, file=None, parser=None)

        ElementTree wrapper class.
        """
        cdef xmlNode* c_next
        cdef xmlNode* c_node
        cdef xmlNode* c_node_copy
        cdef xmlDoc*  c_doc
        cdef _ElementTree etree
        cdef _Document doc

        if element is not None:
            doc  = element._doc
        elif file is not None:
            try:
                doc = _parseDocument(file, parser, None)
            except _TargetParserResult as result_container:
                return result_container.result
        else:
            c_doc = _newXMLDoc()
            doc = _documentFactory(c_doc, parser)

        return _elementTreeFactory(doc, element)

# Register _ElementTree as a virtual subclass of ElementTree
ElementTree.register(_ElementTree)

# Remove "ABC" and typing helpers from module dict
del ABC, Generic, TypeVar, T

def HTML(text, _BaseParser parser=None, *, base_url=None):
    """HTML(text, parser=None, base_url=None)

    Parses an HTML document from a string constant.  Returns the root
    node (or the result returned by a parser target).  This function
    can be used to embed "HTML literals" in Python code.

    To override the parser with a different ``HTMLParser`` you can pass it to
    the ``parser`` keyword argument.

    The ``base_url`` keyword argument allows to set the original base URL of
    the document to support relative Paths when looking up external entities
    (DTD, XInclude, ...).
    """
    cdef _Document doc
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
        if not isinstance(parser, HTMLParser):
            parser = __DEFAULT_HTML_PARSER
    try:
        doc = _parseMemoryDocument(text, base_url, parser)
        return doc.getroot()
    except _TargetParserResult as result_container:
        return result_container.result


def XML(text, _BaseParser parser=None, *, base_url=None):
    """XML(text, parser=None, base_url=None)

    Parses an XML document or fragment from a string constant.
    Returns the root node (or the result returned by a parser target).
    This function can be used to embed "XML literals" in Python code,
    like in

       >>> root = XML("<root><test/></root>")
       >>> print(root.tag)
       root

    To override the parser with a different ``XMLParser`` you can pass it to
    the ``parser`` keyword argument.

    The ``base_url`` keyword argument allows to set the original base URL of
    the document to support relative Paths when looking up external entities
    (DTD, XInclude, ...).
    """
    cdef _Document doc
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
        if not isinstance(parser, XMLParser):
            parser = __DEFAULT_XML_PARSER
    try:
        doc = _parseMemoryDocument(text, base_url, parser)
        return doc.getroot()
    except _TargetParserResult as result_container:
        return result_container.result


def fromstring(text, _BaseParser parser=None, *, base_url=None):
    """fromstring(text, parser=None, base_url=None)

    Parses an XML document or fragment from a string.  Returns the
    root node (or the result returned by a parser target).

    To override the default parser with a different parser you can pass it to
    the ``parser`` keyword argument.

    The ``base_url`` keyword argument allows to set the original base URL of
    the document to support relative Paths when looking up external entities
    (DTD, XInclude, ...).
    """
    cdef _Document doc
    try:
        doc = _parseMemoryDocument(text, base_url, parser)
        return doc.getroot()
    except _TargetParserResult as result_container:
        return result_container.result


def fromstringlist(strings, _BaseParser parser=None):
    """fromstringlist(strings, parser=None)

    Parses an XML document from a sequence of strings.  Returns the
    root node (or the result returned by a parser target).

    To override the default parser with a different parser you can pass it to
    the ``parser`` keyword argument.
    """
    cdef _Document doc
    if isinstance(strings, (bytes, unicode)):
        raise ValueError("passing a single string into fromstringlist() is not"
                         " efficient, use fromstring() instead")
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
    feed = parser.feed
    for data in strings:
        feed(data)
    return parser.close()


def iselement(element):
    """iselement(element)

    Checks if an object appears to be a valid element object.
    """
    return isinstance(element, _Element) and (<_Element>element)._c_node is not NULL


def indent(tree, space="  ", *, Py_ssize_t level=0):
    """indent(tree, space="  ", level=0)

    Indent an XML document by inserting newlines and indentation space
    after elements.

    *tree* is the ElementTree or Element to modify.  The (root) element
    itself will not be changed, but the tail text of all elements in its
    subtree will be adapted.

    *space* is the whitespace to insert for each indentation level, two
    space characters by default.

    *level* is the initial indentation level. Setting this to a higher
    value than 0 can be used for indenting subtrees that are more deeply
    nested inside of a document.
    """
    root = _rootNodeOrRaise(tree)
    if level < 0:
        raise ValueError(f"Initial indentation level must be >= 0, got {level}")
    if _hasChild(root._c_node):
        space = _utf8(space)
        indent = b"\n" + level * space
        _indent_children(root._c_node, 1, space, [indent, indent + space])


cdef int _indent_children(xmlNode* c_node, Py_ssize_t level, bytes one_space, list indentations) except -1:
    # Reuse indentation strings for speed.
    if len(indentations) <= level:
        indentations.append(indentations[-1] + one_space)

    # Start a new indentation level for the first child.
    child_indentation = indentations[level]
    if not _hasNonWhitespaceText(c_node):
        _setNodeText(c_node, child_indentation)

    # Recursively indent all children.
    cdef xmlNode* c_child = _findChildForwards(c_node, 0)
    while c_child is not NULL:
        if _hasChild(c_child):
            _indent_children(c_child, level+1, one_space, indentations)
        c_next_child = _nextElement(c_child)
        if not _hasNonWhitespaceTail(c_child):
            if c_next_child is NULL:
                # Dedent after the last child.
                child_indentation = indentations[level-1]
            _setTailText(c_child, child_indentation)
        c_child = c_next_child
    return 0


def dump(_Element elem not None, *, bint pretty_print=True, bint with_tail=True):
    """dump(elem, pretty_print=True, with_tail=True)

    Writes an element tree or element structure to sys.stdout. This function
    should be used for debugging only.
    """
    xml = tostring(elem, pretty_print=pretty_print, with_tail=with_tail, encoding='unicode')
    if not pretty_print:
        xml += '\n'
    sys.stdout.write(xml)


def tostring(element_or_tree, *, encoding=None, method="xml",
             xml_declaration=None, bint pretty_print=False, bint with_tail=True,
             standalone=None, doctype=None,
             # method='c14n'
             bint exclusive=False, inclusive_ns_prefixes=None,
             # method='c14n2'
             bint with_comments=True, bint strip_text=False,
             ):
    """tostring(element_or_tree, encoding=None, method="xml",
                 xml_declaration=None, pretty_print=False, with_tail=True,
                 standalone=None, doctype=None,
                 exclusive=False, inclusive_ns_prefixes=None,
                 with_comments=True, strip_text=False,
                 )

    Serialize an element to an encoded string representation of its XML
    tree.

    Defaults to ASCII encoding without XML declaration.  This
    behaviour can be configured with the keyword arguments 'encoding'
    (string) and 'xml_declaration' (bool).  Note that changing the
    encoding to a non UTF-8 compatible encoding will enable a
    declaration by default.

    You can also serialise to a Unicode string without declaration by
    passing the name ``'unicode'`` as encoding (or the ``str`` function
    in Py3 or ``unicode`` in Py2).  This changes the return value from
    a byte string to an unencoded unicode string.

    The keyword argument 'pretty_print' (bool) enables formatted XML.

    The keyword argument 'method' selects the output method: 'xml',
    'html', plain 'text' (text content without tags), 'c14n' or 'c14n2'.
    Default is 'xml'.

    With ``method="c14n"`` (C14N version 1), the options ``exclusive``,
    ``with_comments`` and ``inclusive_ns_prefixes`` request exclusive
    C14N, include comments, and list the inclusive prefixes respectively.

    With ``method="c14n2"`` (C14N version 2), the ``with_comments`` and
    ``strip_text`` options control the output of comments and text space
    according to C14N 2.0.

    Passing a boolean value to the ``standalone`` option will output
    an XML declaration with the corresponding ``standalone`` flag.

    The ``doctype`` option allows passing in a plain string that will
    be serialised before the XML tree.  Note that passing in non
    well-formed content here will make the XML output non well-formed.
    Also, an existing doctype in the document tree will not be removed
    when serialising an ElementTree instance.

    You can prevent the tail text of the element from being serialised
    by passing the boolean ``with_tail`` option.  This has no impact
    on the tail text of children, which will always be serialised.
    """
    cdef bint write_declaration
    cdef int is_standalone
    # C14N serialisation
    if method in ('c14n', 'c14n2'):
        if encoding is not None:
            raise ValueError("Cannot specify encoding with C14N")
        if xml_declaration:
            raise ValueError("Cannot enable XML declaration in C14N")
        if method == 'c14n':
            return _tostringC14N(element_or_tree, exclusive, with_comments, inclusive_ns_prefixes)
        else:
            out = BytesIO()
            target = C14NWriterTarget(
                utf8_writer(out).write,
                with_comments=with_comments, strip_text=strip_text)
            _tree_to_target(element_or_tree, target)
            return out.getvalue()
    if not with_comments:
        raise ValueError("Can only discard comments in C14N serialisation")
    if strip_text:
        raise ValueError("Can only strip text in C14N 2.0 serialisation")
    if encoding is unicode or (encoding is not None and encoding.lower() == 'unicode'):
        if xml_declaration:
            raise ValueError, \
                "Serialisation to unicode must not request an XML declaration"
        write_declaration = 0
        encoding = unicode
    elif xml_declaration is None:
        # by default, write an XML declaration only for non-standard encodings
        write_declaration = encoding is not None and encoding.upper() not in \
                            ('ASCII', 'UTF-8', 'UTF8', 'US-ASCII')
    else:
        write_declaration = xml_declaration
    if encoding is None:
        encoding = 'ASCII'
    if standalone is None:
        is_standalone = -1
    elif standalone:
        write_declaration = 1
        is_standalone = 1
    else:
        write_declaration = 1
        is_standalone = 0

    if isinstance(element_or_tree, _Element):
        return _tostring(<_Element>element_or_tree, encoding, doctype, method,
                         write_declaration, 0, pretty_print, with_tail,
                         is_standalone)
    elif isinstance(element_or_tree, _ElementTree):
        return _tostring((<_ElementTree>element_or_tree)._context_node,
                         encoding, doctype, method, write_declaration, 1,
                         pretty_print, with_tail, is_standalone)
    else:
        raise TypeError, f"Type '{python._fqtypename(element_or_tree).decode('utf8')}' cannot be serialized."



def tostringlist(element_or_tree, *args, **kwargs):
    """tostringlist(element_or_tree, *args, **kwargs)

    Serialize an element to an encoded string representation of its XML
    tree, stored in a list of partial strings.

    This is purely for ElementTree 1.3 compatibility.  The result is a
    single string wrapped in a list.
    """
    return [tostring(element_or_tree, *args, **kwargs)]


def tounicode(element_or_tree, *, method="xml", bint pretty_print=False,
              bint with_tail=True, doctype=None):
    """tounicode(element_or_tree, method="xml", pretty_print=False,
                  with_tail=True, doctype=None)

    Serialize an element to the Python unicode representation of its XML
    tree.

    :deprecated: use ``tostring(el, encoding='unicode')`` instead.

    Note that the result does not carry an XML encoding declaration and is
    therefore not necessarily suited for serialization to byte streams without
    further treatment.

    The boolean keyword argument 'pretty_print' enables formatted XML.

    The keyword argument 'method' selects the output method: 'xml',
    'html' or plain 'text'.

    You can prevent the tail text of the element from being serialised
    by passing the boolean ``with_tail`` option.  This has no impact
    on the tail text of children, which will always be serialised.
    """
    if isinstance(element_or_tree, _Element):
        return _tostring(<_Element>element_or_tree, unicode, doctype, method,
                          0, 0, pretty_print, with_tail, -1)
    elif isinstance(element_or_tree, _ElementTree):
        return _tostring((<_ElementTree>element_or_tree)._context_node,
                         unicode, doctype, method, 0, 1, pretty_print,
                         with_tail, -1)
    else:
        raise TypeError, f"Type '{type(element_or_tree)}' cannot be serialized."


def parse(source, _BaseParser parser=None, *, base_url=None):
    """parse(source, parser=None, base_url=None)

    Return an ElementTree object loaded with source elements.  If no parser
    is provided as second argument, the default parser is used.

    The ``source`` can be any of the following:

    - a file name/path
    - a file object
    - a file-like object
    - a URL using the HTTP or FTP protocol

    To parse from a string, use the ``fromstring()`` function instead.

    Note that it is generally faster to parse from a file path or URL
    than from an open file object or file-like object.  Transparent
    decompression from gzip compressed sources is supported (unless
    explicitly disabled in libxml2).

    The ``base_url`` keyword allows setting a URL for the document
    when parsing from a file-like object.  This is needed when looking
    up external entities (DTD, XInclude, ...) with relative paths.
    """
    cdef _Document doc
    try:
        doc = _parseDocument(source, parser, base_url)
        return _elementTreeFactory(doc, None)
    except _TargetParserResult as result_container:
        return result_container.result


def adopt_external_document(capsule, _BaseParser parser=None):
    """adopt_external_document(capsule, parser=None)

    Unpack a libxml2 document pointer from a PyCapsule and wrap it in an
    lxml ElementTree object.

    This allows external libraries to build XML/HTML trees using libxml2
    and then pass them efficiently into lxml for further processing.

    If a ``parser`` is provided, it will be used for configuring the
    lxml document.  No parsing will be done.

    The capsule must have the name ``"libxml2:xmlDoc"`` and its pointer
    value must reference a correct libxml2 document of type ``xmlDoc*``.
    The creator of the capsule must take care to correctly clean up the
    document using an appropriate capsule destructor.  By default, the
    libxml2 document will be copied to let lxml safely own the memory
    of the internal tree that it uses.

    If the capsule context is non-NULL, it must point to a C string that
    can be compared using ``strcmp()``.  If the context string equals
    ``"destructor:xmlFreeDoc"``, the libxml2 document will not be copied
    but the capsule invalidated instead by clearing its destructor and
    name.  That way, lxml takes ownership of the libxml2 document in memory
    without creating a copy first, and the capsule destructor will not be
    called.  The document will then eventually be cleaned up by lxml using
    the libxml2 API function ``xmlFreeDoc()`` once it is no longer used.

    If no copy is made, later modifications of the tree outside of lxml
    should not be attempted after transferring the ownership.
    """
    cdef xmlDoc* c_doc
    cdef bint is_owned = False
    c_doc = <xmlDoc*> python.lxml_unpack_xmldoc_capsule(capsule, &is_owned)
    doc = _adoptForeignDoc(c_doc, parser, is_owned)
    return _elementTreeFactory(doc, None)


################################################################################
# Include submodules

include "readonlytree.pxi" # Read-only implementation of Element proxies
include "classlookup.pxi"  # Element class lookup mechanisms
include "nsclasses.pxi"    # Namespace implementation and registry
include "docloader.pxi"    # Support for custom document loaders
include "parser.pxi"       # XML and HTML parsers
include "saxparser.pxi"    # SAX-like Parser interface and tree builder
include "parsertarget.pxi" # ET Parser target
include "serializer.pxi"   # XML output functions
include "iterparse.pxi"    # incremental XML parsing
include "xmlid.pxi"        # XMLID and IDDict
include "xinclude.pxi"     # XInclude
include "cleanup.pxi"      # Cleanup and recursive element removal functions


################################################################################
# Include submodules for XPath and XSLT

include "extensions.pxi"   # XPath/XSLT extension functions
include "xpath.pxi"        # XPath evaluation
include "xslt.pxi"         # XSL transformations
include "xsltext.pxi"      # XSL extension elements


################################################################################
# Validation

cdef class DocumentInvalid(LxmlError):
    """Validation error.

    Raised by all document validators when their ``assertValid(tree)``
    method fails.
    """


cdef class _Validator:
    "Base class for XML validators."
    cdef _ErrorLog _error_log
    def __cinit__(self):
        self._error_log = _ErrorLog()

    def validate(self, etree):
        """validate(self, etree)

        Validate the document using this schema.

        Returns true if document is valid, false if not.
        """
        return self(etree)

    def assertValid(self, etree):
        """assertValid(self, etree)

        Raises `DocumentInvalid` if the document does not comply with the schema.
        """
        if not self(etree):
            raise DocumentInvalid(self._error_log._buildExceptionMessage(
                    "Document does not comply with schema"),
                                  self._error_log)

    def assert_(self, etree):
        """assert_(self, etree)

        Raises `AssertionError` if the document does not comply with the schema.
        """
        if not self(etree):
            raise AssertionError, self._error_log._buildExceptionMessage(
                "Document does not comply with schema")

    cpdef _append_log_message(self, int domain, int type, int level, int line,
                              message, filename):
        self._error_log._receiveGeneric(domain, type, level, line, message,
                                        filename)

    cpdef _clear_error_log(self):
        self._error_log.clear()

    @property
    def error_log(self):
        """The log of validation errors and warnings."""
        assert self._error_log is not None, "XPath evaluator not initialised"
        return self._error_log.copy()

include "dtd.pxi"        # DTD
include "relaxng.pxi"    # RelaxNG
include "xmlschema.pxi"  # XMLSchema
include "schematron.pxi" # Schematron (requires libxml2 2.6.21+)

################################################################################
# Public C API

include "public-api.pxi"

################################################################################
# Other stuff

include "debug.pxi"

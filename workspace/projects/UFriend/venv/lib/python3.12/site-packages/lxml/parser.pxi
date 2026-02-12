# Parsers for XML and HTML

from lxml.includes cimport xmlparser
from lxml.includes cimport htmlparser

cdef object _GenericAlias
try:
    from types import GenericAlias as _GenericAlias
except ImportError:
    # Python 3.8 - we only need this as return value from "__class_getitem__"
    def _GenericAlias(cls, item):
        return f"{cls.__name__}[{item.__name__}]"


class ParseError(LxmlSyntaxError):
    """Syntax error while parsing an XML document.

    For compatibility with ElementTree 1.3 and later.
    """
    def __init__(self, message, code, line, column, filename=None):
        super(_ParseError, self).__init__(message)
        self.lineno, self.offset = (line, column - 1)
        self.code = code
        self.filename = filename

    @property
    def position(self):
        return self.lineno, self.offset + 1

    @position.setter
    def position(self, new_pos):
        self.lineno, column = new_pos
        self.offset = column - 1

cdef object _ParseError = ParseError


class XMLSyntaxError(ParseError):
    """Syntax error while parsing an XML document.
    """

cdef class ParserError(LxmlError):
    """Internal lxml parser error.
    """


@cython.final
@cython.internal
cdef class _ParserDictionaryContext:
    # Global parser context to share the string dictionary.
    #
    # This class is a delegate singleton!
    #
    # It creates _ParserDictionaryContext objects for each thread to keep thread state,
    # but those must never be used directly.  Always stick to using the static
    # __GLOBAL_PARSER_CONTEXT as defined below the class.
    #

    cdef tree.xmlDict* _c_dict
    cdef _BaseParser _default_parser
    cdef list _implied_parser_contexts

    def __cinit__(self):
        self._implied_parser_contexts = []

    def __dealloc__(self):
        if self._c_dict is not NULL:
            xmlparser.xmlDictFree(self._c_dict)

    cdef int initMainParserContext(self) except -1:
        """Put the global context into the thread dictionary of the main
        thread.  To be called once and only in the main thread."""
        thread_dict = python.PyThreadState_GetDict()
        if thread_dict is not NULL:
            (<dict>thread_dict)["_ParserDictionaryContext"] = self

    cdef _ParserDictionaryContext _findThreadParserContext(self):
        "Find (or create) the _ParserDictionaryContext object for the current thread"
        cdef _ParserDictionaryContext context
        thread_dict = python.PyThreadState_GetDict()
        if thread_dict is NULL:
            return self
        d = <dict>thread_dict
        result = python.PyDict_GetItem(d, "_ParserDictionaryContext")
        if result is not NULL:
            return <object>result
        context = <_ParserDictionaryContext>_ParserDictionaryContext.__new__(_ParserDictionaryContext)
        d["_ParserDictionaryContext"] = context
        return context

    cdef int setDefaultParser(self, _BaseParser parser) except -1:
        "Set the default parser for the current thread"
        cdef _ParserDictionaryContext context
        context = self._findThreadParserContext()
        context._default_parser = parser

    cdef _BaseParser getDefaultParser(self):
        "Return (or create) the default parser of the current thread"
        cdef _ParserDictionaryContext context
        context = self._findThreadParserContext()
        if context._default_parser is None:
            if self._default_parser is None:
                self._default_parser = __DEFAULT_XML_PARSER._copy()
            if context is not self:
                context._default_parser = self._default_parser._copy()
        return context._default_parser

    cdef tree.xmlDict* _getThreadDict(self, tree.xmlDict* default):
        "Return the thread-local dict or create a new one if necessary."
        cdef _ParserDictionaryContext context
        context = self._findThreadParserContext()
        if context._c_dict is NULL:
            # thread dict not yet set up => use default or create a new one
            if default is not NULL:
                context._c_dict = default
                xmlparser.xmlDictReference(default)
                return default
            if self._c_dict is NULL:
                self._c_dict = xmlparser.xmlDictCreate()
            if context is not self:
                context._c_dict = xmlparser.xmlDictCreateSub(self._c_dict)
        return context._c_dict

    cdef int initThreadDictRef(self, tree.xmlDict** c_dict_ref) except -1:
        c_dict = c_dict_ref[0]
        c_thread_dict = self._getThreadDict(c_dict)
        if c_dict is c_thread_dict:
            return 0
        if c_dict is not NULL:
            xmlparser.xmlDictFree(c_dict)
        c_dict_ref[0] = c_thread_dict
        xmlparser.xmlDictReference(c_thread_dict)

    cdef int initParserDict(self, xmlparser.xmlParserCtxt* pctxt) except -1:
        "Assure we always use the same string dictionary."
        self.initThreadDictRef(&pctxt.dict)
        pctxt.dictNames = 1

    cdef int initXPathParserDict(self, xpath.xmlXPathContext* pctxt) except -1:
        "Assure we always use the same string dictionary."
        self.initThreadDictRef(&pctxt.dict)

    cdef int initDocDict(self, xmlDoc* result) except -1:
        "Store dict of last object parsed if no shared dict yet"
        # XXX We also free the result dict here if there already was one.
        # This case should only occur for new documents with empty dicts,
        # otherwise we'd free data that's in use => segfault
        self.initThreadDictRef(&result.dict)

    cdef _ParserContext findImpliedContext(self):
        """Return any current implied xml parser context for the current
        thread.  This is used when the resolver functions are called
        with an xmlParserCtxt that was generated from within libxml2
        (i.e. without a _ParserContext) - which happens when parsing
        schema and xinclude external references."""
        cdef _ParserDictionaryContext context
        cdef _ParserContext implied_context

        # see if we have a current implied parser
        context = self._findThreadParserContext()
        if context._implied_parser_contexts:
            implied_context = context._implied_parser_contexts[-1]
            return implied_context
        return None

    cdef int pushImpliedContextFromParser(self, _BaseParser parser) except -1:
        "Push a new implied context object taken from the parser."
        if parser is not None:
            self.pushImpliedContext(parser._getParserContext())
        else:
            self.pushImpliedContext(None)

    cdef int pushImpliedContext(self, _ParserContext parser_context) except -1:
        "Push a new implied context object."
        cdef _ParserDictionaryContext context
        context = self._findThreadParserContext()
        context._implied_parser_contexts.append(parser_context)

    cdef int popImpliedContext(self) except -1:
        "Pop the current implied context object."
        cdef _ParserDictionaryContext context
        context = self._findThreadParserContext()
        context._implied_parser_contexts.pop()

cdef _ParserDictionaryContext __GLOBAL_PARSER_CONTEXT = _ParserDictionaryContext()
__GLOBAL_PARSER_CONTEXT.initMainParserContext()

############################################################
## support for Python unicode I/O
############################################################

# name of Python Py_UNICODE encoding as known to libxml2
cdef const_char* _PY_UNICODE_ENCODING = NULL

cdef int _setupPythonUnicode() except -1:
    """Sets _PY_UNICODE_ENCODING to the internal encoding name of Python unicode
    strings if libxml2 supports reading native Python unicode.  This depends
    on iconv and the local Python installation, so we simply check if we find
    a matching encoding handler.
    """
    cdef tree.xmlCharEncodingHandler* enchandler
    cdef Py_ssize_t l
    cdef const_char* enc
    cdef Py_UNICODE *uchars = [c'<', c't', c'e', c's', c't', c'/', c'>']
    cdef const_xmlChar* buffer = <const_xmlChar*>uchars
    # apparently, libxml2 can't detect UTF-16 on some systems
    if (buffer[0] == c'<' and buffer[1] == c'\0' and
            buffer[2] == c't' and buffer[3] == c'\0'):
        enc = "UTF-16LE"
    elif (buffer[0] == c'\0' and buffer[1] == c'<' and
            buffer[2] == c'\0' and buffer[3] == c't'):
        enc = "UTF-16BE"
    else:
        # let libxml2 give it a try
        enc = _findEncodingName(buffer, sizeof(Py_UNICODE) * 7)
        if enc is NULL:
            # not my fault, it's YOUR broken system :)
            return 0
    enchandler = tree.xmlFindCharEncodingHandler(enc)
    if enchandler is not NULL:
        global _PY_UNICODE_ENCODING
        tree.xmlCharEncCloseFunc(enchandler)
        _PY_UNICODE_ENCODING = enc
    return 0

cdef const_char* _findEncodingName(const_xmlChar* buffer, int size):
    "Work around bug in libxml2: find iconv name of encoding on our own."
    cdef tree.xmlCharEncoding enc
    enc = tree.xmlDetectCharEncoding(buffer, size)
    if enc == tree.XML_CHAR_ENCODING_UTF16LE:
        if size >= 4 and (buffer[0] == <const_xmlChar> b'\xFF' and
                          buffer[1] == <const_xmlChar> b'\xFE' and
                          buffer[2] == 0 and buffer[3] == 0):
            return "UTF-32LE"  # according to BOM
        else:
            return "UTF-16LE"
    elif enc == tree.XML_CHAR_ENCODING_UTF16BE:
        return "UTF-16BE"
    elif enc == tree.XML_CHAR_ENCODING_UCS4LE:
        return "UCS-4LE"
    elif enc == tree.XML_CHAR_ENCODING_UCS4BE:
        return "UCS-4BE"
    elif enc == tree.XML_CHAR_ENCODING_NONE:
        return NULL
    else:
        # returns a constant char*, no need to free it
        return tree.xmlGetCharEncodingName(enc)

# Python 3.12 removed support for "Py_UNICODE".
if python.PY_VERSION_HEX < 0x030C0000:
    _setupPythonUnicode()


cdef unicode _find_PyUCS4EncodingName():
    """
    Find a suitable encoding for Py_UCS4 PyUnicode strings in libxml2.
    """
    ustring = "<xml>\U0001F92A</xml>"
    cdef const xmlChar* buffer = <const xmlChar*> python.PyUnicode_DATA(ustring)
    cdef Py_ssize_t py_buffer_len = python.PyUnicode_GET_LENGTH(ustring)

    encoding_name = ''
    cdef tree.xmlCharEncoding enc = tree.xmlDetectCharEncoding(buffer, py_buffer_len)
    enchandler = tree.xmlGetCharEncodingHandler(enc)
    if enchandler is not NULL:
        try:
            if enchandler.name:
                encoding_name = enchandler.name.decode('UTF-8')
        finally:
            tree.xmlCharEncCloseFunc(enchandler)
    else:
        c_name = tree.xmlGetCharEncodingName(enc)
        if c_name:
            encoding_name = c_name.decode('UTF-8')


    if encoding_name and not encoding_name.endswith('LE') and not encoding_name.endswith('BE'):
        encoding_name += 'BE' if python.PY_BIG_ENDIAN else 'LE'
    return encoding_name or None

_pyucs4_encoding_name = _find_PyUCS4EncodingName()


############################################################
## support for file-like objects
############################################################

@cython.final
@cython.internal
cdef class _FileReaderContext:
    cdef object _filelike
    cdef object _encoding
    cdef object _url
    cdef object _bytes
    cdef _ExceptionContext _exc_context
    cdef Py_ssize_t _bytes_read
    cdef char* _c_url
    cdef bint _close_file_after_read

    def __cinit__(self, filelike, exc_context not None, url, encoding=None, bint close_file=False):
        self._exc_context = exc_context
        self._filelike = filelike
        self._close_file_after_read = close_file
        self._encoding = encoding
        if url is not None:
            url = _encodeFilename(url)
            self._c_url = _cstr(url)
        self._url = url
        self._bytes  = b''
        self._bytes_read = 0

    cdef _close_file(self):
        if self._filelike is None or not self._close_file_after_read:
            return
        try:
            close = self._filelike.close
        except AttributeError:
            close = None
        finally:
            self._filelike = None
        if close is not None:
            close()

    cdef xmlparser.xmlParserInputBuffer* _createParserInputBuffer(self) noexcept:
        cdef xmlparser.xmlParserInputBuffer* c_buffer = xmlparser.xmlAllocParserInputBuffer(0)
        if c_buffer:
            c_buffer.readcallback  = _readFilelikeParser
            c_buffer.context = <python.PyObject*> self
        return c_buffer

    cdef xmlparser.xmlParserInput* _createParserInput(
            self, xmlparser.xmlParserCtxt* ctxt) noexcept:
        cdef xmlparser.xmlParserInputBuffer* c_buffer = self._createParserInputBuffer()
        if not c_buffer:
            return NULL
        return xmlparser.xmlNewIOInputStream(ctxt, c_buffer, 0)

    cdef tree.xmlDtd* _readDtd(self) noexcept:
        cdef xmlparser.xmlParserInputBuffer* c_buffer = self._createParserInputBuffer()
        if not c_buffer:
            return NULL
        with nogil:
            return xmlparser.xmlIOParseDTD(NULL, c_buffer, 0)

    cdef xmlDoc* _readDoc(self, xmlparser.xmlParserCtxt* ctxt, int options) noexcept:
        cdef xmlDoc* result
        cdef void* c_callback_context = <python.PyObject*> self
        cdef char* c_encoding = _cstr(self._encoding) if self._encoding is not None else NULL

        orig_options = ctxt.options
        with nogil:
            if ctxt.html:
                result = htmlparser.htmlCtxtReadIO(
                        ctxt, _readFilelikeParser, NULL, c_callback_context,
                        self._c_url, c_encoding, options)
                if result is not NULL:
                    if _fixHtmlDictNames(ctxt.dict, result) < 0:
                        tree.xmlFreeDoc(result)
                        result = NULL
            else:
                result = xmlparser.xmlCtxtReadIO(
                    ctxt, _readFilelikeParser, NULL, c_callback_context,
                    self._c_url, c_encoding, options)
        ctxt.options = orig_options # work around libxml2 problem

        try:
            self._close_file()
        except:
            self._exc_context._store_raised()
        finally:
            return result  # swallow any exceptions

    cdef int copyToBuffer(self, char* c_buffer, int c_requested) noexcept:
        cdef int c_byte_count = 0
        cdef char* c_start
        cdef Py_ssize_t byte_count, remaining
        if self._bytes_read < 0:
            return 0
        try:
            byte_count = python.PyBytes_GET_SIZE(self._bytes)
            remaining  = byte_count - self._bytes_read
            while c_requested > remaining:
                c_start = _cstr(self._bytes) + self._bytes_read
                cstring_h.memcpy(c_buffer, c_start, remaining)
                c_byte_count += remaining
                c_buffer += remaining
                c_requested -= remaining

                self._bytes = self._filelike.read(c_requested)
                if not isinstance(self._bytes, bytes):
                    if isinstance(self._bytes, unicode):
                        if self._encoding is None:
                            self._bytes = (<unicode>self._bytes).encode('utf8')
                        else:
                            self._bytes = python.PyUnicode_AsEncodedString(
                                self._bytes, _cstr(self._encoding), NULL)
                    else:
                        self._close_file()
                        raise TypeError, \
                            "reading from file-like objects must return byte strings or unicode strings"

                remaining = python.PyBytes_GET_SIZE(self._bytes)
                if remaining == 0:
                    self._bytes_read = -1
                    self._close_file()
                    return c_byte_count
                self._bytes_read = 0

            if c_requested > 0:
                c_start = _cstr(self._bytes) + self._bytes_read
                cstring_h.memcpy(c_buffer, c_start, c_requested)
                c_byte_count += c_requested
                self._bytes_read += c_requested
        except:
            c_byte_count = -1
            self._exc_context._store_raised()
            try:
                self._close_file()
            except:
                self._exc_context._store_raised()
        finally:
            return c_byte_count  # swallow any exceptions

cdef int _readFilelikeParser(void* ctxt, char* c_buffer, int c_size) noexcept with gil:
    return (<_FileReaderContext>ctxt).copyToBuffer(c_buffer, c_size)


############################################################
## support for custom document loaders
############################################################

cdef xmlparser.xmlParserInput* _local_resolver(const_char* c_url, const_char* c_pubid,
                                               xmlparser.xmlParserCtxt* c_context) noexcept with gil:
    cdef _ResolverContext context
    cdef xmlparser.xmlParserInput* c_input
    cdef _InputDocument doc_ref
    cdef _FileReaderContext file_context
    # if there is no _ParserContext associated with the xmlParserCtxt
    # passed, check to see if the thread state object has an implied
    # context.
    if c_context._private is not NULL:
        context = <_ResolverContext>c_context._private
    else:
        context = __GLOBAL_PARSER_CONTEXT.findImpliedContext()

    if context is None:
        if __DEFAULT_ENTITY_LOADER is NULL:
            return NULL
        with nogil:
            # free the GIL as we might do serious I/O here (e.g. HTTP)
            c_input = __DEFAULT_ENTITY_LOADER(c_url, c_pubid, c_context)
        return c_input

    try:
        if c_url is NULL:
            url = None
        else:
            # parsing a related document (DTD etc.) => UTF-8 encoded URL?
            url = _decodeFilename(<const_xmlChar*>c_url)
        if c_pubid is NULL:
            pubid = None
        else:
            pubid = funicode(<const_xmlChar*>c_pubid) # always UTF-8

        doc_ref = context._resolvers.resolve(url, pubid, context)
    except:
        context._store_raised()
        return NULL

    if doc_ref is not None:
        if doc_ref._type == PARSER_DATA_STRING:
            data = doc_ref._data_bytes
            filename = doc_ref._filename
            if not filename:
                filename = None
            elif not isinstance(filename, bytes):
                # most likely a text URL
                filename = filename.encode('utf8')
                if not isinstance(filename, bytes):
                    filename = None

            if tree.LIBXML_VERSION >= 21400:
                c_filename = <char *>tree.xmlStrdup(_xcstr(filename)) if filename is not None else NULL
                c_input = xmlparser.xmlNewInputFromMemory(
                    c_filename, _xcstr(data), <size_t> python.PyBytes_GET_SIZE(data), 0)
            else:
                c_input = xmlparser.xmlNewInputStream(c_context)
                if c_input is not NULL:
                    if filename is not None:
                        c_input.filename = <char *>tree.xmlStrdup(_xcstr(filename))
                    c_input.base = _xcstr(data)
                    c_input.length = python.PyBytes_GET_SIZE(data)
                    c_input.cur = c_input.base
                    c_input.end = c_input.base + c_input.length
        elif doc_ref._type == PARSER_DATA_FILENAME:
            data = None
            c_filename = _cstr(doc_ref._filename)
            with nogil:
                # free the GIL as we might do serious I/O here
                c_input = xmlparser.xmlNewInputFromFile(
                    c_context, c_filename)
        elif doc_ref._type == PARSER_DATA_FILE:
            file_context = _FileReaderContext(doc_ref._file, context, url,
                                              None, doc_ref._close_file)
            c_input = file_context._createParserInput(c_context)
            data = file_context
        else:
            data = None
            c_input = NULL

        if data is not None:
            context._storage.add(data)
        if c_input is not NULL:
            return c_input

    if __DEFAULT_ENTITY_LOADER is NULL:
        return NULL

    with nogil:
        # free the GIL as we might do serious I/O here (e.g. HTTP)
        c_input = __DEFAULT_ENTITY_LOADER(c_url, c_pubid, c_context)
    return c_input

cdef xmlparser.xmlExternalEntityLoader __DEFAULT_ENTITY_LOADER
__DEFAULT_ENTITY_LOADER = xmlparser.xmlGetExternalEntityLoader()


cdef xmlparser.xmlExternalEntityLoader _register_document_loader() noexcept nogil:
    cdef xmlparser.xmlExternalEntityLoader old = xmlparser.xmlGetExternalEntityLoader()
    xmlparser.xmlSetExternalEntityLoader(<xmlparser.xmlExternalEntityLoader>_local_resolver)
    return old

cdef void _reset_document_loader(xmlparser.xmlExternalEntityLoader old) noexcept nogil:
    xmlparser.xmlSetExternalEntityLoader(old)


############################################################
## Parsers
############################################################

@cython.no_gc_clear  # May have to call "self._validator.disconnect()" on dealloc.
@cython.internal
cdef class _ParserContext(_ResolverContext):
    cdef _ErrorLog _error_log
    cdef _ParserSchemaValidationContext _validator
    cdef xmlparser.xmlParserCtxt* _c_ctxt
    cdef xmlparser.xmlExternalEntityLoader _orig_loader
    cdef python.PyThread_type_lock _lock
    cdef _Document _doc
    cdef bint _collect_ids

    def __cinit__(self):
        self._collect_ids = True
        if config.ENABLE_THREADING:
            self._lock = python.PyThread_allocate_lock()
        self._error_log = _ErrorLog()

    def __dealloc__(self):
        if config.ENABLE_THREADING and self._lock is not NULL:
            python.PyThread_free_lock(self._lock)
            self._lock = NULL
        if self._c_ctxt is not NULL:
            if <void*>self._validator is not NULL and self._validator is not None:
                # If the parser was not closed correctly (e.g. interrupted iterparse()),
                # and the schema validator wasn't freed and cleaned up yet, the libxml2 SAX
                # validator plug might still be in place, which will make xmlFreeParserCtxt()
                # crash when trying to xmlFree() a static SAX handler.
                # Thus, make sure we disconnect the handler interceptor here at the latest.
                self._validator.disconnect()
            xmlparser.xmlFreeParserCtxt(self._c_ctxt)

    cdef _ParserContext _copy(self):
        cdef _ParserContext context
        context = self.__class__()
        context._collect_ids = self._collect_ids
        context._validator = self._validator.copy()
        _initParserContext(context, self._resolvers._copy(), NULL)
        return context

    cdef void _initParserContext(self, xmlparser.xmlParserCtxt* c_ctxt) noexcept:
        """
        Connects the libxml2-level context to the lxml-level parser context.
        """
        self._c_ctxt = c_ctxt
        c_ctxt._private = <void*>self

    cdef void _resetParserContext(self) noexcept:
        if self._c_ctxt is not NULL:
            if self._c_ctxt.html:
                htmlparser.htmlCtxtReset(self._c_ctxt)
                self._c_ctxt.disableSAX = 0 # work around bug in libxml2
            else:
                xmlparser.xmlClearParserCtxt(self._c_ctxt)
                # work around bug in libxml2 [2.9.10 .. 2.9.14]:
                # https://gitlab.gnome.org/GNOME/libxml2/-/issues/378
                self._c_ctxt.nsNr = 0

    cdef int prepare(self, bint set_document_loader=True) except -1:
        cdef int result
        if config.ENABLE_THREADING and self._lock is not NULL:
            with nogil:
                result = python.PyThread_acquire_lock(
                    self._lock, python.WAIT_LOCK)
            if result == 0:
                raise ParserError, "parser locking failed"
        self._error_log.clear()
        self._doc = None
        # Connect the lxml error log with libxml2's error handling. In the case of parsing
        # HTML, ctxt->sax is not set to null, so this always works. The libxml2 function
        # that does this is htmlInitParserCtxt in HTMLparser.c. For HTML (and possibly XML
        # too), libxml2's SAX's serror is set to be the place where errors are sent when
        # schannel is set to ctxt->sax->serror in xmlCtxtErrMemory in libxml2's
        # parserInternals.c.
        # Need a cast here because older libxml2 releases do not use 'const' in the functype.
        self._c_ctxt.sax.serror = <xmlerror.xmlStructuredErrorFunc> _receiveParserError
        self._orig_loader = _register_document_loader() if set_document_loader else NULL
        if self._validator is not None:
            self._validator.connect(self._c_ctxt, self._error_log)
        return 0

    cdef int cleanup(self) except -1:
        if self._orig_loader is not NULL:
            _reset_document_loader(self._orig_loader)
        try:
            if self._validator is not None:
                self._validator.disconnect()
            self._resetParserContext()
            self.clear()
            self._doc = None
            self._c_ctxt.sax.serror = NULL
        finally:
            if config.ENABLE_THREADING and self._lock is not NULL:
                python.PyThread_release_lock(self._lock)
        return 0

    cdef object _handleParseResult(self, _BaseParser parser,
                                   xmlDoc* result, filename):
        c_doc = self._handleParseResultDoc(parser, result, filename)
        if self._doc is not None and self._doc._c_doc is c_doc:
            return self._doc
        else:
            return _documentFactory(c_doc, parser)

    cdef xmlDoc* _handleParseResultDoc(self, _BaseParser parser,
                                       xmlDoc* result, filename) except NULL:
        recover = parser._parse_options & xmlparser.XML_PARSE_RECOVER
        return _handleParseResult(self, self._c_ctxt, result,
                                  filename, recover,
                                  free_doc=self._doc is None)

cdef _initParserContext(_ParserContext context,
                        _ResolverRegistry resolvers,
                        xmlparser.xmlParserCtxt* c_ctxt):
    _initResolverContext(context, resolvers)
    if c_ctxt is not NULL:
        context._initParserContext(c_ctxt)

cdef void _forwardParserError(xmlparser.xmlParserCtxt* _parser_context, const xmlerror.xmlError* error) noexcept with gil:
    """
    Add an error created by libxml2 to the lxml-level error_log.
    """
    (<_ParserContext>_parser_context._private)._error_log._receive(error)

cdef void _receiveParserError(void* c_context, const xmlerror.xmlError* error) noexcept nogil:
    if __DEBUG:
        if c_context is NULL or (<xmlparser.xmlParserCtxt*>c_context)._private is NULL:
            _forwardError(NULL, error)
        else:
            _forwardParserError(<xmlparser.xmlParserCtxt*>c_context, error)

cdef int _raiseParseError(xmlparser.xmlParserCtxt* ctxt, filename,
                          _ErrorLog error_log) except -1:
    if filename is not None and \
           ctxt.lastError.domain == xmlerror.XML_FROM_IO:
        if isinstance(filename, bytes):
            filename = _decodeFilenameWithLength(
                <bytes>filename, len(<bytes>filename))
        if ctxt.lastError.message is not NULL:
            try:
                message = ctxt.lastError.message.decode('utf-8')
            except UnicodeDecodeError:
                # the filename may be in there => play it safe
                message = ctxt.lastError.message.decode('iso8859-1')
            message = f"Error reading file '{filename}': {message.strip()}"
        else:
            message = f"Error reading '{filename}'"
        raise IOError, message
    elif error_log:
        raise error_log._buildParseException(
            XMLSyntaxError, "Document is not well formed")
    elif ctxt.lastError.message is not NULL:
        message = ctxt.lastError.message.strip()
        code = ctxt.lastError.code
        line = ctxt.lastError.line
        column = ctxt.lastError.int2
        if ctxt.lastError.line > 0:
            message = f"line {line}: {message}"
        raise XMLSyntaxError(message, code, line, column, filename)
    else:
        raise XMLSyntaxError(None, xmlerror.XML_ERR_INTERNAL_ERROR, 0, 0,
                             filename)

cdef xmlDoc* _handleParseResult(_ParserContext context,
                                xmlparser.xmlParserCtxt* c_ctxt,
                                xmlDoc* result, filename,
                                bint recover, bint free_doc) except NULL:
    # The C-level argument xmlDoc* result is passed in as NULL if the parser was not able
    # to parse the document.
    cdef bint well_formed
    if result is not NULL:
        __GLOBAL_PARSER_CONTEXT.initDocDict(result)

    if c_ctxt.myDoc is not NULL:
        if c_ctxt.myDoc is not result:
            __GLOBAL_PARSER_CONTEXT.initDocDict(c_ctxt.myDoc)
            tree.xmlFreeDoc(c_ctxt.myDoc)
        c_ctxt.myDoc = NULL

    if result is not NULL:
        # "wellFormed" in libxml2 is 0 if the parser found fatal errors. It still returns a
        # parse result document if 'recover=True'. Here, we determine if we can present
        # the document to the user or consider it incorrect or broken enough to raise an error.
        if (context._validator is not None and
                not context._validator.isvalid()):
            well_formed = 0  # actually not 'valid', but anyway ...
        elif (not c_ctxt.wellFormed and not c_ctxt.html and
                c_ctxt.charset == tree.XML_CHAR_ENCODING_8859_1 and
                [1 for error in context._error_log
                 if error.type == ErrorTypes.ERR_INVALID_CHAR]):
            # An encoding error occurred and libxml2 switched from UTF-8
            # input to (undecoded) Latin-1, at some arbitrary point in the
            # document.  Better raise an error than allowing for a broken
            # tree with mixed encodings. This is fixed in libxml2 2.12.
            well_formed = 0
        elif recover or (c_ctxt.wellFormed and
                         c_ctxt.lastError.level < xmlerror.XML_ERR_ERROR):
            well_formed = 1
        elif not c_ctxt.replaceEntities and not c_ctxt.validate \
                 and context is not None:
            # in this mode, we ignore errors about undefined entities
            for error in context._error_log.filter_from_errors():
                if error.type != ErrorTypes.WAR_UNDECLARED_ENTITY and \
                       error.type != ErrorTypes.ERR_UNDECLARED_ENTITY:
                    well_formed = 0
                    break
            else:
                well_formed = 1
        else:
            well_formed = 0

        if not well_formed:
            if free_doc:
                tree.xmlFreeDoc(result)
            result = NULL

    if context is not None and context._has_raised():
        if result is not NULL:
            if free_doc:
                tree.xmlFreeDoc(result)
            result = NULL
        context._raise_if_stored()

    if result is NULL:
        if context is not None:
            _raiseParseError(c_ctxt, filename, context._error_log)
        else:
            _raiseParseError(c_ctxt, filename, None)
    else:
        if result.URL is NULL and filename is not None:
            result.URL = tree.xmlStrdup(_xcstr(filename))
        if result.encoding is NULL:
            result.encoding = tree.xmlStrdup(<unsigned char*>"UTF-8")

    if context._validator is not None and \
           context._validator._add_default_attributes:
        # we currently need to do this here as libxml2 does not
        # support inserting default attributes during parse-time
        # validation
        context._validator.inject_default_attributes(result)

    return result

cdef int _fixHtmlDictNames(tree.xmlDict* c_dict, xmlDoc* c_doc) noexcept nogil:
    cdef xmlNode* c_node
    if c_doc is NULL:
        return 0
    c_node = c_doc.children
    tree.BEGIN_FOR_EACH_ELEMENT_FROM(<xmlNode*>c_doc, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        if _fixHtmlDictNodeNames(c_dict, c_node) < 0:
            return -1
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)
    return 0

cdef int _fixHtmlDictSubtreeNames(tree.xmlDict* c_dict, xmlDoc* c_doc,
                                  xmlNode* c_start_node) noexcept nogil:
    """
    Move names to the dict, iterating in document order, starting at
    c_start_node. This is used in incremental parsing after each chunk.
    """
    cdef xmlNode* c_node
    if not c_doc:
        return 0
    if not c_start_node:
        return _fixHtmlDictNames(c_dict, c_doc)
    c_node = c_start_node
    tree.BEGIN_FOR_EACH_ELEMENT_FROM(<xmlNode*>c_doc, c_node, 1)
    if c_node.type == tree.XML_ELEMENT_NODE:
        if _fixHtmlDictNodeNames(c_dict, c_node) < 0:
            return -1
    tree.END_FOR_EACH_ELEMENT_FROM(c_node)
    return 0

cdef inline int _fixHtmlDictNodeNames(tree.xmlDict* c_dict,
                                      xmlNode* c_node) noexcept nogil:
    cdef xmlNode* c_attr
    c_name = tree.xmlDictLookup(c_dict, c_node.name, -1)
    if c_name is NULL:
        return -1
    if c_name is not c_node.name:
        tree.xmlFree(<char*>c_node.name)
        c_node.name = c_name
    c_attr = <xmlNode*>c_node.properties
    while c_attr is not NULL:
        c_name = tree.xmlDictLookup(c_dict, c_attr.name, -1)
        if c_name is NULL:
            return -1
        if c_name is not c_attr.name:
            tree.xmlFree(<char*>c_attr.name)
            c_attr.name = c_name
        c_attr = c_attr.next
    return 0


@cython.internal
cdef class _BaseParser:
    cdef ElementClassLookup _class_lookup
    cdef _ResolverRegistry _resolvers
    cdef _ParserContext _parser_context
    cdef _ParserContext _push_parser_context
    cdef int _parse_options
    cdef bint _for_html
    cdef bint _remove_comments
    cdef bint _remove_pis
    cdef bint _strip_cdata
    cdef bint _collect_ids
    cdef bint _resolve_external_entities
    cdef XMLSchema _schema
    cdef bytes _filename
    cdef readonly object target
    cdef object _default_encoding
    cdef tuple _events_to_collect  # (event_types, tag)

    def __init__(self, int parse_options, bint for_html, XMLSchema schema,
                 remove_comments, remove_pis, strip_cdata, collect_ids,
                 target, encoding, bint resolve_external_entities=True):
        cdef tree.xmlCharEncodingHandler* enchandler
        cdef int c_encoding
        if not isinstance(self, (XMLParser, HTMLParser)):
            raise TypeError, "This class cannot be instantiated"

        if not collect_ids and tree.LIBXML_VERSION >= 21500:
            parse_options |= xmlparser.XML_PARSE_SKIP_IDS

        self._parse_options = parse_options
        self.target = target
        self._for_html = for_html
        self._remove_comments = remove_comments
        self._remove_pis = remove_pis
        self._strip_cdata = strip_cdata
        self._collect_ids = collect_ids
        self._resolve_external_entities = resolve_external_entities
        self._schema = schema

        self._resolvers = _ResolverRegistry()

        if encoding is None:
            self._default_encoding = None
        else:
            encoding = _utf8(encoding)
            enchandler = tree.xmlFindCharEncodingHandler(_cstr(encoding))
            if enchandler is NULL:
                raise LookupError, f"unknown encoding: '{encoding}'"
            tree.xmlCharEncCloseFunc(enchandler)
            self._default_encoding = encoding

    cdef _setBaseURL(self, base_url):
        self._filename = _encodeFilename(base_url)

    cdef _collectEvents(self, event_types, tag):
        if event_types is None:
            event_types = ()
        else:
            event_types = tuple(set(event_types))
            _buildParseEventFilter(event_types)  # purely for validation
        self._events_to_collect = (event_types, tag)

    cdef _ParserContext _getParserContext(self):
        cdef xmlparser.xmlParserCtxt* pctxt
        if self._parser_context is None:
            self._parser_context = self._createContext(self.target, None)
            self._parser_context._collect_ids = self._collect_ids
            if self._schema is not None:
                self._parser_context._validator = \
                    self._schema._newSaxValidator(
                        self._parse_options & xmlparser.XML_PARSE_DTDATTR)
            pctxt = self._newParserCtxt()
            _initParserContext(self._parser_context, self._resolvers, pctxt)
            self._configureSaxContext(pctxt)
        return self._parser_context

    cdef _ParserContext _getPushParserContext(self):
        cdef xmlparser.xmlParserCtxt* pctxt
        if self._push_parser_context is None:
            self._push_parser_context = self._createContext(
                self.target, self._events_to_collect)
            self._push_parser_context._collect_ids = self._collect_ids
            if self._schema is not None:
                self._push_parser_context._validator = \
                    self._schema._newSaxValidator(
                        self._parse_options & xmlparser.XML_PARSE_DTDATTR)
            pctxt = self._newPushParserCtxt()
            _initParserContext(
                self._push_parser_context, self._resolvers, pctxt)
            self._configureSaxContext(pctxt)
        return self._push_parser_context

    cdef _ParserContext _createContext(self, target, events_to_collect):
        """
        This method creates and configures the lxml-level parser.
        """
        cdef _SaxParserContext sax_context
        if target is not None:
            sax_context = _TargetParserContext(self)
            (<_TargetParserContext>sax_context)._setTarget(target)
        elif events_to_collect:
            sax_context = _SaxParserContext(self)
        else:
            # nothing special to configure
            return _ParserContext()
        if events_to_collect:
            events, tag = events_to_collect
            sax_context._setEventFilter(events, tag)
        return sax_context

    @cython.final
    cdef int _configureSaxContext(self, xmlparser.xmlParserCtxt* pctxt) except -1:
        if self._remove_comments:
            pctxt.sax.comment = NULL
        if self._remove_pis:
            pctxt.sax.processingInstruction = NULL
        if self._strip_cdata:
            # hard switch-off for CDATA nodes => makes them plain text
            pctxt.sax.cdataBlock = NULL
        if not self._resolve_external_entities:
            pctxt.sax.getEntity = _getInternalEntityOnly

    cdef int _registerHtmlErrorHandler(self, xmlparser.xmlParserCtxt* c_ctxt) except -1:
        cdef xmlparser.xmlSAXHandler* sax = c_ctxt.sax
        if sax is not NULL and sax.initialized and sax.initialized != xmlparser.XML_SAX2_MAGIC:
            # need to extend SAX1 context to SAX2 to get proper error reports
            if <xmlparser.xmlSAXHandlerV1*>sax is &htmlparser.htmlDefaultSAXHandler:
                sax = <xmlparser.xmlSAXHandler*> tree.xmlMalloc(sizeof(xmlparser.xmlSAXHandler))
                if sax is NULL:
                    raise MemoryError()
                cstring_h.memcpy(sax, &htmlparser.htmlDefaultSAXHandler,
                                 sizeof(htmlparser.htmlDefaultSAXHandler))
                c_ctxt.sax = sax
            sax.initialized = xmlparser.XML_SAX2_MAGIC
            # Need a cast here because older libxml2 releases do not use 'const' in the functype.
            sax.serror = <xmlerror.xmlStructuredErrorFunc> _receiveParserError
            sax.startElementNs = NULL
            sax.endElementNs = NULL
            sax._private = NULL
        return 0

    cdef xmlparser.xmlParserCtxt* _newParserCtxt(self) except NULL:
        """
        Create and initialise a libxml2-level parser context.
        """
        cdef xmlparser.xmlParserCtxt* c_ctxt
        if self._for_html:
            c_ctxt = htmlparser.htmlCreateMemoryParserCtxt('dummy', 5)
            if c_ctxt is not NULL:
                self._registerHtmlErrorHandler(c_ctxt)
        else:
            c_ctxt = xmlparser.xmlNewParserCtxt()
        if c_ctxt is NULL:
            raise MemoryError
        c_ctxt.sax.startDocument = _initSaxDocument
        return c_ctxt

    cdef xmlparser.xmlParserCtxt* _newPushParserCtxt(self) except NULL:
        cdef xmlparser.xmlParserCtxt* c_ctxt
        cdef char* c_filename = _cstr(self._filename) if self._filename is not None else NULL
        if self._for_html:
            c_ctxt = htmlparser.htmlCreatePushParserCtxt(
                NULL, NULL, NULL, 0, c_filename, tree.XML_CHAR_ENCODING_NONE)
            if c_ctxt is not NULL:
                self._registerHtmlErrorHandler(c_ctxt)
                htmlparser.htmlCtxtUseOptions(c_ctxt, self._parse_options)
        else:
            c_ctxt = xmlparser.xmlCreatePushParserCtxt(
                NULL, NULL, NULL, 0, c_filename)
            if c_ctxt is not NULL:
                xmlparser.xmlCtxtUseOptions(c_ctxt, self._parse_options)
        if c_ctxt is NULL:
            raise MemoryError()
        c_ctxt.sax.startDocument = _initSaxDocument
        return c_ctxt

    @property
    def error_log(self):
        """The error log of the last parser run.
        """
        cdef _ParserContext context
        context = self._getParserContext()
        return context._error_log.copy()

    @property
    def resolvers(self):
        """The custom resolver registry of this parser."""
        return self._resolvers

    @property
    def version(self):
        """The version of the underlying XML parser."""
        return "libxml2 %d.%d.%d" % LIBXML_VERSION

    def set_element_class_lookup(self, ElementClassLookup lookup = None):
        """set_element_class_lookup(self, lookup = None)

        Set a lookup scheme for element classes generated from this parser.

        Reset it by passing None or nothing.
        """
        self._class_lookup = lookup

    cdef _BaseParser _copy(self):
        "Create a new parser with the same configuration."
        cdef _BaseParser parser
        parser = self.__class__()
        parser._parse_options = self._parse_options
        parser._for_html = self._for_html
        parser._remove_comments = self._remove_comments
        parser._remove_pis = self._remove_pis
        parser._strip_cdata = self._strip_cdata
        parser._filename = self._filename
        parser._resolvers = self._resolvers
        parser.target = self.target
        parser._class_lookup  = self._class_lookup
        parser._default_encoding = self._default_encoding
        parser._schema = self._schema
        parser._events_to_collect = self._events_to_collect
        return parser

    def copy(self):
        """copy(self)

        Create a new parser with the same configuration.
        """
        return self._copy()

    def makeelement(self, _tag, attrib=None, nsmap=None, **_extra):
        """makeelement(self, _tag, attrib=None, nsmap=None, **_extra)

        Creates a new element associated with this parser.
        """
        return _makeElement(_tag, NULL, None, self, None, None,
                            attrib, nsmap, _extra)

    # internal parser methods

    cdef xmlDoc* _parseUnicodeDoc(self, utext, char* c_filename) except NULL:
        """Parse unicode document, share dictionary if possible.
        """
        cdef _ParserContext context
        cdef xmlDoc* result
        cdef xmlparser.xmlParserCtxt* pctxt
        cdef Py_ssize_t py_buffer_len
        cdef int buffer_len, c_kind
        cdef const_char* c_text
        cdef const_char* c_encoding = _PY_UNICODE_ENCODING
        if python.PyUnicode_IS_READY(utext):
            # PEP-393 string
            c_text = <const_char*>python.PyUnicode_DATA(utext)
            py_buffer_len = python.PyUnicode_GET_LENGTH(utext)
            c_kind = python.PyUnicode_KIND(utext)
            if c_kind == 1:
                if python.PyUnicode_MAX_CHAR_VALUE(utext) <= 127:
                    c_encoding = 'UTF-8'
                else:
                    c_encoding = 'ISO-8859-1'
            elif c_kind == 2:
                py_buffer_len *= 2
                if python.PY_BIG_ENDIAN:
                    c_encoding = 'UTF-16BE'  # actually UCS-2
                else:
                    c_encoding = 'UTF-16LE'  # actually UCS-2
            elif c_kind == 4:
                py_buffer_len *= 4
                if python.PY_BIG_ENDIAN:
                    c_encoding = 'UTF-32BE'  # actually UCS-4
                else:
                    c_encoding = 'UTF-32LE'  # actually UCS-4
            else:
                assert False, f"Illegal Unicode kind {c_kind}"
        else:
            # old Py_UNICODE string
            py_buffer_len = python.PyUnicode_GET_DATA_SIZE(utext)
            c_text = python.PyUnicode_AS_DATA(utext)
        assert 0 <= py_buffer_len <= limits.INT_MAX
        buffer_len = py_buffer_len

        context = self._getParserContext()
        context.prepare()
        try:
            pctxt = context._c_ctxt
            __GLOBAL_PARSER_CONTEXT.initParserDict(pctxt)
            orig_options = pctxt.options
            with nogil:
                if self._for_html:
                    result = htmlparser.htmlCtxtReadMemory(
                        pctxt, c_text, buffer_len, c_filename, c_encoding,
                        self._parse_options)
                    if result is not NULL:
                        if _fixHtmlDictNames(pctxt.dict, result) < 0:
                            tree.xmlFreeDoc(result)
                            result = NULL
                else:
                    result = xmlparser.xmlCtxtReadMemory(
                        pctxt, c_text, buffer_len, c_filename, c_encoding,
                        self._parse_options)
            pctxt.options = orig_options # work around libxml2 problem

            return context._handleParseResultDoc(self, result, None)
        finally:
            context.cleanup()

    cdef xmlDoc* _parseDoc(self, const char* c_text, int c_len, char* c_filename) except NULL:
        """Parse document, share dictionary if possible.
        """
        cdef _ParserContext context
        cdef xmlDoc* result
        cdef xmlparser.xmlParserCtxt* pctxt
        cdef char* c_encoding
        cdef tree.xmlCharEncoding enc
        context = self._getParserContext()
        context.prepare()
        try:
            pctxt = context._c_ctxt
            __GLOBAL_PARSER_CONTEXT.initParserDict(pctxt)

            if self._default_encoding is None:
                c_encoding = NULL
                # libxml2 (at least 2.9.3) does not recognise UTF-32 BOMs
                # NOTE: limit to problematic cases because it changes character offsets
                if c_len >= 4 and (c_text[0] == b'\xFF' and c_text[1] == b'\xFE' and
                                   c_text[2] == 0 and c_text[3] == 0):
                    c_encoding = "UTF-32LE"
                    c_text += 4
                    c_len -= 4
                elif c_len >= 4 and (c_text[0] == 0 and c_text[1] == 0 and
                                     c_text[2] == b'\xFE' and c_text[3] == b'\xFF'):
                    c_encoding = "UTF-32BE"
                    c_text += 4
                    c_len -= 4
                else:
                    # no BOM => try to determine encoding
                    enc = tree.xmlDetectCharEncoding(<const_xmlChar*>c_text, c_len)
                    if enc == tree.XML_CHAR_ENCODING_UCS4LE:
                        c_encoding = 'UTF-32LE'
                    elif enc == tree.XML_CHAR_ENCODING_UCS4BE:
                        c_encoding = 'UTF-32BE'
            else:
                c_encoding = _cstr(self._default_encoding)

            orig_options = pctxt.options
            with nogil:
                if self._for_html:
                    result = htmlparser.htmlCtxtReadMemory(
                        pctxt, c_text, c_len, c_filename,
                        c_encoding, self._parse_options)
                    if result is not NULL:
                        if _fixHtmlDictNames(pctxt.dict, result) < 0:
                            tree.xmlFreeDoc(result)
                            result = NULL
                else:
                    result = xmlparser.xmlCtxtReadMemory(
                        pctxt, c_text, c_len, c_filename,
                        c_encoding, self._parse_options)
            pctxt.options = orig_options # work around libxml2 problem

            return context._handleParseResultDoc(self, result, None)
        finally:
            context.cleanup()

    cdef xmlDoc* _parseDocFromFile(self, char* c_filename) except NULL:
        cdef _ParserContext context
        cdef xmlDoc* result
        cdef xmlparser.xmlParserCtxt* pctxt
        cdef char* c_encoding
        result = NULL

        context = self._getParserContext()
        context.prepare()
        try:
            pctxt = context._c_ctxt
            __GLOBAL_PARSER_CONTEXT.initParserDict(pctxt)

            if self._default_encoding is None:
                c_encoding = NULL
            else:
                c_encoding = _cstr(self._default_encoding)

            orig_options = pctxt.options
            with nogil:
                if self._for_html:
                    result = htmlparser.htmlCtxtReadFile(
                        pctxt, c_filename, c_encoding, self._parse_options)
                    if result is not NULL:
                        if _fixHtmlDictNames(pctxt.dict, result) < 0:
                            tree.xmlFreeDoc(result)
                            result = NULL
                else:
                    result = xmlparser.xmlCtxtReadFile(
                        pctxt, c_filename, c_encoding, self._parse_options)
            pctxt.options = orig_options # work around libxml2 problem

            return context._handleParseResultDoc(self, result, c_filename)
        finally:
            context.cleanup()

    cdef xmlDoc* _parseDocFromFilelike(self, filelike, filename,
                                       encoding) except NULL:
        cdef _ParserContext context
        cdef _FileReaderContext file_context
        cdef xmlDoc* result
        cdef xmlparser.xmlParserCtxt* pctxt
        cdef char* c_filename
        if not filename:
            filename = None

        context = self._getParserContext()
        context.prepare()
        try:
            pctxt = context._c_ctxt
            __GLOBAL_PARSER_CONTEXT.initParserDict(pctxt)
            file_context = _FileReaderContext(
                filelike, context, filename,
                encoding or self._default_encoding)
            result = file_context._readDoc(pctxt, self._parse_options)

            return context._handleParseResultDoc(
                self, result, filename)
        finally:
            context.cleanup()


cdef tree.xmlEntity* _getInternalEntityOnly(void* ctxt, const_xmlChar* name) noexcept nogil:
    """
    Callback function to intercept the entity resolution when external entity loading is disabled.
    """
    cdef tree.xmlEntity* entity = xmlparser.xmlSAX2GetEntity(ctxt, name)
    if not entity:
        return NULL
    if entity.etype not in (
            tree.xmlEntityType.XML_EXTERNAL_GENERAL_PARSED_ENTITY,
            tree.xmlEntityType.XML_EXTERNAL_GENERAL_UNPARSED_ENTITY,
            tree.xmlEntityType.XML_EXTERNAL_PARAMETER_ENTITY):
        return entity

    # Reject all external entities and fail the parsing instead. There is currently
    # no way in libxml2 to just prevent the entity resolution in this case.
    cdef xmlerror.xmlError c_error
    cdef xmlerror.xmlStructuredErrorFunc err_func
    cdef xmlparser.xmlParserInput* parser_input
    cdef void* err_context

    c_ctxt = <xmlparser.xmlParserCtxt *> ctxt
    err_func = xmlerror.xmlStructuredError
    if err_func:
        parser_input = c_ctxt.input
        # Copied from xmlVErrParser() in libxml2: get current input from stack.
        if parser_input and parser_input.filename is NULL and c_ctxt.inputNr > 1:
            parser_input = c_ctxt.inputTab[c_ctxt.inputNr - 2]

        c_error = xmlerror.xmlError(
            domain=xmlerror.xmlErrorDomain.XML_FROM_PARSER,
            code=xmlerror.xmlParserErrors.XML_ERR_EXT_ENTITY_STANDALONE,
            level=xmlerror.xmlErrorLevel.XML_ERR_FATAL,
            message=b"External entity resolution is disabled for security reasons "
                    b"when resolving '&%s;'. Use 'XMLParser(resolve_entities=True)' "
                    b"if you consider it safe to enable it.",
            file=parser_input.filename,
            node=entity,
            str1=<char*> name,
            str2=NULL,
            str3=NULL,
            line=parser_input.line if parser_input else 0,
            int1=0,
            int2=parser_input.col if parser_input else 0,
        )
        err_context = xmlerror.xmlStructuredErrorContext
        err_func(err_context, &c_error)

    c_ctxt.wellFormed = 0
    # The entity was looked up and does not need to be freed.
    return NULL


cdef void _initSaxDocument(void* ctxt) noexcept with gil:
    xmlparser.xmlSAX2StartDocument(ctxt)
    c_ctxt = <xmlparser.xmlParserCtxt*>ctxt
    c_doc = c_ctxt.myDoc

    # set up document dict
    if c_doc and c_ctxt.dict and not c_doc.dict:
        # I have no idea why libxml2 disables this - we need it
        c_ctxt.dictNames = 1
        c_doc.dict = c_ctxt.dict
        xmlparser.xmlDictReference(c_ctxt.dict)

    # set up XML ID hash table
    if c_ctxt._private:
        context = <_ParserContext>c_ctxt._private
        if context._collect_ids:
            # keep the global parser dict from filling up with XML IDs
            if c_doc and not c_doc.ids:
                # memory errors are not fatal here
                c_dict = xmlparser.xmlDictCreate()
                if c_dict:
                    c_doc.ids = tree.xmlHashCreateDict(0, c_dict)
                    xmlparser.xmlDictFree(c_dict)
                else:
                    c_doc.ids = tree.xmlHashCreate(0)
        else:
            c_ctxt.loadsubset |= xmlparser.XML_SKIP_IDS
            if c_doc and c_doc.ids and not tree.xmlHashSize(c_doc.ids):
                # already initialised but empty => clear
                tree.xmlHashFree(c_doc.ids, NULL)
                c_doc.ids = NULL


############################################################
## ET feed parser
############################################################

cdef class _FeedParser(_BaseParser):
    cdef bint _feed_parser_running

    @property
    def feed_error_log(self):
        """The error log of the last (or current) run of the feed parser.

        Note that this is local to the feed parser and thus is
        different from what the ``error_log`` property returns.
        """
        return self._getPushParserContext()._error_log.copy()

    cpdef feed(self, data):
        """feed(self, data)

        Feeds data to the parser.  The argument should be an 8-bit string
        buffer containing encoded data, although Unicode is supported as long
        as both string types are not mixed.

        This is the main entry point to the consumer interface of a
        parser.  The parser will parse as much of the XML stream as it
        can on each call.  To finish parsing or to reset the parser,
        call the ``close()`` method.  Both methods may raise
        ParseError if errors occur in the input data.  If an error is
        raised, there is no longer a need to call ``close()``.

        The feed parser interface is independent of the normal parser
        usage.  You can use the same parser as a feed parser and in
        the ``parse()`` function concurrently.
        """
        cdef _ParserContext context
        cdef bytes bstring
        cdef xmlparser.xmlParserCtxt* pctxt
        cdef Py_ssize_t py_buffer_len, ustart
        cdef const_char* char_data
        cdef const_char* c_encoding
        cdef int buffer_len
        cdef int error
        cdef bint recover = self._parse_options & xmlparser.XML_PARSE_RECOVER

        if isinstance(data, bytes):
            if self._default_encoding is None:
                c_encoding = NULL
            else:
                c_encoding = self._default_encoding
            char_data = _cstr(data)
            py_buffer_len = python.PyBytes_GET_SIZE(data)
            ustart = 0
        elif isinstance(data, unicode):
            c_encoding = b"UTF-8"
            char_data = NULL
            py_buffer_len = len(<unicode> data)
            ustart = 0
        else:
            raise TypeError, "Parsing requires string data"

        context = self._getPushParserContext()
        pctxt = context._c_ctxt
        error = 0
        if not self._feed_parser_running:
            context.prepare(set_document_loader=False)
            self._feed_parser_running = 1
            c_filename = (_cstr(self._filename)
                          if self._filename is not None else NULL)

            # We have to give *mlCtxtResetPush() enough input to figure
            # out the character encoding (at least four bytes),
            # however if we give it all we got, we'll have nothing for
            # *mlParseChunk() and things go wrong.
            buffer_len = 0
            if char_data is not NULL:
                buffer_len = 4 if py_buffer_len > 4 else <int>py_buffer_len
            orig_loader = _register_document_loader()
            if self._for_html:
                error = _htmlCtxtResetPush(
                    pctxt, char_data, buffer_len, c_filename, c_encoding,
                    self._parse_options)
            else:
                xmlparser.xmlCtxtUseOptions(pctxt, self._parse_options)
                error = xmlparser.xmlCtxtResetPush(
                    pctxt, char_data, buffer_len, c_filename, c_encoding)
            _reset_document_loader(orig_loader)
            py_buffer_len -= buffer_len
            char_data += buffer_len
            if error:
                raise MemoryError()
            __GLOBAL_PARSER_CONTEXT.initParserDict(pctxt)

        #print pctxt.charset, 'NONE' if c_encoding is NULL else c_encoding

        fixup_error = 0
        while py_buffer_len > 0 and (error == 0 or recover):
            if char_data is NULL:
                # Unicode parsing by converting chunks to UTF-8
                buffer_len = 2**19  # len(bytes) <= 4 * (2**19) == 2 MiB
                bstring = (<unicode> data)[ustart : ustart+buffer_len].encode('UTF-8')
                ustart += buffer_len
                py_buffer_len -= buffer_len  # may end up < 0
                error, fixup_error = _parse_data_chunk(pctxt, <const char*> bstring, <int> len(bstring))
            else:
                # Direct byte string parsing.
                buffer_len = <int>py_buffer_len if py_buffer_len <= limits.INT_MAX else limits.INT_MAX
                error, fixup_error = _parse_data_chunk(pctxt, char_data, buffer_len)
                py_buffer_len -= buffer_len
                char_data += buffer_len

            if fixup_error:
                context.store_exception(MemoryError())

            if context._has_raised():
                # propagate Python exceptions immediately
                recover = 0
                error = 1
                break

            if error and not pctxt.replaceEntities and not pctxt.validate:
                # in this mode, we ignore errors about undefined entities
                for entry in context._error_log.filter_from_errors():
                    if entry.type != ErrorTypes.WAR_UNDECLARED_ENTITY and \
                           entry.type != ErrorTypes.ERR_UNDECLARED_ENTITY:
                        break
                else:
                    error = 0

        if not pctxt.wellFormed and xmlparser.xmlCtxtIsStopped(pctxt) and context._has_raised():
            # propagate Python exceptions immediately
            recover = 0
            error = 1

        if fixup_error or not recover and (error or not pctxt.wellFormed):
            self._feed_parser_running = 0
            try:
                context._handleParseResult(self, pctxt.myDoc, None)
            finally:
                context.cleanup()

    cpdef close(self):
        """close(self)

        Terminates feeding data to this parser.  This tells the parser to
        process any remaining data in the feed buffer, and then returns the
        root Element of the tree that was parsed.

        This method must be called after passing the last chunk of data into
        the ``feed()`` method.  It should only be called when using the feed
        parser interface, all other usage is undefined.
        """
        if not self._feed_parser_running:
            raise XMLSyntaxError("no element found",
                                 xmlerror.XML_ERR_INTERNAL_ERROR, 0, 0,
                                 self._filename)

        context = self._getPushParserContext()
        pctxt = context._c_ctxt

        self._feed_parser_running = 0
        if self._for_html:
            htmlparser.htmlParseChunk(pctxt, NULL, 0, 1)
        else:
            xmlparser.xmlParseChunk(pctxt, NULL, 0, 1)

        if (pctxt.recovery and not xmlparser.xmlCtxtIsStopped(pctxt) and
                isinstance(context, _SaxParserContext)):
            # apply any left-over 'end' events
            (<_SaxParserContext>context).flushEvents()

        try:
            result = context._handleParseResult(self, pctxt.myDoc, None)
        finally:
            context.cleanup()

        if isinstance(result, _Document):
            return (<_Document>result).getroot()
        else:
            return result


cdef (int, int) _parse_data_chunk(xmlparser.xmlParserCtxt* c_ctxt,
                                  const char* char_data, int buffer_len):
    fixup_error = 0
    with nogil:
        if c_ctxt.html:
            c_node = c_ctxt.node  # last node where the parser stopped
            orig_loader = _register_document_loader()
            error = htmlparser.htmlParseChunk(c_ctxt, char_data, buffer_len, 0)
            _reset_document_loader(orig_loader)
            # and now for the fun part: move node names to the dict
            if c_ctxt.myDoc:
                fixup_error = _fixHtmlDictSubtreeNames(
                    c_ctxt.dict, c_ctxt.myDoc, c_node)
                if c_ctxt.myDoc.dict and c_ctxt.myDoc.dict is not c_ctxt.dict:
                    xmlparser.xmlDictFree(c_ctxt.myDoc.dict)
                    c_ctxt.myDoc.dict = c_ctxt.dict
                    xmlparser.xmlDictReference(c_ctxt.dict)
        else:
            orig_loader = _register_document_loader()
            error = xmlparser.xmlParseChunk(c_ctxt, char_data, buffer_len, 0)
            _reset_document_loader(orig_loader)
    return (error, fixup_error)


cdef int _htmlCtxtResetPush(xmlparser.xmlParserCtxt* c_ctxt,
                             const_char* c_data, int buffer_len,
                             const_char* c_filename, const_char* c_encoding,
                             int parse_options) except -1:
    cdef xmlparser.xmlParserInput* c_input_stream
    # libxml2 lacks an HTML push parser setup function
    error = xmlparser.xmlCtxtResetPush(
        c_ctxt, c_data, buffer_len, c_filename, c_encoding)
    if error:
        return error

    # fix libxml2 setup for HTML
    if tree.LIBXML_VERSION < 21400:
        c_ctxt.progressive = 1  # TODO: remove
    c_ctxt.html = 1
    htmlparser.htmlCtxtUseOptions(c_ctxt, parse_options)

    return 0


############################################################
## XML parser
############################################################

cdef int _XML_DEFAULT_PARSE_OPTIONS
_XML_DEFAULT_PARSE_OPTIONS = (
    xmlparser.XML_PARSE_NOENT   |
    xmlparser.XML_PARSE_NOCDATA |
    xmlparser.XML_PARSE_NONET   |
    xmlparser.XML_PARSE_COMPACT |
    xmlparser.XML_PARSE_BIG_LINES
)

cdef class XMLParser(_FeedParser):
    """XMLParser(self, encoding=None, attribute_defaults=False, dtd_validation=False, \
                 load_dtd=False, no_network=True, decompress=False, ns_clean=False, \
                 recover=False, schema: XMLSchema =None, huge_tree=False, \
                 remove_blank_text=False, resolve_entities=True, \
                 remove_comments=False, remove_pis=False, strip_cdata=True, \
                 collect_ids=True, target=None, compact=True)

    The XML parser.

    Parsers can be supplied as additional argument to various parse
    functions of the lxml API.  A default parser is always available
    and can be replaced by a call to the global function
    'set_default_parser'.  New parsers can be created at any time
    without a major run-time overhead.

    The keyword arguments in the constructor are mainly based on the
    libxml2 parser configuration.  A DTD will also be loaded if DTD
    validation or attribute default values are requested (unless you
    additionally provide an XMLSchema from which the default
    attributes can be read).

    Available boolean keyword arguments:

    - attribute_defaults - inject default attributes from DTD or XMLSchema
    - dtd_validation     - validate against a DTD referenced by the document
    - load_dtd           - use DTD for parsing
    - no_network         - prevent network access for related files (default: True)
    - decompress         - automatically decompress gzip input
                           (default: False, changed in lxml 6.0, disabling only affects libxml2 2.15+)
    - ns_clean           - clean up redundant namespace declarations
    - recover            - try hard to parse through broken XML
    - remove_blank_text  - discard blank text nodes that appear ignorable
    - remove_comments    - discard comments
    - remove_pis         - discard processing instructions
    - strip_cdata        - replace CDATA sections by normal text content (default: True)
    - compact            - save memory for short text content (default: True)
    - collect_ids        - use a hash table of XML IDs for fast access
                           (default: True, always True with DTD validation)
    - huge_tree          - disable security restrictions and support very deep trees
                           and very long text content

    Other keyword arguments:

    - resolve_entities - replace entities by their text value: False for keeping the
          entity references, True for resolving them, and 'internal' for resolving
          internal definitions only (no external file/URL access).
          The default used to be True and was changed to 'internal' in lxml 5.0.
    - encoding - override the document encoding (note: libiconv encoding name)
    - target   - a parser target object that will receive the parse events
    - schema   - an XMLSchema to validate against

    Note that you should avoid sharing parsers between threads.  While this is
    not harmful, it is more efficient to use separate parsers.  This does not
    apply to the default parser.
    """
    def __init__(self, *, encoding=None, attribute_defaults=False,
                 dtd_validation=False, load_dtd=False, no_network=True, decompress=False,
                 ns_clean=False, recover=False, XMLSchema schema=None,
                 huge_tree=False, remove_blank_text=False, resolve_entities='internal',
                 remove_comments=False, remove_pis=False, strip_cdata=True,
                 collect_ids=True, target=None, compact=True):
        cdef int parse_options
        cdef bint resolve_external = True
        parse_options = _XML_DEFAULT_PARSE_OPTIONS
        if load_dtd:
            parse_options = parse_options | xmlparser.XML_PARSE_DTDLOAD
        if dtd_validation:
            parse_options = parse_options | xmlparser.XML_PARSE_DTDVALID | \
                            xmlparser.XML_PARSE_DTDLOAD
        if attribute_defaults:
            parse_options = parse_options | xmlparser.XML_PARSE_DTDATTR
            if schema is None:
                parse_options = parse_options | xmlparser.XML_PARSE_DTDLOAD
        if ns_clean:
            parse_options = parse_options | xmlparser.XML_PARSE_NSCLEAN
        if recover:
            parse_options = parse_options | xmlparser.XML_PARSE_RECOVER
        if remove_blank_text:
            parse_options = parse_options | xmlparser.XML_PARSE_NOBLANKS
        if huge_tree:
            parse_options = parse_options | xmlparser.XML_PARSE_HUGE
        if not no_network:
            parse_options = parse_options ^ xmlparser.XML_PARSE_NONET
        if not compact:
            parse_options = parse_options ^ xmlparser.XML_PARSE_COMPACT
        if not resolve_entities:
            parse_options = parse_options ^ xmlparser.XML_PARSE_NOENT
        elif resolve_entities == 'internal':
            resolve_external = False
        if not strip_cdata:
            parse_options = parse_options ^ xmlparser.XML_PARSE_NOCDATA
        if decompress:
            parse_options |= xmlparser.XML_PARSE_UNZIP

        _BaseParser.__init__(self, parse_options, False, schema,
                             remove_comments, remove_pis, strip_cdata,
                             collect_ids, target, encoding, resolve_external)

    # Allow subscripting XMLParser in type annotions (PEP 560)
    def __class_getitem__(cls, item):
        return _GenericAlias(cls, item)


cdef class XMLPullParser(XMLParser):
    """XMLPullParser(self, events=None, *, tag=None, **kwargs)

    XML parser that collects parse events in an iterator.

    The collected events are the same as for iterparse(), but the
    parser itself is non-blocking in the sense that it receives
    data chunks incrementally through its .feed() method, instead
    of reading them directly from a file(-like) object all by itself.

    By default, it collects Element end events.  To change that,
    pass any subset of the available events into the ``events``
    argument: ``'start'``, ``'end'``, ``'start-ns'``,
    ``'end-ns'``, ``'comment'``, ``'pi'``.

    To support loading external dependencies relative to the input
    source, you can pass the ``base_url``.
    """
    def __init__(self, events=None, *, tag=None, base_url=None, **kwargs):
        XMLParser.__init__(self, **kwargs)
        if events is None:
            events = ('end',)
        self._setBaseURL(base_url)
        self._collectEvents(events, tag)

    def read_events(self):
        return (<_SaxParserContext?>self._getPushParserContext()).events_iterator


cdef class ETCompatXMLParser(XMLParser):
    """ETCompatXMLParser(self, encoding=None, attribute_defaults=False, \
                 dtd_validation=False, load_dtd=False, no_network=True, decompress=False, \
                 ns_clean=False, recover=False, schema=None, \
                 huge_tree=False, remove_blank_text=False, resolve_entities=True, \
                 remove_comments=True, remove_pis=True, strip_cdata=True, \
                 target=None, compact=True)

    An XML parser with an ElementTree compatible default setup.

    See the XMLParser class for details.

    This parser has ``remove_comments`` and ``remove_pis`` enabled by default
    and thus ignores comments and processing instructions.
    """
    def __init__(self, *, encoding=None, attribute_defaults=False,
                 dtd_validation=False, load_dtd=False, no_network=True, decompress=False,
                 ns_clean=False, recover=False, schema=None,
                 huge_tree=False, remove_blank_text=False, resolve_entities=True,
                 remove_comments=True, remove_pis=True, strip_cdata=True,
                 target=None, compact=True):
        XMLParser.__init__(self,
                           attribute_defaults=attribute_defaults,
                           dtd_validation=dtd_validation,
                           load_dtd=load_dtd,
                           no_network=no_network,
                           decompress=decompress,
                           ns_clean=ns_clean,
                           recover=recover,
                           remove_blank_text=remove_blank_text,
                           huge_tree=huge_tree,
                           compact=compact,
                           resolve_entities=resolve_entities,
                           remove_comments=remove_comments,
                           remove_pis=remove_pis,
                           strip_cdata=strip_cdata,
                           target=target,
                           encoding=encoding,
                           schema=schema,
                           )

# ET 1.2 compatible name
XMLTreeBuilder = ETCompatXMLParser


cdef XMLParser __DEFAULT_XML_PARSER
__DEFAULT_XML_PARSER = XMLParser()

__GLOBAL_PARSER_CONTEXT.setDefaultParser(__DEFAULT_XML_PARSER)

def set_default_parser(_BaseParser parser=None):
    """set_default_parser(parser=None)

    Set a default parser for the current thread.  This parser is used
    globally whenever no parser is supplied to the various parse functions of
    the lxml API.  If this function is called without a parser (or if it is
    None), the default parser is reset to the original configuration.

    Note that the pre-installed default parser is not thread-safe.  Avoid the
    default parser in multi-threaded environments.  You can create a separate
    parser for each thread explicitly or use a parser pool.
    """
    if parser is None:
        parser = __DEFAULT_XML_PARSER
    __GLOBAL_PARSER_CONTEXT.setDefaultParser(parser)

def get_default_parser():
    "get_default_parser()"
    return __GLOBAL_PARSER_CONTEXT.getDefaultParser()

############################################################
## HTML parser
############################################################

cdef int _HTML_DEFAULT_PARSE_OPTIONS
_HTML_DEFAULT_PARSE_OPTIONS = (
    htmlparser.HTML_PARSE_RECOVER |
    htmlparser.HTML_PARSE_NONET   |
    htmlparser.HTML_PARSE_COMPACT
    )

cdef object _UNUSED = object()

cdef class HTMLParser(_FeedParser):
    """HTMLParser(self, encoding=None, remove_blank_text=False, \
                   remove_comments=False, remove_pis=False, \
                   no_network=True, decompress=False, target=None, schema: XMLSchema =None, \
                   recover=True, compact=True, collect_ids=True, huge_tree=False)

    The HTML parser.

    This parser allows reading HTML into a normal XML tree.  By
    default, it can read broken (non well-formed) HTML, depending on
    the capabilities of libxml2.  Use the 'recover' option to switch
    this off.

    Available boolean keyword arguments:

    - recover            - try hard to parse through broken HTML (default: True)
    - no_network         - prevent network access for related files (default: True)
    - decompress         - automatically decompress gzip input
                           (default: False, changed in lxml 6.0, disabling only affects libxml2 2.15+)
    - remove_blank_text  - discard empty text nodes that are ignorable (i.e. not actual text content)
    - remove_comments    - discard comments
    - remove_pis         - discard processing instructions
    - compact            - save memory for short text content (default: True)
    - default_doctype    - add a default doctype even if it is not found in the HTML (default: True)
    - collect_ids        - use a hash table of XML IDs for fast access (default: True)
    - huge_tree          - disable security restrictions and support very deep trees
                           and very long text content

    Other keyword arguments:

    - encoding - override the document encoding (note: libiconv encoding name)
    - target   - a parser target object that will receive the parse events
    - schema   - an XMLSchema to validate against

    Note that you should avoid sharing parsers between threads for performance
    reasons.
    """
    def __init__(self, *, encoding=None, remove_blank_text=False,
                 remove_comments=False, remove_pis=False, strip_cdata=_UNUSED,
                 no_network=True, decompress=False, target=None, XMLSchema schema=None,
                 recover=True, compact=True, default_doctype=True,
                 collect_ids=True, huge_tree=False):
        cdef int parse_options
        parse_options = _HTML_DEFAULT_PARSE_OPTIONS
        if remove_blank_text:
            parse_options = parse_options | htmlparser.HTML_PARSE_NOBLANKS
        if not recover:
            parse_options = parse_options ^ htmlparser.HTML_PARSE_RECOVER
        if not no_network:
            parse_options = parse_options ^ htmlparser.HTML_PARSE_NONET
        if not compact:
            parse_options = parse_options ^ htmlparser.HTML_PARSE_COMPACT
        if not default_doctype:
            parse_options = parse_options ^ htmlparser.HTML_PARSE_NODEFDTD
        if huge_tree:
            parse_options = parse_options | xmlparser.XML_PARSE_HUGE
        if decompress:
            parse_options |= xmlparser.XML_PARSE_UNZIP

        if strip_cdata is not _UNUSED:
            import warnings
            warnings.warn(
                "The 'strip_cdata' option of HTMLParser() has never done anything and will eventually be removed.",
                DeprecationWarning)
        _BaseParser.__init__(self, parse_options, True, schema,
                             remove_comments, remove_pis, strip_cdata,
                             collect_ids, target, encoding)

    # Allow subscripting HTMLParser in type annotions (PEP 560)
    def __class_getitem__(cls, item):
        return _GenericAlias(cls, item)


cdef HTMLParser __DEFAULT_HTML_PARSER
__DEFAULT_HTML_PARSER = HTMLParser()


cdef class HTMLPullParser(HTMLParser):
    """HTMLPullParser(self, events=None, *, tag=None, base_url=None, **kwargs)

    HTML parser that collects parse events in an iterator.

    The collected events are the same as for iterparse(), but the
    parser itself is non-blocking in the sense that it receives
    data chunks incrementally through its .feed() method, instead
    of reading them directly from a file(-like) object all by itself.

    By default, it collects Element end events.  To change that,
    pass any subset of the available events into the ``events``
    argument: ``'start'``, ``'end'``, ``'start-ns'``,
    ``'end-ns'``, ``'comment'``, ``'pi'``.

    To support loading external dependencies relative to the input
    source, you can pass the ``base_url``.
    """
    def __init__(self, events=None, *, tag=None, base_url=None, **kwargs):
        HTMLParser.__init__(self, **kwargs)
        if events is None:
            events = ('end',)
        self._setBaseURL(base_url)
        self._collectEvents(events, tag)

    def read_events(self):
        return (<_SaxParserContext?>self._getPushParserContext()).events_iterator


############################################################
## helper functions for document creation
############################################################

cdef xmlDoc* _parseDoc(text, filename, _BaseParser parser) except NULL:
    cdef char* c_filename
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
    if not filename:
        c_filename = NULL
    else:
        filename_utf = _encodeFilenameUTF8(filename)
        c_filename = _cstr(filename_utf)
    if isinstance(text, bytes):
        return _parseDoc_bytes(<bytes> text, filename, c_filename, parser)
    elif isinstance(text, unicode):
        return _parseDoc_unicode(<unicode> text, filename, c_filename, parser)
    else:
        return _parseDoc_charbuffer(text, filename, c_filename, parser)


cdef xmlDoc* _parseDoc_unicode(unicode text, filename, char* c_filename, _BaseParser parser) except NULL:
    cdef Py_ssize_t c_len
    if python.PyUnicode_IS_READY(text):
        # PEP-393 Unicode string
        c_len = python.PyUnicode_GET_LENGTH(text) * python.PyUnicode_KIND(text)
    else:
        # old Py_UNICODE string
        c_len = python.PyUnicode_GET_DATA_SIZE(text)
    if c_len > limits.INT_MAX:
        return parser._parseDocFromFilelike(
            StringIO(text), filename, None)
    return parser._parseUnicodeDoc(text, c_filename)


cdef xmlDoc* _parseDoc_bytes(bytes text, filename, char* c_filename, _BaseParser parser) except NULL:
    cdef Py_ssize_t c_len = len(text)
    if c_len > limits.INT_MAX:
        return parser._parseDocFromFilelike(BytesIO(text), filename, None)
    return parser._parseDoc(text, c_len, c_filename)


cdef xmlDoc* _parseDoc_charbuffer(text, filename, char* c_filename, _BaseParser parser) except NULL:
    cdef const unsigned char[::1] data = memoryview(text).cast('B')  # cast to 'unsigned char' buffer
    cdef Py_ssize_t c_len = len(data)
    if c_len > limits.INT_MAX:
        return parser._parseDocFromFilelike(BytesIO(text), filename, None)
    return parser._parseDoc(<const char*>&data[0], c_len, c_filename)


cdef xmlDoc* _parseDocFromFile(filename8, _BaseParser parser) except NULL:
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
    return (<_BaseParser>parser)._parseDocFromFile(_cstr(filename8))


cdef xmlDoc* _parseDocFromFilelike(source, filename,
                                   _BaseParser parser) except NULL:
    if parser is None:
        parser = __GLOBAL_PARSER_CONTEXT.getDefaultParser()
    return (<_BaseParser>parser)._parseDocFromFilelike(source, filename, None)


cdef xmlDoc* _newXMLDoc() except NULL:
    cdef xmlDoc* result
    result = tree.xmlNewDoc(NULL)
    if result is NULL:
        raise MemoryError()
    if result.encoding is NULL:
        result.encoding = tree.xmlStrdup(<unsigned char*>"UTF-8")
    __GLOBAL_PARSER_CONTEXT.initDocDict(result)
    return result

cdef xmlDoc* _newHTMLDoc() except NULL:
    cdef xmlDoc* result
    result = tree.htmlNewDoc(NULL, NULL)
    if result is NULL:
        raise MemoryError()
    __GLOBAL_PARSER_CONTEXT.initDocDict(result)
    return result

cdef xmlDoc* _copyDoc(xmlDoc* c_doc, int recursive) except NULL:
    cdef xmlDoc* result
    if recursive:
        with nogil:
            result = tree.xmlCopyDoc(c_doc, recursive)
    else:
        result = tree.xmlCopyDoc(c_doc, 0)
    if result is NULL:
        raise MemoryError()
    __GLOBAL_PARSER_CONTEXT.initDocDict(result)
    return result

cdef xmlDoc* _copyDocRoot(xmlDoc* c_doc, xmlNode* c_new_root) except NULL:
    "Recursively copy the document and make c_new_root the new root node."
    cdef xmlDoc* result
    cdef xmlNode* c_node
    result = tree.xmlCopyDoc(c_doc, 0) # non recursive
    __GLOBAL_PARSER_CONTEXT.initDocDict(result)
    with nogil:
        c_node = tree.xmlDocCopyNode(c_new_root, result, 1) # recursive
    if c_node is NULL:
        raise MemoryError()
    tree.xmlDocSetRootElement(result, c_node)
    _copyTail(c_new_root.next, c_node)
    return result

cdef xmlNode* _copyNodeToDoc(xmlNode* c_node, xmlDoc* c_doc) except NULL:
    "Recursively copy the element into the document. c_doc is not modified."
    cdef xmlNode* c_root
    c_root = tree.xmlDocCopyNode(c_node, c_doc, 1) # recursive
    if c_root is NULL:
        raise MemoryError()
    _copyTail(c_node.next, c_root)
    return c_root


############################################################
## API level helper functions for _Document creation
############################################################

cdef _Document _parseDocument(source, _BaseParser parser, base_url):
    cdef _Document doc
    source = _getFSPathOrObject(source)
    if _isString(source):
        # parse the file directly from the filesystem
        doc = _parseDocumentFromURL(_encodeFilename(source), parser)
        # fix base URL if requested
        if base_url is not None:
            base_url = _encodeFilenameUTF8(base_url)
            if doc._c_doc.URL is not NULL:
                tree.xmlFree(<char*>doc._c_doc.URL)
            doc._c_doc.URL = tree.xmlStrdup(_xcstr(base_url))
        return doc

    if base_url is not None:
        url = base_url
    else:
        url = _getFilenameForFile(source)

    if hasattr(source, 'getvalue') and hasattr(source, 'tell'):
        # StringIO - reading from start?
        if source.tell() == 0:
            return _parseMemoryDocument(source.getvalue(), url, parser)

    # Support for file-like objects (urlgrabber.urlopen, ...)
    if hasattr(source, 'read'):
        return _parseFilelikeDocument(source, url, parser)

    raise TypeError, f"cannot parse from '{python._fqtypename(source).decode('UTF-8')}'"

cdef _Document _parseDocumentFromURL(url, _BaseParser parser):
    c_doc = _parseDocFromFile(url, parser)
    return _documentFactory(c_doc, parser)

cdef _Document _parseMemoryDocument(text, url, _BaseParser parser):
    if isinstance(text, unicode):
        if _hasEncodingDeclaration(text):
            raise ValueError(
                "Unicode strings with encoding declaration are not supported. "
                "Please use bytes input or XML fragments without declaration.")
    c_doc = _parseDoc(text, url, parser)
    return _documentFactory(c_doc, parser)

cdef _Document _parseFilelikeDocument(source, url, _BaseParser parser):
    c_doc = _parseDocFromFilelike(source, url, parser)
    return _documentFactory(c_doc, parser)

# XML serialization and output functions

cdef object GzipFile
from gzip import GzipFile


cdef class SerialisationError(LxmlError):
    """A libxml2 error that occurred during serialisation.
    """


cdef enum _OutputMethods:
    OUTPUT_METHOD_XML
    OUTPUT_METHOD_HTML
    OUTPUT_METHOD_TEXT


cdef int _findOutputMethod(method) except -1:
    if method is None:
        return OUTPUT_METHOD_XML
    method = method.lower()
    if method == "xml":
        return OUTPUT_METHOD_XML
    if method == "html":
        return OUTPUT_METHOD_HTML
    if method == "text":
        return OUTPUT_METHOD_TEXT
    raise ValueError(f"unknown output method {method!r}")


cdef _textToString(xmlNode* c_node, encoding, bint with_tail):
    cdef bint needs_conversion
    cdef const_xmlChar* c_text
    cdef xmlNode* c_text_node
    cdef tree.xmlBuffer* c_buffer
    cdef int error_result

    c_buffer = tree.xmlBufferCreate()
    if c_buffer is NULL:
        raise MemoryError()

    with nogil:
        error_result = tree.xmlNodeBufGetContent(c_buffer, c_node)
        if with_tail:
            c_text_node = _textNodeOrSkip(c_node.next)
            while c_text_node is not NULL:
                tree.xmlBufferWriteChar(c_buffer, <const_char*>c_text_node.content)
                c_text_node = _textNodeOrSkip(c_text_node.next)
        c_text = tree.xmlBufferContent(c_buffer)

    if error_result < 0 or c_text is NULL:
        tree.xmlBufferFree(c_buffer)
        raise SerialisationError, "Error during serialisation (out of memory?)"

    try:
        needs_conversion = 0
        if encoding is unicode:
            needs_conversion = 1
        elif encoding is not None:
            # Python prefers lower case encoding names
            encoding = encoding.lower()
            if encoding not in ('utf8', 'utf-8'):
                if encoding == 'ascii':
                    if isutf8l(c_text, tree.xmlBufferLength(c_buffer)):
                        # will raise a decode error below
                        needs_conversion = 1
                else:
                    needs_conversion = 1

        if needs_conversion:
            text = (<const_char*>c_text)[:tree.xmlBufferLength(c_buffer)].decode('utf8')
            if encoding is not unicode:
                encoding = _utf8(encoding)
                text = python.PyUnicode_AsEncodedString(
                    text, encoding, 'strict')
        else:
            text = (<unsigned char*>c_text)[:tree.xmlBufferLength(c_buffer)]
    finally:
        tree.xmlBufferFree(c_buffer)
    return text


cdef _tostring(_Element element, encoding, doctype, method,
               bint write_xml_declaration, bint write_complete_document,
               bint pretty_print, bint with_tail, int standalone):
    """Serialize an element to an encoded string representation of its XML
    tree.
    """
    cdef tree.xmlOutputBuffer* c_buffer
    cdef tree.xmlBuf* c_result_buffer
    cdef tree.xmlCharEncodingHandler* enchandler
    cdef const_char* c_enc
    cdef const_xmlChar* c_version
    cdef const_xmlChar* c_doctype
    cdef int c_method
    cdef int error_result
    if element is None:
        return None
    _assertValidNode(element)
    c_method = _findOutputMethod(method)
    if c_method == OUTPUT_METHOD_TEXT:
        return _textToString(element._c_node, encoding, with_tail)
    if encoding is None or encoding is unicode:
        c_enc = NULL
    else:
        encoding = _utf8(encoding)
        c_enc = _cstr(encoding)
    if doctype is None:
        c_doctype = NULL
    else:
        doctype = _utf8(doctype)
        c_doctype = _xcstr(doctype)
    # it is necessary to *and* find the encoding handler *and* use
    # encoding during output
    enchandler = tree.xmlFindCharEncodingHandler(c_enc)
    if enchandler is NULL and c_enc is not NULL:
        if encoding is not None:
            encoding = encoding.decode('UTF-8')
        raise LookupError, f"unknown encoding: '{encoding}'"
    c_buffer = tree.xmlAllocOutputBuffer(enchandler)
    if c_buffer is NULL:
        tree.xmlCharEncCloseFunc(enchandler)
        raise MemoryError()

    with nogil:
        _writeNodeToBuffer(c_buffer, element._c_node, c_enc, c_doctype, c_method,
                           write_xml_declaration, write_complete_document,
                           pretty_print, with_tail, standalone)
        tree.xmlOutputBufferFlush(c_buffer)
        if c_buffer.conv is not NULL:
            c_result_buffer = c_buffer.conv
        else:
            c_result_buffer = c_buffer.buffer

    error_result = c_buffer.error
    if error_result != xmlerror.XML_ERR_OK:
        tree.xmlOutputBufferClose(c_buffer)
        _raiseSerialisationError(error_result)

    try:
        if encoding is unicode:
            result = (<unsigned char*>tree.xmlBufContent(
                c_result_buffer))[:tree.xmlBufUse(c_result_buffer)].decode('UTF-8')
        else:
            result = <bytes>(<unsigned char*>tree.xmlBufContent(
                c_result_buffer))[:tree.xmlBufUse(c_result_buffer)]
    finally:
        error_result = tree.xmlOutputBufferClose(c_buffer)
    if error_result == -1:
        _raiseSerialisationError(error_result)
    return result

cdef bytes _tostringC14N(element_or_tree, bint exclusive, bint with_comments, inclusive_ns_prefixes):
    cdef xmlDoc* c_doc
    cdef xmlChar* c_buffer = NULL
    cdef int byte_count = -1
    cdef bytes result
    cdef _Document doc
    cdef _Element element
    cdef xmlChar **c_inclusive_ns_prefixes

    if isinstance(element_or_tree, _Element):
        _assertValidNode(<_Element>element_or_tree)
        doc = (<_Element>element_or_tree)._doc
        c_doc = _plainFakeRootDoc(doc._c_doc, (<_Element>element_or_tree)._c_node, 0)
    else:
        doc = _documentOrRaise(element_or_tree)
        _assertValidDoc(doc)
        c_doc = doc._c_doc

    c_inclusive_ns_prefixes = _convert_ns_prefixes(c_doc.dict, inclusive_ns_prefixes) if inclusive_ns_prefixes else NULL
    try:
         with nogil:
             byte_count = c14n.xmlC14NDocDumpMemory(
                 c_doc, NULL, exclusive, c_inclusive_ns_prefixes, with_comments, &c_buffer)

    finally:
         _destroyFakeDoc(doc._c_doc, c_doc)
         if c_inclusive_ns_prefixes is not NULL:
            python.lxml_free(c_inclusive_ns_prefixes)

    if byte_count < 0 or c_buffer is NULL:
        if c_buffer is not NULL:
            tree.xmlFree(c_buffer)
        raise C14NError, "C14N failed"
    try:
        result = c_buffer[:byte_count]
    finally:
        tree.xmlFree(c_buffer)
    return result

cdef _raiseSerialisationError(int error_result):
    if error_result == xmlerror.XML_ERR_NO_MEMORY:
        raise MemoryError()
    message = ErrorTypes._getName(error_result)
    if message is None:
        message = f"unknown error {error_result}"
    raise SerialisationError, message

############################################################
# low-level serialisation functions

cdef void _writeDoctype(tree.xmlOutputBuffer* c_buffer,
                        const_xmlChar* c_doctype) noexcept nogil:
    tree.xmlOutputBufferWrite(c_buffer, tree.xmlStrlen(c_doctype),
                              <const_char*>c_doctype)
    tree.xmlOutputBufferWriteString(c_buffer, "\n")

cdef void _writeNodeToBuffer(tree.xmlOutputBuffer* c_buffer,
                             xmlNode* c_node, const_char* encoding, const_xmlChar* c_doctype,
                             int c_method, bint write_xml_declaration,
                             bint write_complete_document,
                             bint pretty_print, bint with_tail,
                             int standalone) noexcept nogil:
    cdef xmlNode* c_nsdecl_node
    cdef xmlDoc* c_doc = c_node.doc
    if write_xml_declaration and c_method == OUTPUT_METHOD_XML:
        _writeDeclarationToBuffer(c_buffer, c_doc.version, encoding, standalone)

    # comments/processing instructions before doctype declaration
    if write_complete_document and not c_buffer.error and c_doc.intSubset:
        _writePrevSiblings(c_buffer, <xmlNode*>c_doc.intSubset, encoding, pretty_print)

    if c_doctype:
        _writeDoctype(c_buffer, c_doctype)
    # write internal DTD subset, preceding PIs/comments, etc.
    if write_complete_document and not c_buffer.error:
        if c_doctype is NULL:
            _writeDtdToBuffer(c_buffer, c_doc, c_node.name, c_method, encoding)
        _writePrevSiblings(c_buffer, c_node, encoding, pretty_print)

    c_nsdecl_node = c_node
    if not c_node.parent or c_node.parent.type != tree.XML_DOCUMENT_NODE:
        # copy the node and add namespaces from parents
        # this is required to make libxml write them
        c_nsdecl_node = tree.xmlCopyNode(c_node, 2)
        if not c_nsdecl_node:
            c_buffer.error = xmlerror.XML_ERR_NO_MEMORY
            return
        _copyParentNamespaces(c_node, c_nsdecl_node)

        c_nsdecl_node.parent = c_node.parent
        c_nsdecl_node.children = c_node.children
        c_nsdecl_node.last = c_node.last

    # write node
    if c_method == OUTPUT_METHOD_HTML:
        tree.htmlNodeDumpFormatOutput(
            c_buffer, c_doc, c_nsdecl_node, encoding, pretty_print)
    else:
        tree.xmlNodeDumpOutput(
            c_buffer, c_doc, c_nsdecl_node, 0, pretty_print, encoding)

    if c_nsdecl_node is not c_node:
        # clean up
        c_nsdecl_node.children = c_nsdecl_node.last = NULL
        tree.xmlFreeNode(c_nsdecl_node)

    if c_buffer.error:
        return

    # write tail, trailing comments, etc.
    if with_tail:
        _writeTail(c_buffer, c_node, encoding, c_method, pretty_print)
    if write_complete_document:
        _writeNextSiblings(c_buffer, c_node, encoding, pretty_print)
    if pretty_print:
        tree.xmlOutputBufferWrite(c_buffer, 1, "\n")

cdef void _writeDeclarationToBuffer(tree.xmlOutputBuffer* c_buffer,
                                    const_xmlChar* version, const_char* encoding,
                                    int standalone) noexcept nogil:
    if version is NULL:
        version = <unsigned char*>"1.0"
    tree.xmlOutputBufferWrite(c_buffer, 15, "<?xml version='")
    tree.xmlOutputBufferWriteString(c_buffer, <const_char*>version)
    tree.xmlOutputBufferWrite(c_buffer, 12, "' encoding='")
    tree.xmlOutputBufferWriteString(c_buffer, encoding)
    if standalone == 0:
        tree.xmlOutputBufferWrite(c_buffer, 20, "' standalone='no'?>\n")
    elif standalone == 1:
        tree.xmlOutputBufferWrite(c_buffer, 21, "' standalone='yes'?>\n")
    else:
        tree.xmlOutputBufferWrite(c_buffer, 4, "'?>\n")

cdef void _writeDtdToBuffer(tree.xmlOutputBuffer* c_buffer,
                            xmlDoc* c_doc, const_xmlChar* c_root_name,
                            int c_method, const_char* encoding) noexcept nogil:
    cdef tree.xmlDtd* c_dtd
    cdef xmlNode* c_node
    cdef char* quotechar
    c_dtd = c_doc.intSubset
    if not c_dtd or not c_dtd.name:
        return

    # Name in document type declaration must match the root element tag.
    # For XML, case sensitive match, for HTML insensitive.
    if c_method == OUTPUT_METHOD_HTML:
        if tree.xmlStrcasecmp(c_root_name, c_dtd.name) != 0:
            return
    else:
        if tree.xmlStrcmp(c_root_name, c_dtd.name) != 0:
            return

    tree.xmlOutputBufferWrite(c_buffer, 10, "<!DOCTYPE ")
    tree.xmlOutputBufferWriteString(c_buffer, <const_char*>c_dtd.name)

    cdef const_xmlChar* public_id = c_dtd.ExternalID
    cdef const_xmlChar* sys_url = c_dtd.SystemID
    if public_id and public_id[0] == b'\0':
        public_id = NULL
    if sys_url and sys_url[0] == b'\0':
        sys_url = NULL

    if public_id:
        tree.xmlOutputBufferWrite(c_buffer, 9, ' PUBLIC "')
        tree.xmlOutputBufferWriteString(c_buffer, <const_char*>public_id)
        if sys_url:
            tree.xmlOutputBufferWrite(c_buffer, 2, '" ')
        else:
            tree.xmlOutputBufferWrite(c_buffer, 1, '"')
    elif sys_url:
        tree.xmlOutputBufferWrite(c_buffer, 8, ' SYSTEM ')

    if sys_url:
        if tree.xmlStrchr(sys_url, b'"'):
            quotechar = '\''
        else:
            quotechar = '"'
        tree.xmlOutputBufferWrite(c_buffer, 1, quotechar)
        tree.xmlOutputBufferWriteString(c_buffer, <const_char*>sys_url)
        tree.xmlOutputBufferWrite(c_buffer, 1, quotechar)

    if (not c_dtd.entities and not c_dtd.elements and
           not c_dtd.attributes and not c_dtd.notations and
           not c_dtd.pentities):
        tree.xmlOutputBufferWrite(c_buffer, 2, '>\n')
        return

    tree.xmlOutputBufferWrite(c_buffer, 3, ' [\n')
    if c_dtd.notations and not c_buffer.error:
        c_buf = tree.xmlBufferCreate()
        if not c_buf:
            c_buffer.error = xmlerror.XML_ERR_NO_MEMORY
            return
        tree.xmlDumpNotationTable(c_buf, <tree.xmlNotationTable*>c_dtd.notations)
        tree.xmlOutputBufferWrite(
            c_buffer, tree.xmlBufferLength(c_buf),
            <const_char*>tree.xmlBufferContent(c_buf))
        tree.xmlBufferFree(c_buf)
    c_node = c_dtd.children
    while c_node and not c_buffer.error:
        tree.xmlNodeDumpOutput(c_buffer, c_node.doc, c_node, 0, 0, encoding)
        c_node = c_node.next
    tree.xmlOutputBufferWrite(c_buffer, 3, "]>\n")

cdef void _writeTail(tree.xmlOutputBuffer* c_buffer, xmlNode* c_node,
                     const_char* encoding, int c_method, bint pretty_print) noexcept nogil:
    "Write the element tail."
    c_node = c_node.next
    while c_node and not c_buffer.error and c_node.type in (
            tree.XML_TEXT_NODE, tree.XML_CDATA_SECTION_NODE):
        if c_method == OUTPUT_METHOD_HTML:
            tree.htmlNodeDumpFormatOutput(
                c_buffer, c_node.doc, c_node, encoding, pretty_print)
        else:
            tree.xmlNodeDumpOutput(
                c_buffer, c_node.doc, c_node, 0, pretty_print, encoding)
        c_node = c_node.next

cdef void _writePrevSiblings(tree.xmlOutputBuffer* c_buffer, xmlNode* c_node,
                             const_char* encoding, bint pretty_print) noexcept nogil:
    cdef xmlNode* c_sibling
    if c_node.parent and _isElement(c_node.parent):
        return
    # we are at a root node, so add PI and comment siblings
    c_sibling = c_node
    while c_sibling.prev and \
            (c_sibling.prev.type == tree.XML_PI_NODE or
             c_sibling.prev.type == tree.XML_COMMENT_NODE):
        c_sibling = c_sibling.prev
    while c_sibling is not c_node and not c_buffer.error:
        tree.xmlNodeDumpOutput(c_buffer, c_node.doc, c_sibling, 0,
                               pretty_print, encoding)
        if pretty_print:
            tree.xmlOutputBufferWriteString(c_buffer, "\n")
        c_sibling = c_sibling.next

cdef void _writeNextSiblings(tree.xmlOutputBuffer* c_buffer, xmlNode* c_node,
                             const_char* encoding, bint pretty_print) noexcept nogil:
    cdef xmlNode* c_sibling
    if c_node.parent and _isElement(c_node.parent):
        return
    # we are at a root node, so add PI and comment siblings
    c_sibling = c_node.next
    while not c_buffer.error and c_sibling and \
            (c_sibling.type == tree.XML_PI_NODE or
             c_sibling.type == tree.XML_COMMENT_NODE):
        if pretty_print:
            tree.xmlOutputBufferWriteString(c_buffer, "\n")
        tree.xmlNodeDumpOutput(c_buffer, c_node.doc, c_sibling, 0,
                               pretty_print, encoding)
        c_sibling = c_sibling.next


# copied and adapted from libxml2 (xmlBufAttrSerializeTxtContent())
cdef _write_attr_string(tree.xmlOutputBuffer* buf, const char *string):
    cdef const char *base
    cdef const char *cur

    if string == NULL:
        return

    base = cur = <const char*>string
    while cur[0] != 0:
        if cur[0] == b'\n':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 5, "&#10;")
            cur += 1
            base = cur

        elif cur[0] == b'\r':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 5, "&#13;")
            cur += 1
            base = cur

        elif cur[0] == b'\t':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 4, "&#9;")
            cur += 1
            base = cur

        elif cur[0] == b'"':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 6, "&quot;")
            cur += 1
            base = cur

        elif cur[0] == b'<':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 4, "&lt;")
            cur += 1
            base = cur

        elif cur[0] == b'>':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 4, "&gt;")
            cur += 1
            base = cur
        elif cur[0] == b'&':
            if base != cur:
                tree.xmlOutputBufferWrite(buf, cur - base, base)

            tree.xmlOutputBufferWrite(buf, 5, "&amp;")
            cur += 1
            base = cur

        else:
            # Leave further encoding and escaping to the buffer encoder.
            cur += 1

    if base != cur:
        tree.xmlOutputBufferWrite(buf, cur - base, base)


cdef void _write_cdata_section(tree.xmlOutputBuffer* buf, const char* c_data, const char* c_end):
    tree.xmlOutputBufferWrite(buf, 9, "<![CDATA[")
    while c_end - c_data > limits.INT_MAX:
        tree.xmlOutputBufferWrite(buf, limits.INT_MAX, c_data)
        c_data += limits.INT_MAX
    tree.xmlOutputBufferWrite(buf, c_end - c_data, c_data)
    tree.xmlOutputBufferWrite(buf, 3, "]]>")


cdef _write_cdata_string(tree.xmlOutputBuffer* buf, bytes bstring):
    cdef const char* c_data = bstring
    cdef const char* c_end = c_data + len(bstring)
    cdef const char* c_pos = c_data
    cdef bint nothing_written = True

    while True:
        c_pos = <const char*> cstring_h.memchr(c_pos, b']', c_end - c_pos)
        if not c_pos:
            break
        c_pos += 1
        next_char = c_pos[0]
        c_pos += 1
        if next_char != b']':
            continue
        # Found ']]', c_pos points to next character.
        while c_pos[0] == b']':
            c_pos += 1
        if c_pos[0] != b'>':
            if c_pos == c_end:
                break
            # c_pos[0] is neither ']' nor '>', continue with next character.
            c_pos += 1
            continue

        # Write section up to ']]' and start next block at trailing '>'.
        _write_cdata_section(buf, c_data, c_pos)
        nothing_written = False
        c_data = c_pos
        c_pos += 1

    if nothing_written or c_data < c_end:
        _write_cdata_section(buf, c_data, c_end)


############################################################
# output to file-like objects

cdef object io_open
from io import open as io_open

cdef object gzip
import gzip

cdef object getwriter
from codecs import getwriter
cdef object utf8_writer = getwriter('utf8')

cdef object contextmanager
from contextlib import contextmanager

cdef object _open_utf8_file

@contextmanager
def _open_utf8_file(file, compression=0):
    file = _getFSPathOrObject(file)
    if _isString(file):
        if compression:
            with gzip.GzipFile(file, mode='wb', compresslevel=compression) as zf:
                yield utf8_writer(zf)
        else:
            with io_open(file, 'w', encoding='utf8') as f:
                yield f
    else:
        if compression:
            with gzip.GzipFile(fileobj=file, mode='wb', compresslevel=compression) as zf:
                yield utf8_writer(zf)
        else:
            yield utf8_writer(file)


@cython.final
@cython.internal
cdef class _FilelikeWriter:
    cdef object _filelike
    cdef object _close_filelike
    cdef _ExceptionContext _exc_context
    cdef _ErrorLog error_log

    def __cinit__(self, filelike, exc_context=None, compression=None, close=False):
        if compression is not None and compression > 0:
            filelike = GzipFile(
                fileobj=filelike, mode='wb', compresslevel=compression)
            self._close_filelike = filelike.close
        elif close:
            self._close_filelike = filelike.close
        self._filelike = filelike
        if exc_context is None:
            self._exc_context = _ExceptionContext()
        else:
            self._exc_context = exc_context
        self.error_log = _ErrorLog()

    cdef tree.xmlOutputBuffer* _createOutputBuffer(
        self, tree.xmlCharEncodingHandler* enchandler) except NULL:
        cdef tree.xmlOutputBuffer* c_buffer
        c_buffer = tree.xmlOutputBufferCreateIO(
            <tree.xmlOutputWriteCallback>_writeFilelikeWriter, _closeFilelikeWriter,
            <python.PyObject*>self, enchandler)
        if c_buffer is NULL:
            raise IOError, "Could not create I/O writer context."
        return c_buffer

    cdef int write(self, char* c_buffer, int size) noexcept:
        try:
            if self._filelike is None:
                raise IOError, "File is already closed"
            py_buffer = <bytes>c_buffer[:size]
            self._filelike.write(py_buffer)
        except:
            size = -1
            self._exc_context._store_raised()
        finally:
            return size  # and swallow any further exceptions

    cdef int close(self) noexcept:
        retval = 0
        try:
            if self._close_filelike is not None:
                self._close_filelike()
            # we should not close the file here as we didn't open it
            self._filelike = None
        except:
            retval = -1
            self._exc_context._store_raised()
        finally:
            return retval  # and swallow any further exceptions

cdef int _writeFilelikeWriter(void* ctxt, char* c_buffer, int length) noexcept:
    return (<_FilelikeWriter>ctxt).write(c_buffer, length)

cdef int _closeFilelikeWriter(void* ctxt) noexcept:
    return (<_FilelikeWriter>ctxt).close()

cdef _tofilelike(f, _Element element, encoding, doctype, method,
                 bint write_xml_declaration, bint write_doctype,
                 bint pretty_print, bint with_tail, int standalone,
                 int compression):
    cdef _FilelikeWriter writer = None
    cdef tree.xmlOutputBuffer* c_buffer
    cdef tree.xmlCharEncodingHandler* enchandler
    cdef const_char* c_enc
    cdef const_xmlChar* c_doctype
    cdef int error_result

    c_method = _findOutputMethod(method)
    if c_method == OUTPUT_METHOD_TEXT:
        data = _textToString(element._c_node, encoding, with_tail)
        if compression:
            bytes_out = BytesIO()
            with GzipFile(fileobj=bytes_out, mode='wb', compresslevel=compression) as gzip_file:
                gzip_file.write(data)
            data = bytes_out.getvalue()
        f = _getFSPathOrObject(f)
        if _isString(f):
            filename8 = _encodeFilename(f)
            with open(filename8, 'wb') as f:
                f.write(data)
        else:
            f.write(data)
        return

    if encoding is None:
        c_enc = NULL
    else:
        encoding = _utf8(encoding)
        c_enc = _cstr(encoding)
    if doctype is None:
        c_doctype = NULL
    else:
        doctype = _utf8(doctype)
        c_doctype = _xcstr(doctype)

    writer = _create_output_buffer(f, c_enc, compression, &c_buffer, close=False)
    if writer is None:
        with nogil:
            error_result = _serialise_node(
                c_buffer, c_doctype, c_enc, element._c_node, c_method,
                write_xml_declaration, write_doctype, pretty_print, with_tail, standalone)
    else:
        error_result = _serialise_node(
            c_buffer, c_doctype, c_enc, element._c_node, c_method,
            write_xml_declaration, write_doctype, pretty_print, with_tail, standalone)

    if writer is not None:
        writer._exc_context._raise_if_stored()
    if error_result != xmlerror.XML_ERR_OK:
        _raiseSerialisationError(error_result)


cdef int _serialise_node(tree.xmlOutputBuffer* c_buffer, const_xmlChar* c_doctype,
                         const_char* c_enc, xmlNode* c_node, int c_method,
                         bint write_xml_declaration, bint write_doctype, bint pretty_print,
                         bint with_tail, int standalone) noexcept nogil:
    _writeNodeToBuffer(
        c_buffer, c_node, c_enc, c_doctype, c_method,
        write_xml_declaration, write_doctype, pretty_print, with_tail, standalone)
    error_result = c_buffer.error
    if error_result == xmlerror.XML_ERR_OK:
        error_result = tree.xmlOutputBufferClose(c_buffer)
        if error_result != -1:
            error_result = xmlerror.XML_ERR_OK
    else:
        tree.xmlOutputBufferClose(c_buffer)
    return error_result


cdef _FilelikeWriter _create_output_buffer(
        f, const_char* c_enc, int c_compression,
        tree.xmlOutputBuffer** c_buffer_ret, bint close):
    cdef tree.xmlOutputBuffer* c_buffer
    cdef _FilelikeWriter writer
    cdef bytes filename8
    enchandler = tree.xmlFindCharEncodingHandler(c_enc)
    if enchandler is NULL:
        raise LookupError(
            f"unknown encoding: '{c_enc.decode('UTF-8') if c_enc is not NULL else u''}'")
    try:
        f = _getFSPathOrObject(f)

        if c_compression and not HAS_ZLIB_COMPRESSION and _isString(f):
            # Let "_FilelikeWriter" fall back to Python's GzipFile.
            f = open(f, mode="wb")
            close = True

        if _isString(f):
            filename8 = _encodeFilename(f)
            if b'%' in filename8 and (
                    # Exclude absolute Windows paths and file:// URLs.
                    _isFilePath(<const xmlChar*>filename8) not in (NO_FILE_PATH, ABS_WIN_FILE_PATH)
                    or filename8[:7].lower() == b'file://'):
                # A file path (not a URL) containing the '%' URL escape character.
                # libxml2 uses URL-unescaping on these, so escape the path before passing it in.
                filename8 = filename8.replace(b'%', b'%25')
            c_buffer = tree.xmlOutputBufferCreateFilename(
                _cstr(filename8), enchandler, c_compression)
            if c_buffer is NULL:
                python.PyErr_SetFromErrno(IOError)  # raises IOError
            writer = None
        elif hasattr(f, 'write'):
            writer = _FilelikeWriter(f, compression=c_compression, close=close)
            c_buffer = writer._createOutputBuffer(enchandler)
        else:
            raise TypeError(
                f"File or filename expected, got '{python._fqtypename(f).decode('UTF-8')}'")
    except:
        tree.xmlCharEncCloseFunc(enchandler)
        raise
    c_buffer_ret[0] = c_buffer
    return writer

cdef xmlChar **_convert_ns_prefixes(tree.xmlDict* c_dict, ns_prefixes) except NULL:
    cdef size_t i, num_ns_prefixes = len(ns_prefixes)
    # Need to allocate one extra memory block to handle last NULL entry
    c_ns_prefixes = <xmlChar **>python.lxml_malloc(num_ns_prefixes + 1, sizeof(xmlChar*))
    if not c_ns_prefixes:
        raise MemoryError()
    i = 0
    try:
        for prefix in ns_prefixes:
             prefix_utf = _utf8(prefix)
             c_prefix_len = len(prefix_utf)
             if c_prefix_len > limits.INT_MAX:
                raise ValueError("Prefix too long")
             c_prefix = tree.xmlDictExists(c_dict, _xcstr(prefix_utf), <int> c_prefix_len)
             if c_prefix:
                 # unknown prefixes do not need to get serialised
                 c_ns_prefixes[i] = <xmlChar*>c_prefix
                 i += 1
    except:
        python.lxml_free(c_ns_prefixes)
        raise

    c_ns_prefixes[i] = NULL  # append end marker
    return c_ns_prefixes

cdef _tofilelikeC14N(f, _Element element, bint exclusive, bint with_comments,
                     int compression, inclusive_ns_prefixes):
    cdef _FilelikeWriter writer = None
    cdef tree.xmlOutputBuffer* c_buffer
    cdef xmlChar **c_inclusive_ns_prefixes = NULL
    cdef char* c_filename
    cdef xmlDoc* c_base_doc
    cdef xmlDoc* c_doc
    cdef int bytes_count, error = 0

    c_base_doc = element._c_node.doc
    c_doc = _fakeRootDoc(c_base_doc, element._c_node)
    try:
        c_inclusive_ns_prefixes = (
            _convert_ns_prefixes(c_doc.dict, inclusive_ns_prefixes)
            if inclusive_ns_prefixes else NULL)

        f = _getFSPathOrObject(f)

        close = False
        if compression and not HAS_ZLIB_COMPRESSION and _isString(f):
            # Let "_FilelikeWriter" fall back to Python's GzipFile.
            f = open(f, mode="wb")
            close = True

        if _isString(f):
            filename8 = _encodeFilename(f)
            c_filename = _cstr(filename8)
            with nogil:
                error = c14n.xmlC14NDocSave(
                    c_doc, NULL, exclusive, c_inclusive_ns_prefixes,
                    with_comments, c_filename, compression)
        elif hasattr(f, 'write'):
            writer   = _FilelikeWriter(f, compression=compression, close=close)
            c_buffer = writer._createOutputBuffer(NULL)
            try:
                with writer.error_log:
                    bytes_count = c14n.xmlC14NDocSaveTo(
                        c_doc, NULL, exclusive, c_inclusive_ns_prefixes,
                        with_comments, c_buffer)
            finally:
                error = tree.xmlOutputBufferClose(c_buffer)
            if bytes_count < 0:
                error = bytes_count
            elif error != -1:
                error = xmlerror.XML_ERR_OK
        else:
            raise TypeError(f"File or filename expected, got '{python._fqtypename(f).decode('UTF-8')}'")
    finally:
        _destroyFakeDoc(c_base_doc, c_doc)
        if c_inclusive_ns_prefixes is not NULL:
            python.lxml_free(c_inclusive_ns_prefixes)

    if writer is not None:
        writer._exc_context._raise_if_stored()

    if error < 0:
        message = "C14N failed"
        if writer is not None:
            errors = writer.error_log
            if len(errors):
                message = errors[0].message
        raise C14NError(message)


# C14N 2.0

def canonicalize(xml_data=None, *, out=None, from_file=None, **options):
    """Convert XML to its C14N 2.0 serialised form.

    If *out* is provided, it must be a file or file-like object that receives
    the serialised canonical XML output (text, not bytes) through its ``.write()``
    method.  To write to a file, open it in text mode with encoding "utf-8".
    If *out* is not provided, this function returns the output as text string.

    Either *xml_data* (an XML string, tree or Element) or *file*
    (a file path or file-like object) must be provided as input.

    The configuration options are the same as for the ``C14NWriterTarget``.
    """
    if xml_data is None and from_file is None:
        raise ValueError("Either 'xml_data' or 'from_file' must be provided as input")

    sio = None
    if out is None:
        sio = out = StringIO()

    target = C14NWriterTarget(out.write, **options)

    if xml_data is not None and not isinstance(xml_data, basestring):
        _tree_to_target(xml_data, target)
        return sio.getvalue() if sio is not None else None

    cdef _FeedParser parser = XMLParser(
        target=target,
        attribute_defaults=True,
        collect_ids=False,
    )

    if xml_data is not None:
        parser.feed(xml_data)
        parser.close()
    elif from_file is not None:
        try:
            _parseDocument(from_file, parser, base_url=None)
        except _TargetParserResult:
            pass

    return sio.getvalue() if sio is not None else None


cdef _tree_to_target(element, target):
    for event, elem in iterwalk(element, events=('start', 'end', 'start-ns', 'comment', 'pi')):
        text = None
        if event == 'start':
            target.start(elem.tag, elem.attrib)
            text = elem.text
        elif event == 'end':
            target.end(elem.tag)
            text = elem.tail
        elif event == 'start-ns':
            target.start_ns(*elem)
            continue
        elif event == 'comment':
            target.comment(elem.text)
            text = elem.tail
        elif event == 'pi':
            target.pi(elem.target, elem.text)
            text = elem.tail
        if text:
            target.data(text)
    return target.close()


cdef object _looks_like_prefix_name = re.compile(r'^\w+:\w+$', re.UNICODE).match


cdef class C14NWriterTarget:
    """
    Canonicalization writer target for the XMLParser.

    Serialises parse events to XML C14N 2.0.

    Configuration options:

    - *with_comments*: set to true to include comments
    - *strip_text*: set to true to strip whitespace before and after text content
    - *rewrite_prefixes*: set to true to replace namespace prefixes by "n{number}"
    - *qname_aware_tags*: a set of qname aware tag names in which prefixes
                          should be replaced in text content
    - *qname_aware_attrs*: a set of qname aware attribute names in which prefixes
                           should be replaced in text content
    - *exclude_attrs*: a set of attribute names that should not be serialised
    - *exclude_tags*: a set of tag names that should not be serialised
    """
    cdef object _write
    cdef list _data
    cdef set _qname_aware_tags
    cdef object _find_qname_aware_attrs
    cdef list _declared_ns_stack
    cdef list _ns_stack
    cdef dict _prefix_map
    cdef list _preserve_space
    cdef tuple _pending_start
    cdef set _exclude_tags
    cdef set _exclude_attrs
    cdef Py_ssize_t _ignored_depth
    cdef bint _with_comments
    cdef bint _strip_text
    cdef bint _rewrite_prefixes
    cdef bint _root_seen
    cdef bint _root_done

    def __init__(self, write, *,
                 with_comments=False, strip_text=False, rewrite_prefixes=False,
                 qname_aware_tags=None, qname_aware_attrs=None,
                 exclude_attrs=None, exclude_tags=None):
        self._write = write
        self._data = []
        self._with_comments = with_comments
        self._strip_text = strip_text
        self._exclude_attrs = set(exclude_attrs) if exclude_attrs else None
        self._exclude_tags = set(exclude_tags) if exclude_tags else None

        self._rewrite_prefixes = rewrite_prefixes
        if qname_aware_tags:
            self._qname_aware_tags = set(qname_aware_tags)
        else:
            self._qname_aware_tags = None
        if qname_aware_attrs:
            self._find_qname_aware_attrs = set(qname_aware_attrs).intersection
        else:
            self._find_qname_aware_attrs = None

        # Stack with globally and newly declared namespaces as (uri, prefix) pairs.
        self._declared_ns_stack = [[
            ("http://www.w3.org/XML/1998/namespace", "xml"),
        ]]
        # Stack with user declared namespace prefixes as (uri, prefix) pairs.
        self._ns_stack = []
        if not rewrite_prefixes:
            self._ns_stack.append(_DEFAULT_NAMESPACE_PREFIXES_ITEMS)
        self._ns_stack.append([])
        self._prefix_map = {}
        self._preserve_space = [False]
        self._pending_start = None
        self._ignored_depth = 0
        self._root_seen = False
        self._root_done = False

    def _iter_namespaces(self, ns_stack):
        for namespaces in reversed(ns_stack):
            if namespaces:  # almost no element declares new namespaces
                yield from namespaces

    cdef _resolve_prefix_name(self, prefixed_name):
        prefix, name = prefixed_name.split(':', 1)
        for uri, p in self._iter_namespaces(self._ns_stack):
            if p == prefix:
                return f'{{{uri}}}{name}'
        raise ValueError(f'Prefix {prefix} of QName "{prefixed_name}" is not declared in scope')

    cdef _qname(self, qname, uri=None):
        if uri is None:
            uri, tag = qname[1:].rsplit('}', 1) if qname[:1] == '{' else ('', qname)
        else:
            tag = qname

        prefixes_seen = set()
        for u, prefix in self._iter_namespaces(self._declared_ns_stack):
            if u == uri and prefix not in prefixes_seen:
                return f'{prefix}:{tag}' if prefix else tag, tag, uri
            prefixes_seen.add(prefix)

        # Not declared yet => add new declaration.
        if self._rewrite_prefixes:
            if uri in self._prefix_map:
                prefix = self._prefix_map[uri]
            else:
                prefix = self._prefix_map[uri] = f'n{len(self._prefix_map)}'
            self._declared_ns_stack[-1].append((uri, prefix))
            return f'{prefix}:{tag}', tag, uri

        if not uri and '' not in prefixes_seen:
            # No default namespace declared => no prefix needed.
            return tag, tag, uri

        for u, prefix in self._iter_namespaces(self._ns_stack):
            if u == uri:
                self._declared_ns_stack[-1].append((uri, prefix))
                return f'{prefix}:{tag}' if prefix else tag, tag, uri

        if not uri:
            # As soon as a default namespace is defined,
            # anything that has no namespace (and thus, no prefix) goes there.
            return tag, tag, uri

        raise ValueError(f'Namespace "{uri}" of name "{tag}" is not declared in scope')

    def data(self, data):
        if not self._ignored_depth:
            self._data.append(data)

    cdef _flush(self):
        cdef unicode data = ''.join(self._data)
        del self._data[:]
        if self._strip_text and not self._preserve_space[-1]:
            data = data.strip()
        if self._pending_start is not None:
            (tag, attrs, new_namespaces), self._pending_start = self._pending_start, None
            qname_text = data if ':' in data and _looks_like_prefix_name(data) else None
            self._start(tag, attrs, new_namespaces, qname_text)
            if qname_text is not None:
                return
        if data and self._root_seen:
            self._write(_escape_cdata_c14n(data))

    def start_ns(self, prefix, uri):
        if self._ignored_depth:
            return
        # we may have to resolve qnames in text content
        if self._data:
            self._flush()
        self._ns_stack[-1].append((uri, prefix))

    def start(self, tag, attrs):
        if self._exclude_tags is not None and (
                self._ignored_depth or tag in self._exclude_tags):
            self._ignored_depth += 1
            return
        if self._data:
            self._flush()

        new_namespaces = []
        self._declared_ns_stack.append(new_namespaces)

        if self._qname_aware_tags is not None and tag in self._qname_aware_tags:
            # Need to parse text first to see if it requires a prefix declaration.
            self._pending_start = (tag, attrs, new_namespaces)
            return
        self._start(tag, attrs, new_namespaces)

    cdef _start(self, tag, attrs, new_namespaces, qname_text=None):
        if self._exclude_attrs is not None and attrs:
            attrs = {k: v for k, v in attrs.items() if k not in self._exclude_attrs}

        qnames = {tag, *attrs}
        resolved_names = {}

        # Resolve prefixes in attribute and tag text.
        if qname_text is not None:
            qname = resolved_names[qname_text] = self._resolve_prefix_name(qname_text)
            qnames.add(qname)
        if self._find_qname_aware_attrs is not None and attrs:
            qattrs = self._find_qname_aware_attrs(attrs)
            if qattrs:
                for attr_name in qattrs:
                    value = attrs[attr_name]
                    if _looks_like_prefix_name(value):
                        qname = resolved_names[value] = self._resolve_prefix_name(value)
                        qnames.add(qname)
            else:
                qattrs = None
        else:
            qattrs = None

        # Assign prefixes in lexicographical order of used URIs.
        parsed_qnames = {n: self._qname(n) for n in sorted(
            qnames, key=lambda n: n.split('}', 1))}

        # Write namespace declarations in prefix order ...
        if new_namespaces:
            attr_list = [
                ('xmlns:' + prefix if prefix else 'xmlns', uri)
                for uri, prefix in new_namespaces
            ]
            attr_list.sort()
        else:
            # almost always empty
            attr_list = []

        # ... followed by attributes in URI+name order
        if attrs:
            for k, v in sorted(attrs.items()):
                if qattrs is not None and k in qattrs and v in resolved_names:
                    v = parsed_qnames[resolved_names[v]][0]
                attr_qname, attr_name, uri = parsed_qnames[k]
                # No prefix for attributes in default ('') namespace.
                attr_list.append((attr_qname if uri else attr_name, v))

        # Honour xml:space attributes.
        space_behaviour = attrs.get('{http://www.w3.org/XML/1998/namespace}space')
        self._preserve_space.append(
            space_behaviour == 'preserve' if space_behaviour
            else self._preserve_space[-1])

        # Write the tag.
        write = self._write
        write('<' + parsed_qnames[tag][0])
        if attr_list:
            write(''.join([f' {k}="{_escape_attrib_c14n(v)}"' for k, v in attr_list]))
        write('>')

        # Write the resolved qname text content.
        if qname_text is not None:
            write(_escape_cdata_c14n(parsed_qnames[resolved_names[qname_text]][0]))

        self._root_seen = True
        self._ns_stack.append([])

    def end(self, tag):
        if self._ignored_depth:
            self._ignored_depth -= 1
            return
        if self._data:
            self._flush()
        self._write(f'</{self._qname(tag)[0]}>')
        self._preserve_space.pop()
        self._root_done = len(self._preserve_space) == 1
        self._declared_ns_stack.pop()
        self._ns_stack.pop()

    def comment(self, text):
        if not self._with_comments:
            return
        if self._ignored_depth:
            return
        if self._root_done:
            self._write('\n')
        elif self._root_seen and self._data:
            self._flush()
        self._write(f'<!--{_escape_cdata_c14n(text)}-->')
        if not self._root_seen:
            self._write('\n')

    def pi(self, target, data):
        if self._ignored_depth:
            return
        if self._root_done:
            self._write('\n')
        elif self._root_seen and self._data:
            self._flush()
        self._write(
            f'<?{target} {_escape_cdata_c14n(data)}?>' if data else f'<?{target}?>')
        if not self._root_seen:
            self._write('\n')

    def close(self):
        return None


cdef _raise_serialization_error(text):
    raise TypeError("cannot serialize %r (type %s)" % (text, type(text).__name__))


cdef unicode _escape_cdata_c14n(stext):
    # escape character data
    cdef unicode text
    cdef Py_UCS4 ch
    cdef Py_ssize_t start = 0, pos = 0
    cdef list substrings = None
    try:
        text = unicode(stext)
    except (TypeError, AttributeError):
        return _raise_serialization_error(stext)

    for pos, ch in enumerate(text):
        if ch == '&':
            escape = '&amp;'
        elif ch == '<':
            escape = '&lt;'
        elif ch == '>':
            escape = '&gt;'
        elif ch == '\r':
            escape = '&#xD;'
        else:
            continue

        if substrings is None:
            substrings = []
        if pos > start:
            substrings.append(text[start:pos])
        substrings.append(escape)
        start = pos + 1

    if substrings is None:
        return text
    if pos >= start:
        substrings.append(text[start:pos+1])
    return ''.join(substrings)


cdef unicode _escape_attrib_c14n(stext):
    # escape attribute value
    cdef unicode text
    cdef Py_UCS4 ch
    cdef Py_ssize_t start = 0, pos = 0
    cdef list substrings = None
    try:
        text = unicode(stext)
    except (TypeError, AttributeError):
        return _raise_serialization_error(stext)

    for pos, ch in enumerate(text):
        if ch == '&':
            escape = '&amp;'
        elif ch == '<':
            escape = '&lt;'
        elif ch == '"':
            escape = '&quot;'
        elif ch == '\t':
            escape = '&#x9;'
        elif ch == '\n':
            escape = '&#xA;'
        elif ch == '\r':
            escape = '&#xD;'
        else:
            continue

        if substrings is None:
            substrings = []
        if pos > start:
            substrings.append(text[start:pos])
        substrings.append(escape)
        start = pos + 1

    if substrings is None:
        return text
    if pos >= start:
        substrings.append(text[start:pos+1])
    return ''.join(substrings)


# incremental serialisation

cdef class xmlfile:
    """xmlfile(self, output_file, encoding=None, compression=None, close=False, buffered=True)

    A simple mechanism for incremental XML serialisation.

    Usage example::

         with xmlfile("somefile.xml", encoding='utf-8') as xf:
             xf.write_declaration(standalone=True)
             xf.write_doctype('<!DOCTYPE root SYSTEM "some.dtd">')

             # generate an element (the root element)
             with xf.element('root'):
                  # write a complete Element into the open root element
                  xf.write(etree.Element('test'))

                  # generate and write more Elements, e.g. through iterparse
                  for element in generate_some_elements():
                      # serialise generated elements into the XML file
                      xf.write(element)

                  # or write multiple Elements or strings at once
                  xf.write(etree.Element('start'), "text", etree.Element('end'))

    If 'output_file' is a file(-like) object, passing ``close=True`` will
    close it when exiting the context manager.  By default, it is left
    to the owner to do that.  When a file path is used, lxml will take care
    of opening and closing the file itself.  Also, when a compression level
    is set, lxml will deliberately close the file to make sure all data gets
    compressed and written.

    Setting ``buffered=False`` will flush the output after each operation,
    such as opening or closing an ``xf.element()`` block or calling
    ``xf.write()``.  Alternatively, calling ``xf.flush()`` can be used to
    explicitly flush any pending output when buffering is enabled.
    """
    cdef object output_file
    cdef bytes encoding
    cdef _IncrementalFileWriter writer
    cdef _AsyncIncrementalFileWriter async_writer
    cdef int compresslevel
    cdef bint close
    cdef bint buffered
    cdef int method

    def __init__(self, output_file not None, encoding=None, compression=None,
                 close=False, buffered=True):
        self.output_file = output_file
        self.encoding = _utf8orNone(encoding)
        self.compresslevel = compression or 0
        self.close = close
        self.buffered = buffered
        self.method = OUTPUT_METHOD_XML

    def __enter__(self):
        assert self.output_file is not None
        self.writer = _IncrementalFileWriter(
            self.output_file, self.encoding, self.compresslevel,
            self.close, self.buffered, self.method)
        return self.writer

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.writer is not None:
            old_writer, self.writer = self.writer, None
            raise_on_error = exc_type is None
            old_writer._close(raise_on_error)
            if self.close:
                self.output_file = None

    async def __aenter__(self):
        assert self.output_file is not None
        if isinstance(self.output_file, basestring):
            raise TypeError("Cannot asynchronously write to a plain file")
        if not hasattr(self.output_file, 'write'):
            raise TypeError("Output file needs an async .write() method")
        self.async_writer = _AsyncIncrementalFileWriter(
            self.output_file, self.encoding, self.compresslevel,
            self.close, self.buffered, self.method)
        return self.async_writer

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.async_writer is not None:
            old_writer, self.async_writer = self.async_writer, None
            raise_on_error = exc_type is None
            await old_writer._close(raise_on_error)
            if self.close:
                self.output_file = None


cdef class htmlfile(xmlfile):
    """htmlfile(self, output_file, encoding=None, compression=None, close=False, buffered=True)

    A simple mechanism for incremental HTML serialisation.  Works the same as
    xmlfile.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.method = OUTPUT_METHOD_HTML


cdef enum _IncrementalFileWriterStatus:
    WRITER_STARTING = 0
    WRITER_DECL_WRITTEN = 1
    WRITER_DTD_WRITTEN = 2
    WRITER_IN_ELEMENT = 3
    WRITER_FINISHED = 4


@cython.final
@cython.internal
cdef class _IncrementalFileWriter:
    cdef tree.xmlOutputBuffer* _c_out
    cdef bytes _encoding
    cdef const_char* _c_encoding
    cdef _FilelikeWriter _target
    cdef list _element_stack
    cdef int _status
    cdef int _method
    cdef bint _buffered

    def __cinit__(self, outfile, bytes encoding, int compresslevel, bint close,
                  bint buffered, int method):
        self._status = WRITER_STARTING
        self._element_stack = []
        if encoding is None:
            # We always need a document encoding to make the attribute serialisation
            # of libxml2 identical to ours.
            encoding = b'ASCII'
        self._encoding = encoding
        self._c_encoding = _cstr(encoding)
        self._buffered = buffered
        self._target = _create_output_buffer(
            outfile, self._c_encoding, compresslevel, &self._c_out, close)
        self._method = method

    def __dealloc__(self):
        if self._c_out is not NULL:
            tree.xmlOutputBufferClose(self._c_out)

    def write_declaration(self, version=None, standalone=None, doctype=None):
        """write_declaration(self, version=None, standalone=None, doctype=None)

        Write an XML declaration and (optionally) a doctype into the file.
        """
        assert self._c_out is not NULL
        cdef const_xmlChar* c_version
        cdef int c_standalone
        if self._method != OUTPUT_METHOD_XML:
            raise LxmlSyntaxError("only XML documents have declarations")
        if self._status >= WRITER_DECL_WRITTEN:
            raise LxmlSyntaxError("XML declaration already written")
        version = _utf8orNone(version)
        c_version = _xcstr(version) if version is not None else NULL
        doctype = _utf8orNone(doctype)
        if standalone is None:
            c_standalone = -1
        else:
            c_standalone = 1 if standalone else 0
        _writeDeclarationToBuffer(self._c_out, c_version, self._c_encoding, c_standalone)
        if doctype is not None:
            _writeDoctype(self._c_out, _xcstr(doctype))
            self._status = WRITER_DTD_WRITTEN
        else:
            self._status = WRITER_DECL_WRITTEN
        if not self._buffered:
            tree.xmlOutputBufferFlush(self._c_out)
        self._handle_error(self._c_out.error)

    def write_doctype(self, doctype):
        """write_doctype(self, doctype)

        Writes the given doctype declaration verbatimly into the file.
        """
        assert self._c_out is not NULL
        if doctype is None:
            return
        if self._status >= WRITER_DTD_WRITTEN:
            raise LxmlSyntaxError("DOCTYPE already written or cannot write it here")
        doctype = _utf8(doctype)
        _writeDoctype(self._c_out, _xcstr(doctype))
        self._status = WRITER_DTD_WRITTEN
        if not self._buffered:
            tree.xmlOutputBufferFlush(self._c_out)
        self._handle_error(self._c_out.error)

    def method(self, method):
        """method(self, method)

        Returns a context manager that overrides and restores the output method.
        method is one of (None, 'xml', 'html') where None means 'xml'.
        """
        assert self._c_out is not NULL
        c_method = self._method if method is None else _findOutputMethod(method)
        return _MethodChanger(self, c_method)

    def element(self, tag, attrib=None, nsmap=None, method=None, **_extra):
        """element(self, tag, attrib=None, nsmap=None, method, **_extra)

        Returns a context manager that writes an opening and closing tag.
        method is one of (None, 'xml', 'html') where None means 'xml'.
        """
        assert self._c_out is not NULL
        attributes = []
        if attrib is not None:
            for name, value in _iter_attrib(attrib):
                if name not in _extra:
                    ns, name = _getNsTag(name)
                    attributes.append((ns, name, _utf8(value)))
        if _extra:
            for name, value in _extra.iteritems():
                ns, name = _getNsTag(name)
                attributes.append((ns, name, _utf8(value)))
        reversed_nsmap = {}
        if nsmap:
            for prefix, ns in nsmap.items():
                if prefix is not None:
                    prefix = _utf8(prefix)
                    _prefixValidOrRaise(prefix)
                reversed_nsmap[_utf8(ns)] = prefix
        ns, name = _getNsTag(tag)

        c_method = self._method if method is None else _findOutputMethod(method)

        return _FileWriterElement(self, (ns, name, attributes, reversed_nsmap), c_method)

    cdef _write_qname(self, bytes name, bytes prefix):
        if prefix:  # empty bytes for no prefix (not None to allow sorting)
            tree.xmlOutputBufferWrite(self._c_out, len(prefix), _cstr(prefix))
            tree.xmlOutputBufferWrite(self._c_out, 1, ':')
        tree.xmlOutputBufferWrite(self._c_out, len(name), _cstr(name))

    cdef _write_start_element(self, element_config):
        if self._status > WRITER_IN_ELEMENT:
            raise LxmlSyntaxError("cannot append trailing element to complete XML document")
        ns, name, attributes, nsmap = element_config
        flat_namespace_map, new_namespaces = self._collect_namespaces(nsmap)
        prefix = self._find_prefix(ns, flat_namespace_map, new_namespaces)
        tree.xmlOutputBufferWrite(self._c_out, 1, '<')
        self._write_qname(name, prefix)

        self._write_attributes_and_namespaces(
            attributes, flat_namespace_map, new_namespaces)

        tree.xmlOutputBufferWrite(self._c_out, 1, '>')
        if not self._buffered:
            tree.xmlOutputBufferFlush(self._c_out)
        self._handle_error(self._c_out.error)

        self._element_stack.append((ns, name, prefix, flat_namespace_map))
        self._status = WRITER_IN_ELEMENT

    cdef _write_attributes_and_namespaces(self, list attributes,
                                          dict flat_namespace_map,
                                          list new_namespaces):
        if attributes:
            # _find_prefix() may append to new_namespaces => build them first
            attributes = [
                (self._find_prefix(ns, flat_namespace_map, new_namespaces), name, value)
                for ns, name, value in attributes ]
        if new_namespaces:
            new_namespaces.sort()
            self._write_attributes_list(new_namespaces)
        if attributes:
            self._write_attributes_list(attributes)

    cdef _write_attributes_list(self, list attributes):
        for prefix, name, value in attributes:
            tree.xmlOutputBufferWrite(self._c_out, 1, ' ')
            self._write_qname(name, prefix)
            tree.xmlOutputBufferWrite(self._c_out, 2, '="')
            _write_attr_string(self._c_out, _cstr(value))

            tree.xmlOutputBufferWrite(self._c_out, 1, '"')

    cdef _write_end_element(self, element_config):
        if self._status != WRITER_IN_ELEMENT:
            raise LxmlSyntaxError("not in an element")
        if not self._element_stack or self._element_stack[-1][:2] != element_config[:2]:
            raise LxmlSyntaxError("inconsistent exit action in context manager")

        # If previous write operations failed, the context manager exit might still call us.
        # That is ok, but we stop writing closing tags and handling errors in that case.
        # For all non-I/O errors, we continue writing closing tags if we can.
        ok_to_write = self._c_out.error == xmlerror.XML_ERR_OK

        name, prefix = self._element_stack.pop()[1:3]
        if ok_to_write:
            tree.xmlOutputBufferWrite(self._c_out, 2, '</')
            self._write_qname(name, prefix)
            tree.xmlOutputBufferWrite(self._c_out, 1, '>')

        if not self._element_stack:
            self._status = WRITER_FINISHED
        if ok_to_write:
            if not self._buffered:
                tree.xmlOutputBufferFlush(self._c_out)
            self._handle_error(self._c_out.error)

    cdef _find_prefix(self, bytes href, dict flat_namespaces_map, list new_namespaces):
        if href is None:
            return None
        if href in flat_namespaces_map:
            return flat_namespaces_map[href]
        # need to create a new prefix
        prefixes = flat_namespaces_map.values()
        i = 0
        while True:
            prefix = _utf8('ns%d' % i)
            if prefix not in prefixes:
                new_namespaces.append((b'xmlns', prefix, href))
                flat_namespaces_map[href] = prefix
                return prefix
            i += 1

    cdef _collect_namespaces(self, dict nsmap):
        new_namespaces = []
        flat_namespaces_map = {}
        for ns, prefix in nsmap.iteritems():
            flat_namespaces_map[ns] = prefix
            if prefix is None:
                # use empty bytes rather than None to allow sorting
                new_namespaces.append((b'', b'xmlns', ns))
            else:
                new_namespaces.append((b'xmlns', prefix, ns))
        # merge in flat namespace map of parent
        if self._element_stack:
            for ns, prefix in (<dict>self._element_stack[-1][-1]).iteritems():
                if flat_namespaces_map.get(ns) is None:
                    # unknown or empty prefix => prefer a 'real' prefix
                    flat_namespaces_map[ns] = prefix
        return flat_namespaces_map, new_namespaces

    def write(self, *args, bint with_tail=True, bint pretty_print=False, method=None):
        """write(self, *args, with_tail=True, pretty_print=False, method=None)

        Write subtrees or strings into the file.

        If method is not None, it should be one of ('html', 'xml', 'text')
        to temporarily override the output method.
        """
        assert self._c_out is not NULL
        c_method = self._method if method is None else _findOutputMethod(method)

        for content in args:
            if _isString(content):
                if self._status != WRITER_IN_ELEMENT:
                    if self._status > WRITER_IN_ELEMENT or content.strip():
                        raise LxmlSyntaxError("not in an element")
                bstring = _utf8(content)
                if not bstring:
                    continue

                ns, name, _, _ = self._element_stack[-1]
                if (c_method == OUTPUT_METHOD_HTML and
                        ns in (None, b'http://www.w3.org/1999/xhtml') and
                        name in (b'script', b'style')):
                    tree.xmlOutputBufferWrite(self._c_out, len(bstring), _cstr(bstring))

                else:
                    tree.xmlOutputBufferWriteEscape(self._c_out, _xcstr(bstring), NULL)

            elif isinstance(content, CDATA):
                if self._status > WRITER_IN_ELEMENT:
                    raise LxmlSyntaxError("not in an element")
                _write_cdata_string(self._c_out, (<CDATA>content)._utf8_data)

            elif iselement(content):
                if self._status > WRITER_IN_ELEMENT:
                    raise LxmlSyntaxError("cannot append trailing element to complete XML document")
                _writeNodeToBuffer(self._c_out, (<_Element>content)._c_node,
                                   self._c_encoding, NULL, c_method,
                                   False, False, pretty_print, with_tail, False)
                if (<_Element>content)._c_node.type == tree.XML_ELEMENT_NODE:
                    if not self._element_stack:
                        self._status = WRITER_FINISHED

            elif content is not None:
                raise TypeError(
                    f"got invalid input value of type {type(content)}, expected string, CDATA or Element")

            self._handle_error(self._c_out.error)

        if not self._buffered:
            tree.xmlOutputBufferFlush(self._c_out)
            self._handle_error(self._c_out.error)

    def flush(self):
        """flush(self)

        Write any pending content of the current output buffer to the stream.
        """
        assert self._c_out is not NULL
        tree.xmlOutputBufferFlush(self._c_out)
        self._handle_error(self._c_out.error)

    cdef _close(self, bint raise_on_error):
        if raise_on_error:
            if self._status < WRITER_IN_ELEMENT:
                raise LxmlSyntaxError("no content written")
            if self._element_stack:
                raise LxmlSyntaxError("pending open tags on close")
        error_result = self._c_out.error
        if error_result == xmlerror.XML_ERR_OK:
            error_result = tree.xmlOutputBufferClose(self._c_out)
            if error_result != -1:
                error_result = xmlerror.XML_ERR_OK
        else:
            tree.xmlOutputBufferClose(self._c_out)
        self._status = WRITER_FINISHED
        self._c_out = NULL
        del self._element_stack[:]
        if raise_on_error:
            self._handle_error(error_result)

    cdef _handle_error(self, int error_result):
        if error_result != xmlerror.XML_ERR_OK:
            if self._target is not None:
                self._target._exc_context._raise_if_stored()
            _raiseSerialisationError(error_result)


@cython.final
@cython.internal
cdef class _AsyncDataWriter:
    cdef list _data
    def __cinit__(self):
        self._data = []

    cdef bytes collect(self):
        data = b''.join(self._data)
        del self._data[:]
        return data

    def write(self, data):
        self._data.append(data)

    def close(self):
        pass


@cython.final
@cython.internal
cdef class _AsyncIncrementalFileWriter:
    cdef _IncrementalFileWriter _writer
    cdef _AsyncDataWriter _buffer
    cdef object _async_outfile
    cdef int _flush_after_writes
    cdef bint _should_close
    cdef bint _buffered

    def __cinit__(self, async_outfile, bytes encoding, int compresslevel, bint close,
                  bint buffered, int method):
        self._flush_after_writes = 20
        self._async_outfile = async_outfile
        self._should_close = close
        self._buffered = buffered
        self._buffer = _AsyncDataWriter()
        self._writer = _IncrementalFileWriter(
            self._buffer, encoding, compresslevel, close=True, buffered=False, method=method)

    cdef bytes _flush(self):
        if not self._buffered or len(self._buffer._data) > self._flush_after_writes:
            return self._buffer.collect()
        return None

    async def flush(self):
        self._writer.flush()
        data = self._buffer.collect()
        if data:
            await self._async_outfile.write(data)

    async def write_declaration(self, version=None, standalone=None, doctype=None):
        self._writer.write_declaration(version, standalone, doctype)
        data = self._flush()
        if data:
            await self._async_outfile.write(data)

    async def write_doctype(self, doctype):
        self._writer.write_doctype(doctype)
        data = self._flush()
        if data:
            await self._async_outfile.write(data)

    async def write(self, *args, with_tail=True, pretty_print=False, method=None):
        self._writer.write(*args, with_tail=with_tail, pretty_print=pretty_print, method=method)
        data = self._flush()
        if data:
            await self._async_outfile.write(data)

    def method(self, method):
        return self._writer.method(method)

    def element(self, tag, attrib=None, nsmap=None, method=None, **_extra):
        element_writer = self._writer.element(tag, attrib, nsmap, method, **_extra)
        return _AsyncFileWriterElement(element_writer, self)

    async def _close(self, bint raise_on_error):
        self._writer._close(raise_on_error)
        data = self._buffer.collect()
        if data:
            await self._async_outfile.write(data)
        if self._should_close:
            await self._async_outfile.close()


@cython.final
@cython.internal
cdef class _AsyncFileWriterElement:
    cdef _FileWriterElement _element_writer
    cdef _AsyncIncrementalFileWriter _writer

    def __cinit__(self, _FileWriterElement element_writer not None,
                  _AsyncIncrementalFileWriter writer not None):
        self._element_writer = element_writer
        self._writer = writer

    async def __aenter__(self):
        self._element_writer.__enter__()
        data = self._writer._flush()
        if data:
            await self._writer._async_outfile.write(data)

    async def __aexit__(self, *args):
        self._element_writer.__exit__(*args)
        data = self._writer._flush()
        if data:
            await self._writer._async_outfile.write(data)


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _FileWriterElement:
    cdef _IncrementalFileWriter _writer
    cdef object _element
    cdef int _new_method
    cdef int _old_method

    def __cinit__(self, _IncrementalFileWriter writer not None, element_config, int method):
        self._writer = writer
        self._element = element_config
        self._new_method = method
        self._old_method = writer._method

    def __enter__(self):
        self._writer._method = self._new_method
        self._writer._write_start_element(self._element)

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._writer._write_end_element(self._element)
        self._writer._method = self._old_method


@cython.final
@cython.internal
@cython.freelist(8)
cdef class _MethodChanger:
    cdef _IncrementalFileWriter _writer
    cdef int _new_method
    cdef int _old_method
    cdef bint _entered
    cdef bint _exited

    def __cinit__(self, _IncrementalFileWriter writer not None, int method):
        self._writer = writer
        self._new_method = method
        self._old_method = writer._method
        self._entered = False
        self._exited = False

    def __enter__(self):
        if self._entered:
            raise LxmlSyntaxError("Inconsistent enter action in context manager")
        self._writer._method = self._new_method
        self._entered = True

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._exited:
            raise LxmlSyntaxError("Inconsistent exit action in context manager")
        if self._writer._method != self._new_method:
            raise LxmlSyntaxError("Method changed outside of context manager")
        self._writer._method = self._old_method
        self._exited = True

    async def __aenter__(self):
        # for your async convenience
        return self.__enter__()

    async def __aexit__(self, *args):
        # for your async convenience
        return self.__exit__(*args)

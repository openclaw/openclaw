from libc.string cimport const_char

from lxml.includes.tree cimport xmlDoc
from lxml.includes.tree cimport xmlInputReadCallback, xmlInputCloseCallback
from lxml.includes.xmlparser cimport xmlParserCtxt, xmlSAXHandler, xmlSAXHandlerV1

cdef extern from "libxml/HTMLparser.h" nogil:
    ctypedef enum htmlParserOption:
        HTML_PARSE_NOERROR    # suppress error reports
        HTML_PARSE_NOWARNING  # suppress warning reports
        HTML_PARSE_PEDANTIC   # pedantic error reporting
        HTML_PARSE_NOBLANKS   # remove blank nodes
        HTML_PARSE_NONET      # Forbid network access
        # libxml2 2.6.21+ only:
        HTML_PARSE_RECOVER    # Relaxed parsing
        HTML_PARSE_COMPACT    # compact small text nodes
        # libxml2 2.7.7+ only:
        HTML_PARSE_NOIMPLIED  # Do not add implied html/body... elements
        # libxml2 2.7.8+ only:
        HTML_PARSE_NODEFDTD   # do not default a doctype if not found
        # libxml2 2.8.0+ only:
        XML_PARSE_IGNORE_ENC  # ignore internal document encoding hint

    xmlSAXHandlerV1 htmlDefaultSAXHandler

    cdef xmlParserCtxt* htmlCreateMemoryParserCtxt(
        char* buffer, int size)
    cdef xmlParserCtxt* htmlCreateFileParserCtxt(
        char* filename, char* encoding)
    cdef xmlParserCtxt* htmlCreatePushParserCtxt(xmlSAXHandler* sax,
                                                 void* user_data,
                                                 char* chunk, int size,
                                                 char* filename, int enc)
    cdef void htmlFreeParserCtxt(xmlParserCtxt* ctxt)
    cdef void htmlCtxtReset(xmlParserCtxt* ctxt)
    cdef int htmlCtxtUseOptions(xmlParserCtxt* ctxt, int options)
    cdef int htmlParseDocument(xmlParserCtxt* ctxt)
    cdef int htmlParseChunk(xmlParserCtxt* ctxt, 
                            char* chunk, int size, int terminate)

    cdef xmlDoc* htmlCtxtReadFile(xmlParserCtxt* ctxt,
                                  char* filename, const_char* encoding,
                                  int options)
    cdef xmlDoc* htmlCtxtReadDoc(xmlParserCtxt* ctxt,
                                 char* buffer, char* URL, const_char* encoding,
                                 int options)
    cdef xmlDoc* htmlCtxtReadIO(xmlParserCtxt* ctxt, 
                                xmlInputReadCallback ioread, 
                                xmlInputCloseCallback ioclose, 
                                void* ioctx,
                                char* URL, const_char* encoding,
                                int options)
    cdef xmlDoc* htmlCtxtReadMemory(xmlParserCtxt* ctxt,
                                    char* buffer, int size,
                                    char* filename, const_char* encoding,
                                    int options)

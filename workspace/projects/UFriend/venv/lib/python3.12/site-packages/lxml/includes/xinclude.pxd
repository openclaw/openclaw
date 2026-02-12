from lxml.includes.tree cimport xmlDoc, xmlNode

cdef extern from "libxml/xinclude.h" nogil:

    ctypedef struct xmlXIncludeCtxt

    cdef int xmlXIncludeProcess(xmlDoc* doc)
    cdef int xmlXIncludeProcessFlags(xmlDoc* doc, int parser_opts)
    cdef int xmlXIncludeProcessTree(xmlNode* doc)
    cdef int xmlXIncludeProcessTreeFlags(xmlNode* doc, int parser_opts)

    # libxml2 >= 2.7.4
    cdef int xmlXIncludeProcessTreeFlagsData(
            xmlNode* doc, int parser_opts, void* data)

    cdef xmlXIncludeCtxt* xmlXIncludeNewContext(xmlDoc* doc)
    cdef int xmlXIncludeProcessNode(xmlXIncludeCtxt* ctxt, xmlNode* node)
    cdef int xmlXIncludeSetFlags(xmlXIncludeCtxt* ctxt, int flags)

    # libxml2 >= 2.6.27
    cdef int xmlXIncludeProcessFlagsData(
        xmlDoc* doc, int flags, void* data)

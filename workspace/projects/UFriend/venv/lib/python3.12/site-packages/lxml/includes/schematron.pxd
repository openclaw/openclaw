from lxml.includes cimport xmlerror
from lxml.includes.tree cimport xmlDoc

cdef extern from "libxml/schematron.h" nogil:
    ctypedef struct xmlSchematron
    ctypedef struct xmlSchematronParserCtxt
    ctypedef struct xmlSchematronValidCtxt

    ctypedef enum xmlSchematronValidOptions:
        XML_SCHEMATRON_OUT_QUIET     =    1 # quiet no report
        XML_SCHEMATRON_OUT_TEXT      =    2 # build a textual report
        XML_SCHEMATRON_OUT_XML       =    4 # output SVRL
        XML_SCHEMATRON_OUT_ERROR     =    8 # output via xmlStructuredErrorFunc
        XML_SCHEMATRON_OUT_FILE      =  256 # output to a file descriptor
        XML_SCHEMATRON_OUT_BUFFER    =  512 # output to a buffer
        XML_SCHEMATRON_OUT_IO        = 1024 # output to I/O mechanism

    cdef xmlSchematronParserCtxt* xmlSchematronNewDocParserCtxt(
        xmlDoc* doc)
    cdef xmlSchematronParserCtxt* xmlSchematronNewParserCtxt(
        char* filename) nogil
    cdef xmlSchematronValidCtxt* xmlSchematronNewValidCtxt(
        xmlSchematron* schema, int options)

    cdef xmlSchematron* xmlSchematronParse(xmlSchematronParserCtxt* ctxt)
    cdef int xmlSchematronValidateDoc(xmlSchematronValidCtxt* ctxt,
                                      xmlDoc* instance)

    cdef void xmlSchematronFreeParserCtxt(xmlSchematronParserCtxt* ctxt)
    cdef void xmlSchematronFreeValidCtxt(xmlSchematronValidCtxt* ctxt)
    cdef void xmlSchematronFree(xmlSchematron* schema)
    cdef void xmlSchematronSetValidStructuredErrors(
        xmlSchematronValidCtxt* ctxt,
        xmlerror.xmlStructuredErrorFunc error_func, void *data)

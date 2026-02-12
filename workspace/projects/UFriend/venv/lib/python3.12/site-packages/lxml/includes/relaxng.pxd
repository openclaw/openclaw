from lxml.includes.tree cimport xmlDoc
from lxml.includes.xmlerror cimport xmlStructuredErrorFunc

cdef extern from "libxml/relaxng.h" nogil:
    ctypedef struct xmlRelaxNG
    ctypedef struct xmlRelaxNGParserCtxt
    
    ctypedef struct xmlRelaxNGValidCtxt
    
    ctypedef enum xmlRelaxNGValidErr:
        XML_RELAXNG_OK = 0
        XML_RELAXNG_ERR_MEMORY = 1
        XML_RELAXNG_ERR_TYPE = 2
        XML_RELAXNG_ERR_TYPEVAL = 3
        XML_RELAXNG_ERR_DUPID = 4
        XML_RELAXNG_ERR_TYPECMP = 5
        XML_RELAXNG_ERR_NOSTATE = 6
        XML_RELAXNG_ERR_NODEFINE = 7
        XML_RELAXNG_ERR_LISTEXTRA = 8
        XML_RELAXNG_ERR_LISTEMPTY = 9
        XML_RELAXNG_ERR_INTERNODATA = 10
        XML_RELAXNG_ERR_INTERSEQ = 11
        XML_RELAXNG_ERR_INTEREXTRA = 12
        XML_RELAXNG_ERR_ELEMNAME = 13
        XML_RELAXNG_ERR_ATTRNAME = 14
        XML_RELAXNG_ERR_ELEMNONS = 15
        XML_RELAXNG_ERR_ATTRNONS = 16
        XML_RELAXNG_ERR_ELEMWRONGNS = 17
        XML_RELAXNG_ERR_ATTRWRONGNS = 18
        XML_RELAXNG_ERR_ELEMEXTRANS = 19
        XML_RELAXNG_ERR_ATTREXTRANS = 20
        XML_RELAXNG_ERR_ELEMNOTEMPTY = 21
        XML_RELAXNG_ERR_NOELEM = 22
        XML_RELAXNG_ERR_NOTELEM = 23
        XML_RELAXNG_ERR_ATTRVALID = 24
        XML_RELAXNG_ERR_CONTENTVALID = 25
        XML_RELAXNG_ERR_EXTRACONTENT = 26
        XML_RELAXNG_ERR_INVALIDATTR = 27
        XML_RELAXNG_ERR_DATAELEM = 28
        XML_RELAXNG_ERR_VALELEM = 29
        XML_RELAXNG_ERR_LISTELEM = 30
        XML_RELAXNG_ERR_DATATYPE = 31
        XML_RELAXNG_ERR_VALUE = 32
        XML_RELAXNG_ERR_LIST = 33
        XML_RELAXNG_ERR_NOGRAMMAR = 34
        XML_RELAXNG_ERR_EXTRADATA = 35
        XML_RELAXNG_ERR_LACKDATA = 36
        XML_RELAXNG_ERR_INTERNAL = 37
        XML_RELAXNG_ERR_ELEMWRONG = 38
        XML_RELAXNG_ERR_TEXTWRONG = 39
        
    cdef xmlRelaxNGValidCtxt* xmlRelaxNGNewValidCtxt(xmlRelaxNG* schema)
    cdef int xmlRelaxNGValidateDoc(xmlRelaxNGValidCtxt* ctxt, xmlDoc* doc)
    cdef xmlRelaxNG* xmlRelaxNGParse(xmlRelaxNGParserCtxt* ctxt)
    cdef xmlRelaxNGParserCtxt* xmlRelaxNGNewParserCtxt(char* URL)
    cdef xmlRelaxNGParserCtxt* xmlRelaxNGNewDocParserCtxt(xmlDoc* doc)
    cdef void xmlRelaxNGFree(xmlRelaxNG* schema)
    cdef void xmlRelaxNGFreeParserCtxt(xmlRelaxNGParserCtxt* ctxt)
    cdef void xmlRelaxNGFreeValidCtxt(xmlRelaxNGValidCtxt* ctxt)

    cdef void xmlRelaxNGSetValidStructuredErrors(
        xmlRelaxNGValidCtxt* ctxt, xmlStructuredErrorFunc serror, void *ctx)
    cdef void xmlRelaxNGSetParserStructuredErrors(
        xmlRelaxNGParserCtxt* ctxt, xmlStructuredErrorFunc serror, void *ctx)

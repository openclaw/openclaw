from lxml.includes.tree cimport xmlDoc, xmlOutputBuffer, xmlChar
from lxml.includes.xpath cimport xmlNodeSet

cdef extern from "libxml/c14n.h" nogil:
    cdef int xmlC14NDocDumpMemory(xmlDoc* doc,
                                  xmlNodeSet* nodes,
                                  int exclusive,
                                  xmlChar** inclusive_ns_prefixes,
                                  int with_comments,
                                  xmlChar** doc_txt_ptr)

    cdef int xmlC14NDocSave(xmlDoc* doc,
                            xmlNodeSet* nodes,
                            int exclusive,
                            xmlChar** inclusive_ns_prefixes,
                            int with_comments,
                            char* filename,
                            int compression)

    cdef int xmlC14NDocSaveTo(xmlDoc* doc,
                              xmlNodeSet* nodes,
                              int exclusive,
                              xmlChar** inclusive_ns_prefixes,
                              int with_comments,
                              xmlOutputBuffer* buffer)

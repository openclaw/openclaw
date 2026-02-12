from lxml.includes.tree cimport xmlDoc, xmlNode, xmlDict, xmlChar, const_xmlChar, xmlOutputBuffer
from lxml.includes.xmlerror cimport xmlGenericErrorFunc
from lxml.includes.xpath cimport xmlXPathContext, xmlXPathFunction

from libc.string cimport const_char

cdef extern from "libxslt/xslt.h":
    cdef int xsltLibxsltVersion
    cdef int xsltMaxDepth

cdef extern from "libxslt/xsltconfig.h":
    cdef int LIBXSLT_VERSION

cdef extern from "libxslt/xsltInternals.h" nogil:
    ctypedef enum xsltTransformState:
        XSLT_STATE_OK       # 0
        XSLT_STATE_ERROR    # 1
        XSLT_STATE_STOPPED  # 2

    ctypedef struct xsltDocument:
        xmlDoc* doc

    ctypedef struct xsltStylesheet:
        xmlChar* encoding
        xmlDoc* doc
        int errors

    ctypedef struct xsltTransformContext:
        xsltStylesheet* style
        xmlXPathContext* xpathCtxt
        xsltDocument* document
        void* _private
        xmlDict* dict
        int profile
        xmlNode* node
        xmlDoc* output
        xmlNode* insert
        xmlNode* inst
        xsltTransformState state

    ctypedef struct xsltStackElem

    ctypedef struct xsltTemplate

    cdef xsltStylesheet* xsltParseStylesheetDoc(xmlDoc* doc)
    cdef void xsltFreeStylesheet(xsltStylesheet* sheet)

cdef extern from "libxslt/imports.h" nogil:
    # actually defined in "etree_defs.h"
    cdef void LXML_GET_XSLT_ENCODING(const_xmlChar* result_var, xsltStylesheet* style)

cdef extern from "libxslt/extensions.h" nogil:
    ctypedef void (*xsltTransformFunction)(xsltTransformContext* ctxt,
                                           xmlNode* context_node,
                                           xmlNode* inst,
                                           void* precomp_unused) noexcept

    cdef int xsltRegisterExtFunction(xsltTransformContext* ctxt,
                                     const_xmlChar* name,
                                     const_xmlChar* URI,
                                     xmlXPathFunction function)
    cdef int xsltRegisterExtModuleFunction(const_xmlChar* name, const_xmlChar* URI,
                                           xmlXPathFunction function)
    cdef int xsltUnregisterExtModuleFunction(const_xmlChar* name, const_xmlChar* URI)
    cdef xmlXPathFunction xsltExtModuleFunctionLookup(
        const_xmlChar* name, const_xmlChar* URI)
    cdef int xsltRegisterExtPrefix(xsltStylesheet* style, 
                                   const_xmlChar* prefix, const_xmlChar* URI)
    cdef int xsltRegisterExtElement(xsltTransformContext* ctxt,
                                    const_xmlChar* name, const_xmlChar* URI,
                                    xsltTransformFunction function)

cdef extern from "libxslt/documents.h" nogil:
    ctypedef enum xsltLoadType:
        XSLT_LOAD_START
        XSLT_LOAD_STYLESHEET
        XSLT_LOAD_DOCUMENT

    ctypedef xmlDoc* (*xsltDocLoaderFunc)(const_xmlChar* URI, xmlDict* dict,
                                          int options,
                                          void* ctxt,
                                          xsltLoadType type) noexcept
    cdef xsltDocLoaderFunc xsltDocDefaultLoader
    cdef void xsltSetLoaderFunc(xsltDocLoaderFunc f)

cdef extern from "libxslt/transform.h" nogil:
    cdef xmlDoc* xsltApplyStylesheet(xsltStylesheet* style, xmlDoc* doc,
                                     const_char** params)
    cdef xmlDoc* xsltApplyStylesheetUser(xsltStylesheet* style, xmlDoc* doc,
                                         const_char** params, const_char* output,
                                         void* profile,
                                         xsltTransformContext* context)
    cdef void xsltProcessOneNode(xsltTransformContext* ctxt,
                                 xmlNode* contextNode,
                                 xsltStackElem* params)
    cdef xsltTransformContext* xsltNewTransformContext(xsltStylesheet* style,
                                                       xmlDoc* doc)
    cdef void xsltFreeTransformContext(xsltTransformContext* context)
    cdef void xsltApplyOneTemplate(xsltTransformContext* ctxt,
                                   xmlNode* contextNode, xmlNode* list,
                                   xsltTemplate* templ,
                                   xsltStackElem* params)


cdef extern from "libxslt/xsltutils.h" nogil:
    cdef int xsltSaveResultToString(xmlChar** doc_txt_ptr,
                                    int* doc_txt_len,
                                    xmlDoc* result,
                                    xsltStylesheet* style)
    cdef int xsltSaveResultToFilename(const_char *URL,
                                      xmlDoc* result,
                                      xsltStylesheet* style,
                                      int compression)
    cdef int xsltSaveResultTo(xmlOutputBuffer* buf,
                              xmlDoc* result,
                              xsltStylesheet* style)
    cdef xmlGenericErrorFunc xsltGenericError
    cdef void *xsltGenericErrorContext
    cdef void xsltSetGenericErrorFunc(
        void* ctxt, void (*handler)(void* ctxt, char* msg, ...) nogil)
    cdef void xsltSetTransformErrorFunc(
        xsltTransformContext*, void* ctxt,
        void (*handler)(void* ctxt, char* msg, ...) nogil)
    cdef void xsltTransformError(xsltTransformContext* ctxt, 
                                 xsltStylesheet* style, 
                                 xmlNode* node, char* msg, ...)
    cdef void xsltSetCtxtParseOptions(
        xsltTransformContext* ctxt, int options)


cdef extern from "libxslt/security.h" nogil:
    ctypedef struct xsltSecurityPrefs
    ctypedef enum xsltSecurityOption:
        XSLT_SECPREF_READ_FILE = 1
        XSLT_SECPREF_WRITE_FILE = 2
        XSLT_SECPREF_CREATE_DIRECTORY = 3
        XSLT_SECPREF_READ_NETWORK = 4
        XSLT_SECPREF_WRITE_NETWORK = 5

    ctypedef int (*xsltSecurityCheck)(xsltSecurityPrefs* sec,
                                      xsltTransformContext* ctxt,
                                      char* value) noexcept

    cdef xsltSecurityPrefs* xsltNewSecurityPrefs()
    cdef void xsltFreeSecurityPrefs(xsltSecurityPrefs* sec)
    cdef int xsltSecurityForbid(xsltSecurityPrefs* sec,
                                xsltTransformContext* ctxt,
                                char* value)
    cdef int xsltSecurityAllow(xsltSecurityPrefs* sec,
                                xsltTransformContext* ctxt,
                                char* value)
    cdef int xsltSetSecurityPrefs(xsltSecurityPrefs* sec,
                                  xsltSecurityOption option,
                                  xsltSecurityCheck func)
    cdef xsltSecurityCheck xsltGetSecurityPrefs(
        xsltSecurityPrefs* sec,
        xsltSecurityOption option)
    cdef int xsltSetCtxtSecurityPrefs(xsltSecurityPrefs* sec,
                                      xsltTransformContext* ctxt)
    cdef xmlDoc* xsltGetProfileInformation(xsltTransformContext* ctxt)

cdef extern from "libxslt/variables.h" nogil:
    cdef int xsltQuoteUserParams(xsltTransformContext* ctxt,
                                 const_char** params)
    cdef int xsltQuoteOneUserParam(xsltTransformContext* ctxt,
                                   const_xmlChar* name,
                                   const_xmlChar* value)

cdef extern from "libxslt/extra.h" nogil:
    const_xmlChar* XSLT_LIBXSLT_NAMESPACE
    const_xmlChar* XSLT_XALAN_NAMESPACE
    const_xmlChar* XSLT_SAXON_NAMESPACE
    const_xmlChar* XSLT_XT_NAMESPACE

    cdef xmlXPathFunction xsltFunctionNodeSet
    cdef void xsltRegisterAllExtras()

cdef extern from "libexslt/exslt.h" nogil:
    cdef void exsltRegisterAll()

    # libexslt 1.1.25+
    const_xmlChar* EXSLT_DATE_NAMESPACE
    const_xmlChar* EXSLT_SETS_NAMESPACE
    const_xmlChar* EXSLT_MATH_NAMESPACE
    const_xmlChar* EXSLT_STRINGS_NAMESPACE

    cdef int exsltDateXpathCtxtRegister(xmlXPathContext* ctxt, const_xmlChar* prefix)
    cdef int exsltSetsXpathCtxtRegister(xmlXPathContext* ctxt, const_xmlChar* prefix)
    cdef int exsltMathXpathCtxtRegister(xmlXPathContext* ctxt, const_xmlChar* prefix)
    cdef int exsltStrXpathCtxtRegister(xmlXPathContext* ctxt, const_xmlChar* prefix)

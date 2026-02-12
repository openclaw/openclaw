from libc.string cimport const_char

from lxml.includes.tree cimport (
    xmlDoc, xmlNode, xmlEntity, xmlDict, xmlDtd, xmlChar, const_xmlChar)
from lxml.includes.tree cimport xmlInputReadCallback, xmlInputCloseCallback
from lxml.includes.xmlerror cimport xmlError, xmlStructuredErrorFunc, xmlErrorLevel


cdef extern from "libxml/parser.h" nogil:
    ctypedef void (*startElementNsSAX2Func)(void* ctx,
                                            const_xmlChar* localname,
                                            const_xmlChar* prefix,
                                            const_xmlChar* URI,
                                            int nb_namespaces,
                                            const_xmlChar** namespaces,
                                            int nb_attributes,
                                            int nb_defaulted,
                                            const_xmlChar** attributes) noexcept

    ctypedef void (*endElementNsSAX2Func)(void* ctx,
                                          const_xmlChar* localname,
                                          const_xmlChar* prefix,
                                          const_xmlChar* URI) noexcept

    ctypedef void (*startElementSAXFunc)(void* ctx, const_xmlChar* name, const_xmlChar** atts) noexcept

    ctypedef void (*endElementSAXFunc)(void* ctx, const_xmlChar* name) noexcept

    ctypedef void (*charactersSAXFunc)(void* ctx, const_xmlChar* ch, int len) noexcept

    ctypedef void (*cdataBlockSAXFunc)(void* ctx, const_xmlChar* value, int len) noexcept

    ctypedef void (*commentSAXFunc)(void* ctx, const_xmlChar* value) noexcept

    ctypedef void (*processingInstructionSAXFunc)(void* ctx,
                                                  const_xmlChar* target,
                                                  const_xmlChar* data) noexcept

    ctypedef void (*internalSubsetSAXFunc)(void* ctx,
                                            const_xmlChar* name,
                                            const_xmlChar* externalID,
                                            const_xmlChar* systemID) noexcept

    ctypedef void (*endDocumentSAXFunc)(void* ctx) noexcept

    ctypedef void (*startDocumentSAXFunc)(void* ctx) noexcept

    ctypedef void (*referenceSAXFunc)(void * ctx, const_xmlChar* name) noexcept

    ctypedef xmlEntity* (*getEntitySAXFunc)(void* ctx, const_xmlChar* name) noexcept

    cdef int XML_SAX2_MAGIC

cdef extern from "libxml/tree.h" nogil:
    ctypedef struct xmlParserInput:
        int line
        int col
        int length
        const_xmlChar* base
        const_xmlChar* cur
        const_xmlChar* end
        const_char *filename

    ctypedef struct xmlParserInputBuffer:
        void* context
        xmlInputReadCallback  readcallback
        xmlInputCloseCallback closecallback

    ctypedef struct xmlSAXHandlerV1:
        # same as xmlSAXHandler, but without namespaces
        pass

    ctypedef struct xmlSAXHandler:
        internalSubsetSAXFunc           internalSubset
        startElementNsSAX2Func          startElementNs
        endElementNsSAX2Func            endElementNs
        startElementSAXFunc             startElement
        endElementSAXFunc               endElement
        charactersSAXFunc               characters
        cdataBlockSAXFunc               cdataBlock
        referenceSAXFunc                reference
        getEntitySAXFunc                getEntity
        commentSAXFunc                  comment
        processingInstructionSAXFunc	processingInstruction
        startDocumentSAXFunc            startDocument
        endDocumentSAXFunc              endDocument
        int                             initialized
        xmlStructuredErrorFunc          serror
        void*                           _private


cdef extern from "libxml/SAX2.h" nogil:
    cdef void xmlSAX2StartDocument(void* ctxt)


cdef extern from "libxml/xmlIO.h" nogil:
    cdef xmlParserInputBuffer* xmlAllocParserInputBuffer(int enc)


cdef extern from "libxml/parser.h" nogil:

    ctypedef enum xmlFeature:
        XML_WITH_THREAD = 1
        XML_WITH_TREE = 2
        XML_WITH_OUTPUT = 3
        XML_WITH_PUSH = 4
        XML_WITH_READER = 5
        XML_WITH_PATTERN = 6
        XML_WITH_WRITER = 7
        XML_WITH_SAX1 = 8
        XML_WITH_FTP = 9
        XML_WITH_HTTP = 10
        XML_WITH_VALID = 11
        XML_WITH_HTML = 12
        XML_WITH_LEGACY = 13
        XML_WITH_C14N = 14
        XML_WITH_CATALOG = 15
        XML_WITH_XPATH = 16
        XML_WITH_XPTR = 17
        XML_WITH_XINCLUDE = 18
        XML_WITH_ICONV = 19
        XML_WITH_ISO8859X = 20
        XML_WITH_UNICODE = 21
        XML_WITH_REGEXP = 22
        XML_WITH_AUTOMATA = 23
        XML_WITH_EXPR = 24
        XML_WITH_SCHEMAS = 25
        XML_WITH_SCHEMATRON = 26
        XML_WITH_MODULES = 27
        XML_WITH_DEBUG = 28
        XML_WITH_DEBUG_MEM = 29
        XML_WITH_DEBUG_RUN = 30
        XML_WITH_ZLIB = 31
        XML_WITH_ICU = 32
        XML_WITH_LZMA = 33

    cdef bint xmlHasFeature(xmlFeature feature)

    cdef xmlDict* xmlDictCreate()
    cdef xmlDict* xmlDictCreateSub(xmlDict* subdict)
    cdef void xmlDictFree(xmlDict* sub)
    cdef int xmlDictReference(xmlDict* dict)

    cdef int XML_COMPLETE_ATTRS  # SAX option for adding DTD default attributes
    cdef int XML_SKIP_IDS        # SAX option for not building an XML ID dict

    ctypedef enum xmlParserInputState:
        XML_PARSER_EOF = -1  # nothing is to be parsed
        XML_PARSER_START = 0  # nothing has been parsed
        XML_PARSER_MISC = 1  # Misc* before int subset
        XML_PARSER_PI = 2  # Within a processing instruction
        XML_PARSER_DTD = 3  # within some DTD content
        XML_PARSER_PROLOG = 4  # Misc* after internal subset
        XML_PARSER_COMMENT = 5  # within a comment
        XML_PARSER_START_TAG = 6  # within a start tag
        XML_PARSER_CONTENT = 7  # within the content
        XML_PARSER_CDATA_SECTION = 8  # within a CDATA section
        XML_PARSER_END_TAG = 9  # within a closing tag
        XML_PARSER_ENTITY_DECL = 10  # within an entity declaration
        XML_PARSER_ENTITY_VALUE = 11  # within an entity value in a decl
        XML_PARSER_ATTRIBUTE_VALUE = 12  # within an attribute value
        XML_PARSER_SYSTEM_LITERAL = 13  # within a SYSTEM value
        XML_PARSER_EPILOG = 14  # the Misc* after the last end tag
        XML_PARSER_IGNORE = 15  # within an IGNORED section
        XML_PARSER_PUBLIC_LITERAL = 16  # within a PUBLIC value


    ctypedef struct xmlParserCtxt:
        xmlDoc* myDoc
        xmlDict* dict
        int dictNames
        void* _private
        bint wellFormed
        bint recovery
        int options
        bint disableSAX
        int errNo
        xmlParserInputState instate
        bint replaceEntities
        int loadsubset  # != 0 if enabled, int value == why
        bint validate
        xmlError lastError
        xmlNode* node
        xmlSAXHandler* sax
        void* userData
        int* spaceTab
        int spaceMax
        int nsNr
        bint html
        bint progressive
        int inSubset
        int charset
        xmlParserInput* input
        int inputNr
        xmlParserInput* inputTab[]

    ctypedef enum xmlParserOption:
        XML_PARSE_RECOVER = 0x1                   # recover on errors
        XML_PARSE_NOENT = 0x2                     # substitute entities
        XML_PARSE_DTDLOAD = 0x4                   # load the external subset
        XML_PARSE_DTDATTR = 0x8                   # default DTD attributes
        XML_PARSE_DTDVALID = 0x10                 # validate with the DTD
        XML_PARSE_NOERROR = 0x20                  # suppress error reports
        XML_PARSE_NOWARNING = 0x40                # suppress warning reports
        XML_PARSE_PEDANTIC = 0x80                 # pedantic error reporting
        XML_PARSE_NOBLANKS = 0x100                # remove blank nodes
        XML_PARSE_SAX1 = 0x200                    # use the SAX1 interface internally
        XML_PARSE_XINCLUDE = 0x400                # Implement XInclude substitution
        XML_PARSE_NONET = 0x800                   # Forbid network access
        XML_PARSE_NODICT = 0x1000                 # Do not reuse the context dictionary
        XML_PARSE_NSCLEAN = 0x2000                # remove redundant namespaces declarations
        XML_PARSE_NOCDATA = 0x4000                # merge CDATA as text nodes
        XML_PARSE_NOXINCNODE = 0x8000             # do not generate XINCLUDE START/END nodes
        # libxml2 2.6.21+ only:
        XML_PARSE_COMPACT = 0x1_0000              # compact small text nodes
        # libxml2 2.7.0+ only:
        XML_PARSE_OLD10 = 0x2_0000                # parse using XML-1.0 before update 5
        XML_PARSE_NOBASEFIX = 0x4_0000            # do not fixup XINCLUDE xml:base uris
        XML_PARSE_HUGE = 0x8_0000                 # relax any hardcoded limit from the parser
        # libxml2 2.7.3+ only:
        XML_PARSE_OLDSAX = 0x10_0000              # parse using SAX2 interface before 2.7.0
        # libxml2 2.8.0+ only:
        XML_PARSE_IGNORE_ENC = 0x20_0000          # ignore internal document encoding hint
        # libxml2 2.9.0+ only:
        XML_PARSE_BIG_LINES = 0x40_0000           # Store big lines numbers in text PSVI field
        # libxml2 2.13.0+ only:
        XML_PARSE_NO_XXE = 0x80_0000              # Disable loading of external DTDs or entities
        # libxml2 2.14.0+ only:
        XML_PARSE_UNZIP = 0x100_0000              # Enable input decompression (and potential gzip bombs)
        XML_PARSE_NO_SYS_CATALOG = 0x200_0000     # Disable the global system XML catalog
        XML_PARSE_CATALOG_PI = 0x400_0000         # Enable XML catalog processing instructions
        # libxml2 2.15.0+ only:
        XML_PARSE_SKIP_IDS = 0x800_0000           # Force the parser to ignore IDs

    cdef void xmlInitParser()
    cdef void xmlCleanupParser()

    cdef int xmlLineNumbersDefault(int onoff)
    cdef xmlParserCtxt* xmlNewParserCtxt()
    cdef xmlParserInput* xmlNewIOInputStream(xmlParserCtxt* ctxt,
                                             xmlParserInputBuffer* input,
                                             int enc)
    cdef int xmlCtxtUseOptions(xmlParserCtxt* ctxt, int options)
    cdef void xmlFreeParserCtxt(xmlParserCtxt* ctxt)
    cdef void xmlCtxtReset(xmlParserCtxt* ctxt)
    cdef void xmlClearParserCtxt(xmlParserCtxt* ctxt)
    cdef int xmlParseChunk(xmlParserCtxt* ctxt,
                           char* chunk, int size, int terminate)
    cdef xmlDoc* xmlCtxtReadDoc(xmlParserCtxt* ctxt,
                                char* cur, char* URL, char* encoding,
                                int options)
    cdef xmlDoc* xmlCtxtReadFile(xmlParserCtxt* ctxt,
                                 char* filename, char* encoding,
                                 int options)
    cdef xmlDoc* xmlCtxtReadIO(xmlParserCtxt* ctxt,
                               xmlInputReadCallback ioread,
                               xmlInputCloseCallback ioclose,
                               void* ioctx,
                               char* URL, char* encoding,
                               int options)
    cdef xmlDoc* xmlCtxtReadMemory(xmlParserCtxt* ctxt,
                                   char* buffer, int size,
                                   char* filename, const_char* encoding,
                                   int options)

    cdef void xmlErrParser(xmlParserCtxt* ctxt, xmlNode* node,
                           int domain, int code, xmlErrorLevel level,
                           const xmlChar *str1, const xmlChar *str2, const xmlChar *str3,
                           int int1, const char *msg, ...)


# iterparse:

    cdef xmlParserCtxt* xmlCreatePushParserCtxt(xmlSAXHandler* sax,
                                                void* user_data,
                                                char* chunk,
                                                int size,
                                                char* filename)

    cdef int xmlCtxtResetPush(xmlParserCtxt* ctxt,
                              char* chunk,
                              int size,
                              char* filename,
                              char* encoding)

# entity loaders:

    ctypedef xmlParserInput* (*xmlExternalEntityLoader)(
        const_char * URL, const_char * ID, xmlParserCtxt* context) noexcept
    cdef xmlExternalEntityLoader xmlGetExternalEntityLoader()
    cdef void xmlSetExternalEntityLoader(xmlExternalEntityLoader f)

    cdef xmlEntity* xmlSAX2GetEntity(void* ctxt, const_xmlChar* name) noexcept

# DTDs:

    cdef xmlDtd* xmlParseDTD(const_xmlChar* ExternalID, const_xmlChar* SystemID)
    cdef xmlDtd* xmlIOParseDTD(xmlSAXHandler* sax,
                               xmlParserInputBuffer* input,
                               int enc)


cdef extern from "libxml/parserInternals.h" nogil:
    """
    #if LIBXML_VERSION < 21400
    #define xmlNewInputFromMemory(url, mem, size, flags)  (NULL)
    #endif
    """
    cdef xmlParserInput* xmlNewInputStream(xmlParserCtxt* ctxt)
    cdef xmlParserInput* xmlNewStringInputStream(xmlParserCtxt* ctxt,
                                                 char* buffer)
    cdef xmlParserInput* xmlNewInputFromFile(xmlParserCtxt* ctxt,
                                             char* filename)
    cdef xmlParserInput* xmlNewInputFromMemory(
        const char *url, const void *mem, size_t size, int flags)  # actually "xmlParserInputFlags flags"
    cdef void xmlFreeInputStream(xmlParserInput* input)
    cdef int xmlSwitchEncoding(xmlParserCtxt* ctxt, int enc)
    cdef bint xmlCtxtIsStopped(xmlParserCtxt* ctxt)

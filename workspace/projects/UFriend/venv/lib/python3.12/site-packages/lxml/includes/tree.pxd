from libc cimport stdio
from libc.string cimport const_char, const_uchar

cdef extern from "lxml-version.h":
    # deprecated declaration, use etreepublic.pxd instead
    cdef char* LXML_VERSION_STRING

cdef extern from "libxml/xmlversion.h":
    const char* xmlParserVersion
    int LIBXML_VERSION


cdef extern from "libxml/xmlstring.h" nogil:
    ctypedef unsigned char xmlChar
    ctypedef const xmlChar const_xmlChar "const xmlChar"
    cdef int xmlStrlen(const_xmlChar* str)
    cdef xmlChar* xmlStrdup(const_xmlChar* cur)
    cdef int xmlStrncmp(const_xmlChar* str1, const_xmlChar* str2, int length)
    cdef int xmlStrcmp(const_xmlChar* str1, const_xmlChar* str2)
    cdef int xmlStrcasecmp(const xmlChar *str1, const xmlChar *str2)
    cdef const_xmlChar* xmlStrstr(const_xmlChar* str1, const_xmlChar* str2)
    cdef const_xmlChar* xmlStrchr(const_xmlChar* str1, xmlChar ch)
    cdef const_xmlChar* _xcstr "(const xmlChar*)PyBytes_AS_STRING" (object s)

cdef extern from "libxml/encoding.h" nogil:
    ctypedef enum xmlCharEncoding:
        XML_CHAR_ENCODING_ERROR = -1 # No char encoding detected
        XML_CHAR_ENCODING_NONE = 0 # No char encoding detected
        XML_CHAR_ENCODING_UTF8 = 1 # UTF-8
        XML_CHAR_ENCODING_UTF16LE = 2 # UTF-16 little endian
        XML_CHAR_ENCODING_UTF16BE = 3 # UTF-16 big endian
        XML_CHAR_ENCODING_UCS4LE = 4 # UCS-4 little endian
        XML_CHAR_ENCODING_UCS4BE = 5 # UCS-4 big endian
        XML_CHAR_ENCODING_EBCDIC = 6 # EBCDIC uh!
        XML_CHAR_ENCODING_UCS4_2143 = 7 # UCS-4 unusual ordering
        XML_CHAR_ENCODING_UCS4_3412 = 8 # UCS-4 unusual ordering
        XML_CHAR_ENCODING_UCS2 = 9 # UCS-2
        XML_CHAR_ENCODING_8859_1 = 10 # ISO-8859-1 ISO Latin 1
        XML_CHAR_ENCODING_8859_2 = 11 # ISO-8859-2 ISO Latin 2
        XML_CHAR_ENCODING_8859_3 = 12 # ISO-8859-3
        XML_CHAR_ENCODING_8859_4 = 13 # ISO-8859-4
        XML_CHAR_ENCODING_8859_5 = 14 # ISO-8859-5
        XML_CHAR_ENCODING_8859_6 = 15 # ISO-8859-6
        XML_CHAR_ENCODING_8859_7 = 16 # ISO-8859-7
        XML_CHAR_ENCODING_8859_8 = 17 # ISO-8859-8
        XML_CHAR_ENCODING_8859_9 = 18 # ISO-8859-9
        XML_CHAR_ENCODING_2022_JP = 19 # ISO-2022-JP
        XML_CHAR_ENCODING_SHIFT_JIS = 20 # Shift_JIS
        XML_CHAR_ENCODING_EUC_JP = 21 # EUC-JP
        XML_CHAR_ENCODING_ASCII = 22 # pure ASCII

    ctypedef struct xmlCharEncodingHandler:
        char* name

    cdef xmlCharEncodingHandler* xmlFindCharEncodingHandler(char* name)
    cdef xmlCharEncodingHandler* xmlGetCharEncodingHandler(
        xmlCharEncoding enc)
    cdef int xmlCharEncCloseFunc(xmlCharEncodingHandler* handler)
    cdef xmlCharEncoding xmlDetectCharEncoding(const_xmlChar* text, int len)
    cdef const_char* xmlGetCharEncodingName(xmlCharEncoding enc)
    cdef xmlCharEncoding xmlParseCharEncoding(char* name)
    ctypedef int (*xmlCharEncodingOutputFunc)(
            unsigned char *out_buf, int *outlen, const_uchar *in_buf, int *inlen)

cdef extern from "libxml/chvalid.h" nogil:
    cdef int xmlIsChar_ch(char c)
    cdef int xmlIsCharQ(int ch)

cdef extern from "libxml/hash.h":
    ctypedef struct xmlHashTable
    ctypedef void (*xmlHashScanner)(void* payload, void* data, const_xmlChar* name) noexcept  # may require GIL!
    void xmlHashScan(xmlHashTable* table, xmlHashScanner f, void* data) nogil
    void* xmlHashLookup(xmlHashTable* table, const_xmlChar* name) nogil
    ctypedef void (*xmlHashDeallocator)(void *payload, xmlChar *name) noexcept
    cdef xmlHashTable* xmlHashCreate(int size) nogil
    cdef xmlHashTable* xmlHashCreateDict(int size, xmlDict *dict) nogil
    cdef int xmlHashSize(xmlHashTable* table) nogil
    cdef void xmlHashFree(xmlHashTable* table, xmlHashDeallocator f) nogil

cdef extern from * nogil: # actually "libxml/dict.h"
    # libxml/dict.h appears to be broken to include in C
    ctypedef struct xmlDict
    cdef const_xmlChar* xmlDictLookup(xmlDict* dict, const_xmlChar* name, int len)
    cdef const_xmlChar* xmlDictExists(xmlDict* dict, const_xmlChar* name, int len)
    cdef int xmlDictOwns(xmlDict* dict, const_xmlChar* name)
    cdef size_t xmlDictSize(xmlDict* dict)

cdef extern from "libxml/tree.h" nogil:
    ctypedef struct xmlDoc
    ctypedef struct xmlAttr
    ctypedef struct xmlNotationTable

    ctypedef enum xmlElementType:
        XML_ELEMENT_NODE=           1
        XML_ATTRIBUTE_NODE=         2
        XML_TEXT_NODE=              3
        XML_CDATA_SECTION_NODE=     4
        XML_ENTITY_REF_NODE=        5
        XML_ENTITY_NODE=            6
        XML_PI_NODE=                7
        XML_COMMENT_NODE=           8
        XML_DOCUMENT_NODE=          9
        XML_DOCUMENT_TYPE_NODE=     10
        XML_DOCUMENT_FRAG_NODE=     11
        XML_NOTATION_NODE=          12
        XML_HTML_DOCUMENT_NODE=     13
        XML_DTD_NODE=               14
        XML_ELEMENT_DECL=           15
        XML_ATTRIBUTE_DECL=         16
        XML_ENTITY_DECL=            17
        XML_NAMESPACE_DECL=         18
        XML_XINCLUDE_START=         19
        XML_XINCLUDE_END=           20

    ctypedef enum xmlElementTypeVal:
        XML_ELEMENT_TYPE_UNDEFINED= 0
        XML_ELEMENT_TYPE_EMPTY=     1
        XML_ELEMENT_TYPE_ANY=       2
        XML_ELEMENT_TYPE_MIXED=     3
        XML_ELEMENT_TYPE_ELEMENT=   4

    ctypedef enum xmlElementContentType:
        XML_ELEMENT_CONTENT_PCDATA=  1
        XML_ELEMENT_CONTENT_ELEMENT= 2
        XML_ELEMENT_CONTENT_SEQ=     3
        XML_ELEMENT_CONTENT_OR=      4

    ctypedef enum xmlElementContentOccur:
        XML_ELEMENT_CONTENT_ONCE= 1
        XML_ELEMENT_CONTENT_OPT=  2
        XML_ELEMENT_CONTENT_MULT= 3
        XML_ELEMENT_CONTENT_PLUS= 4

    ctypedef enum xmlAttributeType:
        XML_ATTRIBUTE_CDATA =      1
        XML_ATTRIBUTE_ID=          2
        XML_ATTRIBUTE_IDREF=       3
        XML_ATTRIBUTE_IDREFS=      4
        XML_ATTRIBUTE_ENTITY=      5
        XML_ATTRIBUTE_ENTITIES=    6
        XML_ATTRIBUTE_NMTOKEN=     7
        XML_ATTRIBUTE_NMTOKENS=    8
        XML_ATTRIBUTE_ENUMERATION= 9
        XML_ATTRIBUTE_NOTATION=    10

    ctypedef enum xmlAttributeDefault:
        XML_ATTRIBUTE_NONE=     1
        XML_ATTRIBUTE_REQUIRED= 2
        XML_ATTRIBUTE_IMPLIED=  3
        XML_ATTRIBUTE_FIXED=    4

    ctypedef enum xmlEntityType:
        XML_INTERNAL_GENERAL_ENTITY=          1
        XML_EXTERNAL_GENERAL_PARSED_ENTITY=   2
        XML_EXTERNAL_GENERAL_UNPARSED_ENTITY= 3
        XML_INTERNAL_PARAMETER_ENTITY=        4
        XML_EXTERNAL_PARAMETER_ENTITY=        5
        XML_INTERNAL_PREDEFINED_ENTITY=       6

    ctypedef enum xmlDocProperties:
        XML_DOC_WELLFORMED          = 1    # /* document is XML well formed */
        XML_DOC_NSVALID             = 2    # /* document is Namespace valid */
        XML_DOC_OLD10               = 4    # /* parsed with old XML-1.0 parser */
        XML_DOC_DTDVALID            = 8    # /* DTD validation was successful */
        XML_DOC_XINCLUDE            = 16   # /* XInclude substitution was done */
        XML_DOC_USERBUILT           = 32   # /* Document was built using the API
                                           #    and not by parsing an instance */
        XML_DOC_INTERNAL            = 64   # /* built for internal processing */
        XML_DOC_HTML                = 128  # /* parsed or built HTML document */

    ctypedef struct xmlNs:
        const_xmlChar* href
        const_xmlChar* prefix
        xmlNs* next

    ctypedef struct xmlNode:
        void* _private
        xmlElementType   type
        const_xmlChar* name
        xmlNode* children
        xmlNode* last
        xmlNode* parent
        xmlNode* next
        xmlNode* prev
        xmlDoc* doc
        xmlChar* content
        xmlAttr* properties
        xmlNs* ns
        xmlNs* nsDef
        unsigned short line

    ctypedef struct xmlElementContent:
        xmlElementContentType type
        xmlElementContentOccur ocur
        const_xmlChar *name
        xmlElementContent *c1
        xmlElementContent *c2
        xmlElementContent *parent
        const_xmlChar *prefix

    ctypedef struct xmlEnumeration:
        xmlEnumeration *next
        const_xmlChar *name

    ctypedef struct xmlAttribute:
        void* _private
        xmlElementType type
        const_xmlChar* name
        xmlNode* children
        xmlNode* last
        xmlDtd* parent
        xmlNode* next
        xmlNode* prev
        xmlDoc* doc
        xmlAttribute* nexth
        xmlAttributeType atype
        xmlAttributeDefault def_ "def"
        const_xmlChar* defaultValue
        xmlEnumeration* tree
        const_xmlChar* prefix
        const_xmlChar* elem

    ctypedef struct xmlElement:
        void* _private
        xmlElementType   type
        const_xmlChar* name
        xmlNode* children
        xmlNode* last
        xmlNode* parent
        xmlNode* next
        xmlNode* prev
        xmlDoc* doc
        xmlElementTypeVal etype
        xmlElementContent* content
        xmlAttribute* attributes
        const_xmlChar* prefix
        void *contModel

    ctypedef struct xmlEntity:
        void* _private
        xmlElementType type
        const_xmlChar* name
        xmlNode* children
        xmlNode* last
        xmlDtd* parent
        xmlNode* next
        xmlNode* prev
        xmlDoc* doc
        xmlChar* orig
        xmlChar* content
        int length
        xmlEntityType etype
        const_xmlChar* ExternalID
        const_xmlChar* SystemID
        xmlEntity* nexte
        const_xmlChar* URI
        int owner
        int checked

    ctypedef struct xmlDtd:
        const_xmlChar* name
        const_xmlChar* ExternalID
        const_xmlChar* SystemID
        void* notations
        void* entities
        void* pentities
        void* attributes
        void* elements
        xmlNode* children
        xmlNode* last
        xmlDoc* doc

    ctypedef struct xmlDoc:
        xmlElementType type
        char* name
        xmlNode* children
        xmlNode* last
        xmlNode* parent
        xmlNode* next
        xmlNode* prev
        xmlDoc* doc
        xmlDict* dict
        xmlHashTable* ids
        int standalone
        const_xmlChar* version
        const_xmlChar* encoding
        const_xmlChar* URL
        void* _private
        xmlDtd* intSubset
        xmlDtd* extSubset
        int properties

    ctypedef struct xmlAttr:
        void* _private
        xmlElementType type
        const_xmlChar* name
        xmlNode* children
        xmlNode* last
        xmlNode* parent
        xmlAttr* next
        xmlAttr* prev
        xmlDoc* doc
        xmlNs* ns
        xmlAttributeType atype

    ctypedef struct xmlID:
        const_xmlChar* value
        const_xmlChar* name
        xmlAttr* attr
        xmlDoc* doc

    ctypedef struct xmlBuffer

    ctypedef struct xmlBuf   # new in libxml2 2.9

    ctypedef struct xmlOutputBuffer:
        xmlBuf* buffer
        xmlBuf* conv
        int error

    const_xmlChar* XML_XML_NAMESPACE

    cdef void xmlFreeDoc(xmlDoc* cur)
    cdef void xmlFreeDtd(xmlDtd* cur)
    cdef void xmlFreeNode(xmlNode* cur)
    cdef void xmlFreeNsList(xmlNs* ns)
    cdef void xmlFreeNs(xmlNs* ns)
    cdef void xmlFree(void* buf)

    cdef xmlNode* xmlNewNode(xmlNs* ns, const_xmlChar* name)
    cdef xmlNode* xmlNewDocText(xmlDoc* doc, const_xmlChar* content)
    cdef xmlNode* xmlNewDocComment(xmlDoc* doc, const_xmlChar* content)
    cdef xmlNode* xmlNewDocPI(xmlDoc* doc, const_xmlChar* name, const_xmlChar* content)
    cdef xmlNode* xmlNewReference(xmlDoc* doc, const_xmlChar* name)
    cdef xmlNode* xmlNewCDataBlock(xmlDoc* doc, const_xmlChar* text, int len)
    cdef xmlNs* xmlNewNs(xmlNode* node, const_xmlChar* href, const_xmlChar* prefix)
    cdef xmlNode* xmlAddChild(xmlNode* parent, xmlNode* cur)
    cdef xmlNode* xmlReplaceNode(xmlNode* old, xmlNode* cur)
    cdef xmlNode* xmlAddPrevSibling(xmlNode* cur, xmlNode* elem)
    cdef xmlNode* xmlAddNextSibling(xmlNode* cur, xmlNode* elem)
    cdef xmlNode* xmlNewDocNode(xmlDoc* doc, xmlNs* ns,
                                const_xmlChar* name, const_xmlChar* content)
    cdef xmlDoc* xmlNewDoc(const_xmlChar* version)
    cdef xmlAttr* xmlNewProp(xmlNode* node, const_xmlChar* name, const_xmlChar* value)
    cdef xmlAttr* xmlNewNsProp(xmlNode* node, xmlNs* ns,
                               const_xmlChar* name, const_xmlChar* value)
    cdef xmlChar* xmlGetNoNsProp(xmlNode* node, const_xmlChar* name)
    cdef xmlChar* xmlGetNsProp(xmlNode* node, const_xmlChar* name, const_xmlChar* nameSpace)
    cdef void xmlSetNs(xmlNode* node, xmlNs* ns)
    cdef xmlAttr* xmlSetProp(xmlNode* node, const_xmlChar* name, const_xmlChar* value)
    cdef xmlAttr* xmlSetNsProp(xmlNode* node, xmlNs* ns,
                               const_xmlChar* name, const_xmlChar* value)
    cdef int xmlRemoveID(xmlDoc* doc, xmlAttr* cur)
    cdef int xmlRemoveProp(xmlAttr* cur)
    cdef void xmlFreePropList(xmlAttr* cur)
    cdef xmlChar* xmlGetNodePath(xmlNode* node)
    cdef void xmlDocDumpMemory(xmlDoc* cur, char** mem, int* size)
    cdef void xmlDocDumpMemoryEnc(xmlDoc* cur, char** mem, int* size,
                                  char* encoding)
    cdef int xmlSaveFileTo(xmlOutputBuffer* out, xmlDoc* cur,
                           char* encoding)

    cdef void xmlUnlinkNode(xmlNode* cur)
    cdef xmlNode* xmlDocSetRootElement(xmlDoc* doc, xmlNode* root)
    cdef xmlNode* xmlDocGetRootElement(xmlDoc* doc)
    cdef void xmlSetTreeDoc(xmlNode* tree, xmlDoc* doc)
    cdef xmlAttr* xmlHasProp(xmlNode* node, const_xmlChar* name)
    cdef xmlAttr* xmlHasNsProp(xmlNode* node, const_xmlChar* name, const_xmlChar* nameSpace)
    cdef xmlChar* xmlNodeGetContent(xmlNode* cur)
    cdef int xmlNodeBufGetContent(xmlBuffer* buffer, xmlNode* cur)
    cdef xmlNs* xmlSearchNs(xmlDoc* doc, xmlNode* node, const_xmlChar* prefix)
    cdef xmlNs* xmlSearchNsByHref(xmlDoc* doc, xmlNode* node, const_xmlChar* href)
    cdef int xmlIsBlankNode(xmlNode* node)
    cdef long xmlGetLineNo(xmlNode* node)
    cdef void xmlElemDump(stdio.FILE* f, xmlDoc* doc, xmlNode* cur)
    cdef void xmlNodeDumpOutput(xmlOutputBuffer* buf,
                                xmlDoc* doc, xmlNode* cur, int level,
                                int format, const_char* encoding)
    cdef void xmlBufAttrSerializeTxtContent(xmlOutputBuffer *buf, xmlDoc *doc,
                                xmlAttr *attr, const_xmlChar *string)
    cdef void xmlNodeSetName(xmlNode* cur, const_xmlChar* name)
    cdef void xmlNodeSetContent(xmlNode* cur, const_xmlChar* content)
    cdef xmlDtd* xmlCopyDtd(xmlDtd* dtd)
    cdef xmlDoc* xmlCopyDoc(xmlDoc* doc, int recursive)
    cdef xmlNode* xmlCopyNode(xmlNode* node, int extended)
    cdef xmlNode* xmlDocCopyNode(xmlNode* node, xmlDoc* doc, int extended)
    cdef int xmlReconciliateNs(xmlDoc* doc, xmlNode* tree)
    cdef xmlNs* xmlNewReconciliedNs(xmlDoc* doc, xmlNode* tree, xmlNs* ns)
    cdef xmlBuffer* xmlBufferCreate()
    cdef void xmlBufferWriteChar(xmlBuffer* buf, char* string)
    cdef void xmlBufferFree(xmlBuffer* buf)
    cdef const_xmlChar* xmlBufferContent(xmlBuffer* buf)
    cdef int xmlBufferLength(xmlBuffer* buf)
    cdef const_xmlChar* xmlBufContent(xmlBuf* buf) # new in libxml2 2.9
    cdef size_t xmlBufUse(xmlBuf* buf) # new in libxml2 2.9
    cdef int xmlKeepBlanksDefault(int val)
    cdef xmlChar* xmlNodeGetBase(xmlDoc* doc, xmlNode* node)
    cdef xmlDtd* xmlCreateIntSubset(xmlDoc* doc, const_xmlChar* name,
                                    const_xmlChar* ExternalID, const_xmlChar* SystemID)
    cdef void xmlNodeSetBase(xmlNode* node, const_xmlChar* uri)
    cdef int xmlValidateNCName(const_xmlChar* value, int space)

cdef extern from "libxml/uri.h" nogil:
    cdef const_xmlChar* xmlBuildURI(const_xmlChar* href, const_xmlChar* base)

cdef extern from "libxml/HTMLtree.h" nogil:
    cdef void htmlNodeDumpFormatOutput(xmlOutputBuffer* buf,
                                       xmlDoc* doc, xmlNode* cur,
                                       char* encoding, int format)
    cdef xmlDoc* htmlNewDoc(const_xmlChar* uri, const_xmlChar* externalID)

cdef extern from "libxml/valid.h" nogil:
    cdef xmlAttr* xmlGetID(xmlDoc* doc, const_xmlChar* ID)
    cdef void xmlDumpNotationTable(xmlBuffer* buffer,
                                   xmlNotationTable* table)
    cdef int xmlValidateNameValue(const_xmlChar* value)

cdef extern from "libxml/xmlIO.h":
    cdef int xmlOutputBufferWrite(xmlOutputBuffer* out,
                                  int len, const_char* str) nogil
    cdef int xmlOutputBufferWriteString(xmlOutputBuffer* out, const_char* str) nogil
    cdef int xmlOutputBufferWriteEscape(xmlOutputBuffer* out,
                                        const_xmlChar* str,
                                        xmlCharEncodingOutputFunc escapefunc) nogil
    cdef int xmlOutputBufferFlush(xmlOutputBuffer* out) nogil
    cdef int xmlOutputBufferClose(xmlOutputBuffer* out) nogil

    ctypedef int (*xmlInputReadCallback)(void* context,
                                         char* buffer, int len) noexcept nogil
    ctypedef int (*xmlInputCloseCallback)(void* context) noexcept nogil

    ctypedef int (*xmlOutputWriteCallback)(void* context,
                                           char* buffer, int len) noexcept
    ctypedef int (*xmlOutputCloseCallback)(void* context) noexcept

    cdef xmlOutputBuffer* xmlAllocOutputBuffer(
        xmlCharEncodingHandler* encoder) nogil
    cdef xmlOutputBuffer* xmlOutputBufferCreateIO(
        xmlOutputWriteCallback iowrite,
        xmlOutputCloseCallback ioclose,
        void * ioctx,
        xmlCharEncodingHandler* encoder) nogil
    cdef xmlOutputBuffer* xmlOutputBufferCreateFile(
        stdio.FILE* file, xmlCharEncodingHandler* encoder) nogil
    cdef xmlOutputBuffer* xmlOutputBufferCreateFilename(
        char* URI, xmlCharEncodingHandler* encoder, int compression) nogil

cdef extern from "libxml/xmlsave.h" nogil:
    ctypedef struct xmlSaveCtxt

    ctypedef enum xmlSaveOption:
        XML_SAVE_FORMAT   = 1   # format save output            (2.6.17)
        XML_SAVE_NO_DECL  = 2   # drop the xml declaration      (2.6.21)
        XML_SAVE_NO_EMPTY = 4   # no empty tags                 (2.6.22)
        XML_SAVE_NO_XHTML = 8   # disable XHTML1 specific rules (2.6.22)
        XML_SAVE_XHTML = 16     # force XHTML1 specific rules         (2.7.2)
        XML_SAVE_AS_XML = 32    # force XML serialization on HTML doc (2.7.2)
        XML_SAVE_AS_HTML = 64   # force HTML serialization on XML doc (2.7.2)

    cdef xmlSaveCtxt* xmlSaveToFilename(char* filename, char* encoding,
                                        int options)
    cdef xmlSaveCtxt* xmlSaveToBuffer(xmlBuffer* buffer, char* encoding,
                                      int options) # libxml2 2.6.23
    cdef long xmlSaveDoc(xmlSaveCtxt* ctxt, xmlDoc* doc)
    cdef long xmlSaveTree(xmlSaveCtxt* ctxt, xmlNode* node)
    cdef int xmlSaveClose(xmlSaveCtxt* ctxt)
    cdef int xmlSaveFlush(xmlSaveCtxt* ctxt)
    cdef int xmlSaveSetAttrEscape(xmlSaveCtxt* ctxt, void* escape_func)
    cdef int xmlSaveSetEscape(xmlSaveCtxt* ctxt, void* escape_func)

cdef extern from "libxml/globals.h" nogil:
    cdef int xmlThrDefKeepBlanksDefaultValue(int onoff)
    cdef int xmlThrDefLineNumbersDefaultValue(int onoff)
    cdef int xmlThrDefIndentTreeOutput(int onoff)

cdef extern from "libxml/xmlmemory.h" nogil:
    cdef void* xmlMalloc(size_t size)
    cdef int xmlMemBlocks()
    cdef int xmlMemUsed()

cdef extern from "etree_defs.h" nogil:
    cdef bint _isElement(xmlNode* node)
    cdef bint _isElementOrXInclude(xmlNode* node)
    cdef const_xmlChar* _getNs(xmlNode* node)
    cdef void BEGIN_FOR_EACH_ELEMENT_FROM(xmlNode* tree_top,
                                          xmlNode* start_node,
                                          bint inclusive)
    cdef void END_FOR_EACH_ELEMENT_FROM(xmlNode* start_node)
    cdef void BEGIN_FOR_EACH_FROM(xmlNode* tree_top,
                                  xmlNode* start_node,
                                  bint inclusive)
    cdef void END_FOR_EACH_FROM(xmlNode* start_node)

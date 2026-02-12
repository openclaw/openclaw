/*
 * Summary: interfaces for tree manipulation
 * Description: this module describes the structures found in an tree resulting
 *              from an XML or HTML parsing, as well as the API provided for
 *              various processing on that tree
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef XML_TREE_INTERNALS

/*
 * Emulate circular dependency for backward compatibility
 */
#include <libxml/parser.h>

#else /* XML_TREE_INTERNALS */

#ifndef __XML_TREE_H__
#define __XML_TREE_H__

#include <stdio.h>
#include <limits.h>
#include <libxml/xmlversion.h>
#include <libxml/xmlstring.h>
#include <libxml/xmlmemory.h>
#include <libxml/xmlregexp.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Backward compatibility
 */
#define xmlBufferAllocScheme XML_BUFFER_ALLOC_EXACT
#define xmlDefaultBufferSize 4096

/*
 * Some of the basic types pointer to structures:
 */
/* xmlIO.h */
typedef struct _xmlParserInputBuffer xmlParserInputBuffer;
typedef xmlParserInputBuffer *xmlParserInputBufferPtr;

typedef struct _xmlOutputBuffer xmlOutputBuffer;
typedef xmlOutputBuffer *xmlOutputBufferPtr;

/* parser.h */
typedef struct _xmlParserInput xmlParserInput;
typedef xmlParserInput *xmlParserInputPtr;

typedef struct _xmlParserCtxt xmlParserCtxt;
typedef xmlParserCtxt *xmlParserCtxtPtr;

typedef struct _xmlSAXLocator xmlSAXLocator;
typedef xmlSAXLocator *xmlSAXLocatorPtr;

typedef struct _xmlSAXHandler xmlSAXHandler;
typedef xmlSAXHandler *xmlSAXHandlerPtr;

/* entities.h */
typedef struct _xmlEntity xmlEntity;
typedef xmlEntity *xmlEntityPtr;

/**
 * LIBXML_NAMESPACE_DICT:
 *
 * Defines experimental behaviour:
 * 1) xmlNs gets an additional field @context (a xmlDoc)
 * 2) when creating a tree, xmlNs->href is stored in the dict of xmlDoc.
 */
/* #define LIBXML_NAMESPACE_DICT */

/**
 * xmlBufferAllocationScheme:
 *
 * A buffer allocation scheme can be defined to either match exactly the
 * need or double it's allocated size each time it is found too small.
 */

typedef enum {
    XML_BUFFER_ALLOC_DOUBLEIT,	/* double each time one need to grow */
    XML_BUFFER_ALLOC_EXACT,	/* grow only to the minimal size */
    XML_BUFFER_ALLOC_IMMUTABLE, /* immutable buffer, deprecated */
    XML_BUFFER_ALLOC_IO,	/* special allocation scheme used for I/O */
    XML_BUFFER_ALLOC_HYBRID,	/* exact up to a threshold, and doubleit thereafter */
    XML_BUFFER_ALLOC_BOUNDED	/* limit the upper size of the buffer */
} xmlBufferAllocationScheme;

/**
 * xmlBuffer:
 *
 * A buffer structure, this old construct is limited to 2GB and
 * is being deprecated, use API with xmlBuf instead
 */
typedef struct _xmlBuffer xmlBuffer;
typedef xmlBuffer *xmlBufferPtr;
struct _xmlBuffer {
    /* The buffer content UTF8 */
    xmlChar *content XML_DEPRECATED_MEMBER;
    /* The buffer size used */
    unsigned int use XML_DEPRECATED_MEMBER;
    /* The buffer size */
    unsigned int size XML_DEPRECATED_MEMBER;
    /* The realloc method */
    xmlBufferAllocationScheme alloc XML_DEPRECATED_MEMBER;
    /* in IO mode we may have a different base */
    xmlChar *contentIO XML_DEPRECATED_MEMBER;
};

/**
 * xmlBuf:
 *
 * A buffer structure, new one, the actual structure internals are not public
 */

typedef struct _xmlBuf xmlBuf;

/**
 * xmlBufPtr:
 *
 * A pointer to a buffer structure, the actual structure internals are not
 * public
 */

typedef xmlBuf *xmlBufPtr;

/*
 * A few public routines for xmlBuf. As those are expected to be used
 * mostly internally the bulk of the routines are internal in buf.h
 */
XMLPUBFUN xmlChar*       xmlBufContent	(const xmlBuf* buf);
XMLPUBFUN xmlChar*       xmlBufEnd      (xmlBufPtr buf);
XMLPUBFUN size_t         xmlBufUse      (const xmlBufPtr buf);
XMLPUBFUN size_t         xmlBufShrink	(xmlBufPtr buf, size_t len);

/*
 * LIBXML2_NEW_BUFFER:
 *
 * Macro used to express that the API use the new buffers for
 * xmlParserInputBuffer and xmlOutputBuffer. The change was
 * introduced in 2.9.0.
 */
#define LIBXML2_NEW_BUFFER

/**
 * XML_XML_NAMESPACE:
 *
 * This is the namespace for the special xml: prefix predefined in the
 * XML Namespace specification.
 */
#define XML_XML_NAMESPACE \
    (const xmlChar *) "http://www.w3.org/XML/1998/namespace"

/**
 * XML_XML_ID:
 *
 * This is the name for the special xml:id attribute
 */
#define XML_XML_ID (const xmlChar *) "xml:id"

/*
 * The different element types carried by an XML tree.
 *
 * NOTE: This is synchronized with DOM Level1 values
 *       See http://www.w3.org/TR/REC-DOM-Level-1/
 *
 * Actually this had diverged a bit, and now XML_DOCUMENT_TYPE_NODE should
 * be deprecated to use an XML_DTD_NODE.
 */
typedef enum {
    XML_ELEMENT_NODE=		1,
    XML_ATTRIBUTE_NODE=		2,
    XML_TEXT_NODE=		3,
    XML_CDATA_SECTION_NODE=	4,
    XML_ENTITY_REF_NODE=	5,
    XML_ENTITY_NODE=		6,  /* unused */
    XML_PI_NODE=		7,
    XML_COMMENT_NODE=		8,
    XML_DOCUMENT_NODE=		9,
    XML_DOCUMENT_TYPE_NODE=	10, /* unused */
    XML_DOCUMENT_FRAG_NODE=	11,
    XML_NOTATION_NODE=		12, /* unused */
    XML_HTML_DOCUMENT_NODE=	13,
    XML_DTD_NODE=		14,
    XML_ELEMENT_DECL=		15,
    XML_ATTRIBUTE_DECL=		16,
    XML_ENTITY_DECL=		17,
    XML_NAMESPACE_DECL=		18,
    XML_XINCLUDE_START=		19,
    XML_XINCLUDE_END=		20
    /* XML_DOCB_DOCUMENT_NODE=	21 */ /* removed */
} xmlElementType;

/** DOC_DISABLE */
/* For backward compatibility */
#define XML_DOCB_DOCUMENT_NODE 21
/** DOC_ENABLE */

/**
 * xmlNotation:
 *
 * A DTD Notation definition.
 */

typedef struct _xmlNotation xmlNotation;
typedef xmlNotation *xmlNotationPtr;
struct _xmlNotation {
    const xmlChar               *name;	        /* Notation name */
    const xmlChar               *PublicID;	/* Public identifier, if any */
    const xmlChar               *SystemID;	/* System identifier, if any */
};

/**
 * xmlAttributeType:
 *
 * A DTD Attribute type definition.
 */

typedef enum {
    XML_ATTRIBUTE_CDATA = 1,
    XML_ATTRIBUTE_ID,
    XML_ATTRIBUTE_IDREF	,
    XML_ATTRIBUTE_IDREFS,
    XML_ATTRIBUTE_ENTITY,
    XML_ATTRIBUTE_ENTITIES,
    XML_ATTRIBUTE_NMTOKEN,
    XML_ATTRIBUTE_NMTOKENS,
    XML_ATTRIBUTE_ENUMERATION,
    XML_ATTRIBUTE_NOTATION
} xmlAttributeType;

/**
 * xmlAttributeDefault:
 *
 * A DTD Attribute default definition.
 */

typedef enum {
    XML_ATTRIBUTE_NONE = 1,
    XML_ATTRIBUTE_REQUIRED,
    XML_ATTRIBUTE_IMPLIED,
    XML_ATTRIBUTE_FIXED
} xmlAttributeDefault;

/**
 * xmlEnumeration:
 *
 * List structure used when there is an enumeration in DTDs.
 */

typedef struct _xmlEnumeration xmlEnumeration;
typedef xmlEnumeration *xmlEnumerationPtr;
struct _xmlEnumeration {
    struct _xmlEnumeration    *next;	/* next one */
    const xmlChar            *name;	/* Enumeration name */
};

/**
 * xmlAttribute:
 *
 * An Attribute declaration in a DTD.
 */

typedef struct _xmlAttribute xmlAttribute;
typedef xmlAttribute *xmlAttributePtr;
struct _xmlAttribute {
    void           *_private;	        /* application data */
    xmlElementType          type;       /* XML_ATTRIBUTE_DECL, must be second ! */
    const xmlChar          *name;	/* Attribute name */
    struct _xmlNode    *children;	/* NULL */
    struct _xmlNode        *last;	/* NULL */
    struct _xmlDtd       *parent;	/* -> DTD */
    struct _xmlNode        *next;	/* next sibling link  */
    struct _xmlNode        *prev;	/* previous sibling link  */
    struct _xmlDoc          *doc;       /* the containing document */

    struct _xmlAttribute  *nexth;	/* next in hash table */
    xmlAttributeType       atype;	/* The attribute type */
    xmlAttributeDefault      def;	/* the default */
    const xmlChar  *defaultValue;	/* or the default value */
    xmlEnumerationPtr       tree;       /* or the enumeration tree if any */
    const xmlChar        *prefix;	/* the namespace prefix if any */
    const xmlChar          *elem;	/* Element holding the attribute */
};

/**
 * xmlElementContentType:
 *
 * Possible definitions of element content types.
 */
typedef enum {
    XML_ELEMENT_CONTENT_PCDATA = 1,
    XML_ELEMENT_CONTENT_ELEMENT,
    XML_ELEMENT_CONTENT_SEQ,
    XML_ELEMENT_CONTENT_OR
} xmlElementContentType;

/**
 * xmlElementContentOccur:
 *
 * Possible definitions of element content occurrences.
 */
typedef enum {
    XML_ELEMENT_CONTENT_ONCE = 1,
    XML_ELEMENT_CONTENT_OPT,
    XML_ELEMENT_CONTENT_MULT,
    XML_ELEMENT_CONTENT_PLUS
} xmlElementContentOccur;

/**
 * xmlElementContent:
 *
 * An XML Element content as stored after parsing an element definition
 * in a DTD.
 */

typedef struct _xmlElementContent xmlElementContent;
typedef xmlElementContent *xmlElementContentPtr;
struct _xmlElementContent {
    xmlElementContentType     type;	/* PCDATA, ELEMENT, SEQ or OR */
    xmlElementContentOccur    ocur;	/* ONCE, OPT, MULT or PLUS */
    const xmlChar             *name;	/* Element name */
    struct _xmlElementContent *c1;	/* first child */
    struct _xmlElementContent *c2;	/* second child */
    struct _xmlElementContent *parent;	/* parent */
    const xmlChar             *prefix;	/* Namespace prefix */
};

/**
 * xmlElementTypeVal:
 *
 * The different possibilities for an element content type.
 */

typedef enum {
    XML_ELEMENT_TYPE_UNDEFINED = 0,
    XML_ELEMENT_TYPE_EMPTY = 1,
    XML_ELEMENT_TYPE_ANY,
    XML_ELEMENT_TYPE_MIXED,
    XML_ELEMENT_TYPE_ELEMENT
} xmlElementTypeVal;

/**
 * xmlElement:
 *
 * An XML Element declaration from a DTD.
 */

typedef struct _xmlElement xmlElement;
typedef xmlElement *xmlElementPtr;
struct _xmlElement {
    void           *_private;	        /* application data */
    xmlElementType          type;       /* XML_ELEMENT_DECL, must be second ! */
    const xmlChar          *name;	/* Element name */
    struct _xmlNode    *children;	/* NULL */
    struct _xmlNode        *last;	/* NULL */
    struct _xmlDtd       *parent;	/* -> DTD */
    struct _xmlNode        *next;	/* next sibling link  */
    struct _xmlNode        *prev;	/* previous sibling link  */
    struct _xmlDoc          *doc;       /* the containing document */

    xmlElementTypeVal      etype;	/* The type */
    xmlElementContentPtr content;	/* the allowed element content */
    xmlAttributePtr   attributes;	/* List of the declared attributes */
    const xmlChar        *prefix;	/* the namespace prefix if any */
#ifdef LIBXML_REGEXP_ENABLED
    xmlRegexpPtr       contModel;	/* the validating regexp */
#else
    void	      *contModel;
#endif
};


/**
 * XML_LOCAL_NAMESPACE:
 *
 * A namespace declaration node.
 */
#define XML_LOCAL_NAMESPACE XML_NAMESPACE_DECL
typedef xmlElementType xmlNsType;

/**
 * xmlNs:
 *
 * An XML namespace.
 * Note that prefix == NULL is valid, it defines the default namespace
 * within the subtree (until overridden).
 *
 * xmlNsType is unified with xmlElementType.
 */

typedef struct _xmlNs xmlNs;
typedef xmlNs *xmlNsPtr;
struct _xmlNs {
    struct _xmlNs  *next;	/* next Ns link for this node  */
    xmlNsType      type;	/* global or local */
    const xmlChar *href;	/* URL for the namespace */
    const xmlChar *prefix;	/* prefix for the namespace */
    void           *_private;   /* application data */
    struct _xmlDoc *context;		/* normally an xmlDoc */
};

/**
 * xmlDtd:
 *
 * An XML DTD, as defined by <!DOCTYPE ... There is actually one for
 * the internal subset and for the external subset.
 */
typedef struct _xmlDtd xmlDtd;
typedef xmlDtd *xmlDtdPtr;
struct _xmlDtd {
    void           *_private;	/* application data */
    xmlElementType  type;       /* XML_DTD_NODE, must be second ! */
    const xmlChar *name;	/* Name of the DTD */
    struct _xmlNode *children;	/* the value of the property link */
    struct _xmlNode *last;	/* last child link */
    struct _xmlDoc  *parent;	/* child->parent link */
    struct _xmlNode *next;	/* next sibling link  */
    struct _xmlNode *prev;	/* previous sibling link  */
    struct _xmlDoc  *doc;	/* the containing document */

    /* End of common part */
    void          *notations;   /* Hash table for notations if any */
    void          *elements;    /* Hash table for elements if any */
    void          *attributes;  /* Hash table for attributes if any */
    void          *entities;    /* Hash table for entities if any */
    const xmlChar *ExternalID;	/* External identifier for PUBLIC DTD */
    const xmlChar *SystemID;	/* URI for a SYSTEM or PUBLIC DTD */
    void          *pentities;   /* Hash table for param entities if any */
};

/**
 * xmlAttr:
 *
 * An attribute on an XML node.
 */
typedef struct _xmlAttr xmlAttr;
typedef xmlAttr *xmlAttrPtr;
struct _xmlAttr {
    void           *_private;	/* application data */
    xmlElementType   type;      /* XML_ATTRIBUTE_NODE, must be second ! */
    const xmlChar   *name;      /* the name of the property */
    struct _xmlNode *children;	/* the value of the property */
    struct _xmlNode *last;	/* NULL */
    struct _xmlNode *parent;	/* child->parent link */
    struct _xmlAttr *next;	/* next sibling link  */
    struct _xmlAttr *prev;	/* previous sibling link  */
    struct _xmlDoc  *doc;	/* the containing document */
    xmlNs           *ns;        /* pointer to the associated namespace */
    xmlAttributeType atype;     /* the attribute type if validating */
    void            *psvi;	/* for type/PSVI information */
    struct _xmlID   *id;        /* the ID struct */
};

/**
 * xmlID:
 *
 * An XML ID instance.
 */

typedef struct _xmlID xmlID;
typedef xmlID *xmlIDPtr;
struct _xmlID {
    struct _xmlID    *next;	/* next ID */
    const xmlChar    *value;	/* The ID name */
    xmlAttrPtr        attr;	/* The attribute holding it */
    const xmlChar    *name;	/* The attribute if attr is not available */
    int               lineno;	/* The line number if attr is not available */
    struct _xmlDoc   *doc;	/* The document holding the ID */
};

/**
 * xmlRef:
 *
 * An XML IDREF instance.
 */

typedef struct _xmlRef xmlRef;
typedef xmlRef *xmlRefPtr;
struct _xmlRef {
    struct _xmlRef    *next;	/* next Ref */
    const xmlChar     *value;	/* The Ref name */
    xmlAttrPtr        attr;	/* The attribute holding it */
    const xmlChar    *name;	/* The attribute if attr is not available */
    int               lineno;	/* The line number if attr is not available */
};

/**
 * xmlNode:
 *
 * A node in an XML tree.
 */
typedef struct _xmlNode xmlNode;
typedef xmlNode *xmlNodePtr;
struct _xmlNode {
    void           *_private;	/* application data */
    xmlElementType   type;	/* type number, must be second ! */
    const xmlChar   *name;      /* the name of the node, or the entity */
    struct _xmlNode *children;	/* parent->childs link */
    struct _xmlNode *last;	/* last child link */
    struct _xmlNode *parent;	/* child->parent link */
    struct _xmlNode *next;	/* next sibling link  */
    struct _xmlNode *prev;	/* previous sibling link  */
    struct _xmlDoc  *doc;	/* the containing document */

    /* End of common part */
    xmlNs           *ns;        /* pointer to the associated namespace */
    xmlChar         *content;   /* the content */
    struct _xmlAttr *properties;/* properties list */
    xmlNs           *nsDef;     /* namespace definitions on this node */
    void            *psvi;	/* for type/PSVI information */
    unsigned short   line;	/* line number */
    unsigned short   extra;	/* extra data for XPath/XSLT */
};

/**
 * XML_GET_CONTENT:
 *
 * Macro to extract the content pointer of a node.
 */
#define XML_GET_CONTENT(n)					\
    ((n)->type == XML_ELEMENT_NODE ? NULL : (n)->content)

/**
 * XML_GET_LINE:
 *
 * Macro to extract the line number of an element node.
 */
#define XML_GET_LINE(n)						\
    (xmlGetLineNo(n))

/**
 * xmlDocProperty
 *
 * Set of properties of the document as found by the parser
 * Some of them are linked to similarly named xmlParserOption
 */
typedef enum {
    XML_DOC_WELLFORMED		= 1<<0, /* document is XML well formed */
    XML_DOC_NSVALID		= 1<<1, /* document is Namespace valid */
    XML_DOC_OLD10		= 1<<2, /* parsed with old XML-1.0 parser */
    XML_DOC_DTDVALID		= 1<<3, /* DTD validation was successful */
    XML_DOC_XINCLUDE		= 1<<4, /* XInclude substitution was done */
    XML_DOC_USERBUILT		= 1<<5, /* Document was built using the API
                                           and not by parsing an instance */
    XML_DOC_INTERNAL		= 1<<6, /* built for internal processing */
    XML_DOC_HTML		= 1<<7  /* parsed or built HTML document */
} xmlDocProperties;

/**
 * xmlDoc:
 *
 * An XML document.
 */
typedef struct _xmlDoc xmlDoc;
typedef xmlDoc *xmlDocPtr;
struct _xmlDoc {
    void           *_private;	/* application data */
    xmlElementType  type;       /* XML_DOCUMENT_NODE, must be second ! */
    char           *name;	/* name/filename/URI of the document */
    struct _xmlNode *children;	/* the document tree */
    struct _xmlNode *last;	/* last child link */
    struct _xmlNode *parent;	/* child->parent link */
    struct _xmlNode *next;	/* next sibling link  */
    struct _xmlNode *prev;	/* previous sibling link  */
    struct _xmlDoc  *doc;	/* autoreference to itself */

    /* End of common part */
    int             compression;/* level of zlib compression */
    int             standalone; /* standalone document (no external refs)
				     1 if standalone="yes"
				     0 if standalone="no"
				    -1 if there is no XML declaration
				    -2 if there is an XML declaration, but no
					standalone attribute was specified */
    struct _xmlDtd  *intSubset;	/* the document internal subset */
    struct _xmlDtd  *extSubset;	/* the document external subset */
    struct _xmlNs   *oldNs;	/* Global namespace, the old way */
    const xmlChar  *version;	/* the XML version string */
    const xmlChar  *encoding;   /* actual encoding, if any */
    void           *ids;        /* Hash table for ID attributes if any */
    void           *refs;       /* Hash table for IDREFs attributes if any */
    const xmlChar  *URL;	/* The URI for that document */
    int             charset;    /* unused */
    struct _xmlDict *dict;      /* dict used to allocate names or NULL */
    void           *psvi;	/* for type/PSVI information */
    int             parseFlags;	/* set of xmlParserOption used to parse the
				   document */
    int             properties;	/* set of xmlDocProperties for this document
				   set at the end of parsing */
};


typedef struct _xmlDOMWrapCtxt xmlDOMWrapCtxt;
typedef xmlDOMWrapCtxt *xmlDOMWrapCtxtPtr;

/**
 * xmlDOMWrapAcquireNsFunction:
 * @ctxt:  a DOM wrapper context
 * @node:  the context node (element or attribute)
 * @nsName:  the requested namespace name
 * @nsPrefix:  the requested namespace prefix
 *
 * A function called to acquire namespaces (xmlNs) from the wrapper.
 *
 * Returns an xmlNsPtr or NULL in case of an error.
 */
typedef xmlNsPtr (*xmlDOMWrapAcquireNsFunction) (xmlDOMWrapCtxtPtr ctxt,
						 xmlNodePtr node,
						 const xmlChar *nsName,
						 const xmlChar *nsPrefix);

/**
 * xmlDOMWrapCtxt:
 *
 * Context for DOM wrapper-operations.
 */
struct _xmlDOMWrapCtxt {
    void * _private;
    /*
    * The type of this context, just in case we need specialized
    * contexts in the future.
    */
    int type;
    /*
    * Internal namespace map used for various operations.
    */
    void * namespaceMap;
    /*
    * Use this one to acquire an xmlNsPtr intended for node->ns.
    * (Note that this is not intended for elem->nsDef).
    */
    xmlDOMWrapAcquireNsFunction getNsForNodeFunc;
};

/**
 * xmlRegisterNodeFunc:
 * @node: the current node
 *
 * Signature for the registration callback of a created node
 */
typedef void (*xmlRegisterNodeFunc) (xmlNodePtr node);

/**
 * xmlDeregisterNodeFunc:
 * @node: the current node
 *
 * Signature for the deregistration callback of a discarded node
 */
typedef void (*xmlDeregisterNodeFunc) (xmlNodePtr node);

/**
 * xmlChildrenNode:
 *
 * Macro for compatibility naming layer with libxml1. Maps
 * to "children."
 */
#ifndef xmlChildrenNode
#define xmlChildrenNode children
#endif

/**
 * xmlRootNode:
 *
 * Macro for compatibility naming layer with libxml1. Maps
 * to "children".
 */
#ifndef xmlRootNode
#define xmlRootNode children
#endif

/*
 * Variables.
 */

/** DOC_DISABLE */
XML_DEPRECATED
XMLPUBFUN xmlRegisterNodeFunc *__xmlRegisterNodeDefaultValue(void);
XML_DEPRECATED
XMLPUBFUN xmlDeregisterNodeFunc *__xmlDeregisterNodeDefaultValue(void);

#ifndef XML_GLOBALS_NO_REDEFINITION
  #define xmlRegisterNodeDefaultValue \
    (*__xmlRegisterNodeDefaultValue())
  #define xmlDeregisterNodeDefaultValue \
    (*__xmlDeregisterNodeDefaultValue())
#endif
/** DOC_ENABLE */

/*
 * Some helper functions
 */
XMLPUBFUN int
		xmlValidateNCName	(const xmlChar *value,
					 int space);

XMLPUBFUN int
		xmlValidateQName	(const xmlChar *value,
					 int space);
XMLPUBFUN int
		xmlValidateName		(const xmlChar *value,
					 int space);
XMLPUBFUN int
		xmlValidateNMToken	(const xmlChar *value,
					 int space);

XMLPUBFUN xmlChar *
		xmlBuildQName		(const xmlChar *ncname,
					 const xmlChar *prefix,
					 xmlChar *memory,
					 int len);
XMLPUBFUN xmlChar *
		xmlSplitQName2		(const xmlChar *name,
					 xmlChar **prefix);
XMLPUBFUN const xmlChar *
		xmlSplitQName3		(const xmlChar *name,
					 int *len);

/*
 * Handling Buffers, the old ones see @xmlBuf for the new ones.
 */

XML_DEPRECATED
XMLPUBFUN void
		xmlSetBufferAllocationScheme(xmlBufferAllocationScheme scheme);
XML_DEPRECATED
XMLPUBFUN xmlBufferAllocationScheme
		xmlGetBufferAllocationScheme(void);

XMLPUBFUN xmlBufferPtr
		xmlBufferCreate		(void);
XMLPUBFUN xmlBufferPtr
		xmlBufferCreateSize	(size_t size);
XMLPUBFUN xmlBufferPtr
		xmlBufferCreateStatic	(void *mem,
					 size_t size);
XML_DEPRECATED
XMLPUBFUN int
		xmlBufferResize		(xmlBufferPtr buf,
					 unsigned int size);
XMLPUBFUN void
		xmlBufferFree		(xmlBufferPtr buf);
XMLPUBFUN int
		xmlBufferDump		(FILE *file,
					 xmlBufferPtr buf);
XMLPUBFUN int
		xmlBufferAdd		(xmlBufferPtr buf,
					 const xmlChar *str,
					 int len);
XMLPUBFUN int
		xmlBufferAddHead	(xmlBufferPtr buf,
					 const xmlChar *str,
					 int len);
XMLPUBFUN int
		xmlBufferCat		(xmlBufferPtr buf,
					 const xmlChar *str);
XMLPUBFUN int
		xmlBufferCCat		(xmlBufferPtr buf,
					 const char *str);
XML_DEPRECATED
XMLPUBFUN int
		xmlBufferShrink		(xmlBufferPtr buf,
					 unsigned int len);
XML_DEPRECATED
XMLPUBFUN int
		xmlBufferGrow		(xmlBufferPtr buf,
					 unsigned int len);
XMLPUBFUN void
		xmlBufferEmpty		(xmlBufferPtr buf);
XMLPUBFUN const xmlChar*
		xmlBufferContent	(const xmlBuffer *buf);
XMLPUBFUN xmlChar*
		xmlBufferDetach         (xmlBufferPtr buf);
XMLPUBFUN void
		xmlBufferSetAllocationScheme(xmlBufferPtr buf,
					 xmlBufferAllocationScheme scheme);
XMLPUBFUN int
		xmlBufferLength		(const xmlBuffer *buf);

/*
 * Creating/freeing new structures.
 */
XMLPUBFUN xmlDtdPtr
		xmlCreateIntSubset	(xmlDocPtr doc,
					 const xmlChar *name,
					 const xmlChar *ExternalID,
					 const xmlChar *SystemID);
XMLPUBFUN xmlDtdPtr
		xmlNewDtd		(xmlDocPtr doc,
					 const xmlChar *name,
					 const xmlChar *ExternalID,
					 const xmlChar *SystemID);
XMLPUBFUN xmlDtdPtr
		xmlGetIntSubset		(const xmlDoc *doc);
XMLPUBFUN void
		xmlFreeDtd		(xmlDtdPtr cur);
XMLPUBFUN xmlNsPtr
		xmlNewNs		(xmlNodePtr node,
					 const xmlChar *href,
					 const xmlChar *prefix);
XMLPUBFUN void
		xmlFreeNs		(xmlNsPtr cur);
XMLPUBFUN void
		xmlFreeNsList		(xmlNsPtr cur);
XMLPUBFUN xmlDocPtr
		xmlNewDoc		(const xmlChar *version);
XMLPUBFUN void
		xmlFreeDoc		(xmlDocPtr cur);
XMLPUBFUN xmlAttrPtr
		xmlNewDocProp		(xmlDocPtr doc,
					 const xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN xmlAttrPtr
		xmlNewProp		(xmlNodePtr node,
					 const xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN xmlAttrPtr
		xmlNewNsProp		(xmlNodePtr node,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN xmlAttrPtr
		xmlNewNsPropEatName	(xmlNodePtr node,
					 xmlNsPtr ns,
					 xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN void
		xmlFreePropList		(xmlAttrPtr cur);
XMLPUBFUN void
		xmlFreeProp		(xmlAttrPtr cur);
XMLPUBFUN xmlAttrPtr
		xmlCopyProp		(xmlNodePtr target,
					 xmlAttrPtr cur);
XMLPUBFUN xmlAttrPtr
		xmlCopyPropList		(xmlNodePtr target,
					 xmlAttrPtr cur);
XMLPUBFUN xmlDtdPtr
		xmlCopyDtd		(xmlDtdPtr dtd);
XMLPUBFUN xmlDocPtr
		xmlCopyDoc		(xmlDocPtr doc,
					 int recursive);
/*
 * Creating new nodes.
 */
XMLPUBFUN xmlNodePtr
		xmlNewDocNode		(xmlDocPtr doc,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocNodeEatName	(xmlDocPtr doc,
					 xmlNsPtr ns,
					 xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewNode		(xmlNsPtr ns,
					 const xmlChar *name);
XMLPUBFUN xmlNodePtr
		xmlNewNodeEatName	(xmlNsPtr ns,
					 xmlChar *name);
XMLPUBFUN xmlNodePtr
		xmlNewChild		(xmlNodePtr parent,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocText		(const xmlDoc *doc,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewText		(const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocPI		(xmlDocPtr doc,
					 const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewPI		(const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocTextLen	(xmlDocPtr doc,
					 const xmlChar *content,
					 int len);
XMLPUBFUN xmlNodePtr
		xmlNewTextLen		(const xmlChar *content,
					 int len);
XMLPUBFUN xmlNodePtr
		xmlNewDocComment	(xmlDocPtr doc,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewComment		(const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewCDataBlock	(xmlDocPtr doc,
					 const xmlChar *content,
					 int len);
XMLPUBFUN xmlNodePtr
		xmlNewCharRef		(xmlDocPtr doc,
					 const xmlChar *name);
XMLPUBFUN xmlNodePtr
		xmlNewReference		(const xmlDoc *doc,
					 const xmlChar *name);
XMLPUBFUN xmlNodePtr
		xmlCopyNode		(xmlNodePtr node,
					 int recursive);
XMLPUBFUN xmlNodePtr
		xmlDocCopyNode		(xmlNodePtr node,
					 xmlDocPtr doc,
					 int recursive);
XMLPUBFUN xmlNodePtr
		xmlDocCopyNodeList	(xmlDocPtr doc,
					 xmlNodePtr node);
XMLPUBFUN xmlNodePtr
		xmlCopyNodeList		(xmlNodePtr node);
XMLPUBFUN xmlNodePtr
		xmlNewTextChild		(xmlNodePtr parent,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocRawNode	(xmlDocPtr doc,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *content);
XMLPUBFUN xmlNodePtr
		xmlNewDocFragment	(xmlDocPtr doc);

/*
 * Navigating.
 */
XMLPUBFUN long
		xmlGetLineNo		(const xmlNode *node);
XMLPUBFUN xmlChar *
		xmlGetNodePath		(const xmlNode *node);
XMLPUBFUN xmlNodePtr
		xmlDocGetRootElement	(const xmlDoc *doc);
XMLPUBFUN xmlNodePtr
		xmlGetLastChild		(const xmlNode *parent);
XMLPUBFUN int
		xmlNodeIsText		(const xmlNode *node);
XMLPUBFUN int
		xmlIsBlankNode		(const xmlNode *node);

/*
 * Changing the structure.
 */
XMLPUBFUN xmlNodePtr
		xmlDocSetRootElement	(xmlDocPtr doc,
					 xmlNodePtr root);
XMLPUBFUN void
		xmlNodeSetName		(xmlNodePtr cur,
					 const xmlChar *name);
XMLPUBFUN xmlNodePtr
		xmlAddChild		(xmlNodePtr parent,
					 xmlNodePtr cur);
XMLPUBFUN xmlNodePtr
		xmlAddChildList		(xmlNodePtr parent,
					 xmlNodePtr cur);
XMLPUBFUN xmlNodePtr
		xmlReplaceNode		(xmlNodePtr old,
					 xmlNodePtr cur);
XMLPUBFUN xmlNodePtr
		xmlAddPrevSibling	(xmlNodePtr cur,
					 xmlNodePtr elem);
XMLPUBFUN xmlNodePtr
		xmlAddSibling		(xmlNodePtr cur,
					 xmlNodePtr elem);
XMLPUBFUN xmlNodePtr
		xmlAddNextSibling	(xmlNodePtr cur,
					 xmlNodePtr elem);
XMLPUBFUN void
		xmlUnlinkNode		(xmlNodePtr cur);
XMLPUBFUN xmlNodePtr
		xmlTextMerge		(xmlNodePtr first,
					 xmlNodePtr second);
XMLPUBFUN int
		xmlTextConcat		(xmlNodePtr node,
					 const xmlChar *content,
					 int len);
XMLPUBFUN void
		xmlFreeNodeList		(xmlNodePtr cur);
XMLPUBFUN void
		xmlFreeNode		(xmlNodePtr cur);
XMLPUBFUN int
		xmlSetTreeDoc		(xmlNodePtr tree,
					 xmlDocPtr doc);
XMLPUBFUN int
		xmlSetListDoc		(xmlNodePtr list,
					 xmlDocPtr doc);
/*
 * Namespaces.
 */
XMLPUBFUN xmlNsPtr
		xmlSearchNs		(xmlDocPtr doc,
					 xmlNodePtr node,
					 const xmlChar *nameSpace);
XMLPUBFUN xmlNsPtr
		xmlSearchNsByHref	(xmlDocPtr doc,
					 xmlNodePtr node,
					 const xmlChar *href);
XMLPUBFUN int
		xmlGetNsListSafe	(const xmlDoc *doc,
					 const xmlNode *node,
					 xmlNsPtr **out);
XMLPUBFUN xmlNsPtr *
		xmlGetNsList		(const xmlDoc *doc,
					 const xmlNode *node);

XMLPUBFUN void
		xmlSetNs		(xmlNodePtr node,
					 xmlNsPtr ns);
XMLPUBFUN xmlNsPtr
		xmlCopyNamespace	(xmlNsPtr cur);
XMLPUBFUN xmlNsPtr
		xmlCopyNamespaceList	(xmlNsPtr cur);

/*
 * Changing the content.
 */
XMLPUBFUN xmlAttrPtr
		xmlSetProp		(xmlNodePtr node,
					 const xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN xmlAttrPtr
		xmlSetNsProp		(xmlNodePtr node,
					 xmlNsPtr ns,
					 const xmlChar *name,
					 const xmlChar *value);
XMLPUBFUN int
		xmlNodeGetAttrValue	(const xmlNode *node,
					 const xmlChar *name,
					 const xmlChar *nsUri,
					 xmlChar **out);
XMLPUBFUN xmlChar *
		xmlGetNoNsProp		(const xmlNode *node,
					 const xmlChar *name);
XMLPUBFUN xmlChar *
		xmlGetProp		(const xmlNode *node,
					 const xmlChar *name);
XMLPUBFUN xmlAttrPtr
		xmlHasProp		(const xmlNode *node,
					 const xmlChar *name);
XMLPUBFUN xmlAttrPtr
		xmlHasNsProp		(const xmlNode *node,
					 const xmlChar *name,
					 const xmlChar *nameSpace);
XMLPUBFUN xmlChar *
		xmlGetNsProp		(const xmlNode *node,
					 const xmlChar *name,
					 const xmlChar *nameSpace);
XMLPUBFUN xmlNodePtr
		xmlStringGetNodeList	(const xmlDoc *doc,
					 const xmlChar *value);
XMLPUBFUN xmlNodePtr
		xmlStringLenGetNodeList	(const xmlDoc *doc,
					 const xmlChar *value,
					 int len);
XMLPUBFUN xmlChar *
		xmlNodeListGetString	(xmlDocPtr doc,
					 const xmlNode *list,
					 int inLine);
XMLPUBFUN xmlChar *
		xmlNodeListGetRawString	(const xmlDoc *doc,
					 const xmlNode *list,
					 int inLine);
XMLPUBFUN int
		xmlNodeSetContent	(xmlNodePtr cur,
					 const xmlChar *content);
XMLPUBFUN int
		xmlNodeSetContentLen	(xmlNodePtr cur,
					 const xmlChar *content,
					 int len);
XMLPUBFUN int
		xmlNodeAddContent	(xmlNodePtr cur,
					 const xmlChar *content);
XMLPUBFUN int
		xmlNodeAddContentLen	(xmlNodePtr cur,
					 const xmlChar *content,
					 int len);
XMLPUBFUN xmlChar *
		xmlNodeGetContent	(const xmlNode *cur);

XMLPUBFUN int
		xmlNodeBufGetContent	(xmlBufferPtr buffer,
					 const xmlNode *cur);
XMLPUBFUN int
		xmlBufGetNodeContent	(xmlBufPtr buf,
					 const xmlNode *cur);

XMLPUBFUN xmlChar *
		xmlNodeGetLang		(const xmlNode *cur);
XMLPUBFUN int
		xmlNodeGetSpacePreserve	(const xmlNode *cur);
XMLPUBFUN int
		xmlNodeSetLang		(xmlNodePtr cur,
					 const xmlChar *lang);
XMLPUBFUN int
		xmlNodeSetSpacePreserve (xmlNodePtr cur,
					 int val);
XMLPUBFUN int
		xmlNodeGetBaseSafe	(const xmlDoc *doc,
					 const xmlNode *cur,
					 xmlChar **baseOut);
XMLPUBFUN xmlChar *
		xmlNodeGetBase		(const xmlDoc *doc,
					 const xmlNode *cur);
XMLPUBFUN int
		xmlNodeSetBase		(xmlNodePtr cur,
					 const xmlChar *uri);

/*
 * Removing content.
 */
XMLPUBFUN int
		xmlRemoveProp		(xmlAttrPtr cur);
XMLPUBFUN int
		xmlUnsetNsProp		(xmlNodePtr node,
					 xmlNsPtr ns,
					 const xmlChar *name);
XMLPUBFUN int
		xmlUnsetProp		(xmlNodePtr node,
					 const xmlChar *name);

/*
 * Internal, don't use.
 */
XMLPUBFUN void
		xmlBufferWriteCHAR	(xmlBufferPtr buf,
					 const xmlChar *string);
XMLPUBFUN void
		xmlBufferWriteChar	(xmlBufferPtr buf,
					 const char *string);
XMLPUBFUN void
		xmlBufferWriteQuotedString(xmlBufferPtr buf,
					 const xmlChar *string);

#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void xmlAttrSerializeTxtContent(xmlBufferPtr buf,
					 xmlDocPtr doc,
					 xmlAttrPtr attr,
					 const xmlChar *string);
#endif /* LIBXML_OUTPUT_ENABLED */

/*
 * Namespace handling.
 */
XMLPUBFUN int
		xmlReconciliateNs	(xmlDocPtr doc,
					 xmlNodePtr tree);

#ifdef LIBXML_OUTPUT_ENABLED
/*
 * Saving.
 */
XMLPUBFUN void
		xmlDocDumpFormatMemory	(xmlDocPtr cur,
					 xmlChar **mem,
					 int *size,
					 int format);
XMLPUBFUN void
		xmlDocDumpMemory	(xmlDocPtr cur,
					 xmlChar **mem,
					 int *size);
XMLPUBFUN void
		xmlDocDumpMemoryEnc	(xmlDocPtr out_doc,
					 xmlChar **doc_txt_ptr,
					 int * doc_txt_len,
					 const char *txt_encoding);
XMLPUBFUN void
		xmlDocDumpFormatMemoryEnc(xmlDocPtr out_doc,
					 xmlChar **doc_txt_ptr,
					 int * doc_txt_len,
					 const char *txt_encoding,
					 int format);
XMLPUBFUN int
		xmlDocFormatDump	(FILE *f,
					 xmlDocPtr cur,
					 int format);
XMLPUBFUN int
		xmlDocDump		(FILE *f,
					 xmlDocPtr cur);
XMLPUBFUN void
		xmlElemDump		(FILE *f,
					 xmlDocPtr doc,
					 xmlNodePtr cur);
XMLPUBFUN int
		xmlSaveFile		(const char *filename,
					 xmlDocPtr cur);
XMLPUBFUN int
		xmlSaveFormatFile	(const char *filename,
					 xmlDocPtr cur,
					 int format);
XMLPUBFUN size_t
		xmlBufNodeDump		(xmlBufPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 int level,
					 int format);
XMLPUBFUN int
		xmlNodeDump		(xmlBufferPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 int level,
					 int format);

XMLPUBFUN int
		xmlSaveFileTo		(xmlOutputBufferPtr buf,
					 xmlDocPtr cur,
					 const char *encoding);
XMLPUBFUN int
		xmlSaveFormatFileTo     (xmlOutputBufferPtr buf,
					 xmlDocPtr cur,
				         const char *encoding,
				         int format);
XMLPUBFUN void
		xmlNodeDumpOutput	(xmlOutputBufferPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 int level,
					 int format,
					 const char *encoding);

XMLPUBFUN int
		xmlSaveFormatFileEnc    (const char *filename,
					 xmlDocPtr cur,
					 const char *encoding,
					 int format);

XMLPUBFUN int
		xmlSaveFileEnc		(const char *filename,
					 xmlDocPtr cur,
					 const char *encoding);

#endif /* LIBXML_OUTPUT_ENABLED */
/*
 * XHTML
 */
XMLPUBFUN int
		xmlIsXHTML		(const xmlChar *systemID,
					 const xmlChar *publicID);

/*
 * Compression.
 */
XMLPUBFUN int
		xmlGetDocCompressMode	(const xmlDoc *doc);
XMLPUBFUN void
		xmlSetDocCompressMode	(xmlDocPtr doc,
					 int mode);
XML_DEPRECATED
XMLPUBFUN int
		xmlGetCompressMode	(void);
XML_DEPRECATED
XMLPUBFUN void
		xmlSetCompressMode	(int mode);

/*
* DOM-wrapper helper functions.
*/
XMLPUBFUN xmlDOMWrapCtxtPtr
		xmlDOMWrapNewCtxt	(void);
XMLPUBFUN void
		xmlDOMWrapFreeCtxt	(xmlDOMWrapCtxtPtr ctxt);
XMLPUBFUN int
	    xmlDOMWrapReconcileNamespaces(xmlDOMWrapCtxtPtr ctxt,
					 xmlNodePtr elem,
					 int options);
XMLPUBFUN int
	    xmlDOMWrapAdoptNode		(xmlDOMWrapCtxtPtr ctxt,
					 xmlDocPtr sourceDoc,
					 xmlNodePtr node,
					 xmlDocPtr destDoc,
					 xmlNodePtr destParent,
					 int options);
XMLPUBFUN int
	    xmlDOMWrapRemoveNode	(xmlDOMWrapCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr node,
					 int options);
XMLPUBFUN int
	    xmlDOMWrapCloneNode		(xmlDOMWrapCtxtPtr ctxt,
					 xmlDocPtr sourceDoc,
					 xmlNodePtr node,
					 xmlNodePtr *clonedNode,
					 xmlDocPtr destDoc,
					 xmlNodePtr destParent,
					 int deep,
					 int options);

/*
 * 5 interfaces from DOM ElementTraversal, but different in entities
 * traversal.
 */
XMLPUBFUN unsigned long
            xmlChildElementCount        (xmlNodePtr parent);
XMLPUBFUN xmlNodePtr
            xmlNextElementSibling       (xmlNodePtr node);
XMLPUBFUN xmlNodePtr
            xmlFirstElementChild        (xmlNodePtr parent);
XMLPUBFUN xmlNodePtr
            xmlLastElementChild         (xmlNodePtr parent);
XMLPUBFUN xmlNodePtr
            xmlPreviousElementSibling   (xmlNodePtr node);

XML_DEPRECATED
XMLPUBFUN xmlRegisterNodeFunc
	    xmlRegisterNodeDefault	(xmlRegisterNodeFunc func);
XML_DEPRECATED
XMLPUBFUN xmlDeregisterNodeFunc
	    xmlDeregisterNodeDefault	(xmlDeregisterNodeFunc func);
XML_DEPRECATED
XMLPUBFUN xmlRegisterNodeFunc
            xmlThrDefRegisterNodeDefault(xmlRegisterNodeFunc func);
XML_DEPRECATED
XMLPUBFUN xmlDeregisterNodeFunc
            xmlThrDefDeregisterNodeDefault(xmlDeregisterNodeFunc func);

#ifdef __cplusplus
}
#endif

#endif /* __XML_TREE_H__ */

#endif /* XML_TREE_INTERNALS */


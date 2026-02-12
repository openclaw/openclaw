/*
 * Summary: The DTD validation
 * Description: API for the DTD handling and the validity checking
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */


#ifndef __XML_VALID_H__
#define __XML_VALID_H__

/** DOC_DISABLE */
#include <libxml/xmlversion.h>
#include <libxml/xmlerror.h>
#define XML_TREE_INTERNALS
#include <libxml/tree.h>
#undef XML_TREE_INTERNALS
#include <libxml/list.h>
#include <libxml/xmlautomata.h>
#include <libxml/xmlregexp.h>
/** DOC_ENABLE */

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Validation state added for non-determinist content model.
 */
typedef struct _xmlValidState xmlValidState;
typedef xmlValidState *xmlValidStatePtr;

/**
 * xmlValidityErrorFunc:
 * @ctx:  usually an xmlValidCtxtPtr to a validity error context,
 *        but comes from ctxt->userData (which normally contains such
 *        a pointer); ctxt->userData can be changed by the user.
 * @msg:  the string to format *printf like vararg
 * @...:  remaining arguments to the format
 *
 * Callback called when a validity error is found. This is a message
 * oriented function similar to an *printf function.
 */
typedef void (*xmlValidityErrorFunc) (void *ctx,
			     const char *msg,
			     ...) LIBXML_ATTR_FORMAT(2,3);

/**
 * xmlValidityWarningFunc:
 * @ctx:  usually an xmlValidCtxtPtr to a validity error context,
 *        but comes from ctxt->userData (which normally contains such
 *        a pointer); ctxt->userData can be changed by the user.
 * @msg:  the string to format *printf like vararg
 * @...:  remaining arguments to the format
 *
 * Callback called when a validity warning is found. This is a message
 * oriented function similar to an *printf function.
 */
typedef void (*xmlValidityWarningFunc) (void *ctx,
			       const char *msg,
			       ...) LIBXML_ATTR_FORMAT(2,3);

/*
 * xmlValidCtxt:
 * An xmlValidCtxt is used for error reporting when validating.
 */
typedef struct _xmlValidCtxt xmlValidCtxt;
typedef xmlValidCtxt *xmlValidCtxtPtr;
struct _xmlValidCtxt {
    void *userData;			/* user specific data block */
    xmlValidityErrorFunc error;		/* the callback in case of errors */
    xmlValidityWarningFunc warning;	/* the callback in case of warning */

    /* Node analysis stack used when validating within entities */
    xmlNodePtr         node;          /* Current parsed Node */
    int                nodeNr;        /* Depth of the parsing stack */
    int                nodeMax;       /* Max depth of the parsing stack */
    xmlNodePtr        *nodeTab;       /* array of nodes */

    unsigned int         flags;       /* internal flags */
    xmlDocPtr              doc;       /* the document */
    int                  valid;       /* temporary validity check result */

    /* state state used for non-determinist content validation */
    xmlValidState     *vstate;        /* current state */
    int                vstateNr;      /* Depth of the validation stack */
    int                vstateMax;     /* Max depth of the validation stack */
    xmlValidState     *vstateTab;     /* array of validation states */

#ifdef LIBXML_REGEXP_ENABLED
    xmlAutomataPtr            am;     /* the automata */
    xmlAutomataStatePtr    state;     /* used to build the automata */
#else
    void                     *am;
    void                  *state;
#endif
};

/*
 * ALL notation declarations are stored in a table.
 * There is one table per DTD.
 */

typedef struct _xmlHashTable xmlNotationTable;
typedef xmlNotationTable *xmlNotationTablePtr;

/*
 * ALL element declarations are stored in a table.
 * There is one table per DTD.
 */

typedef struct _xmlHashTable xmlElementTable;
typedef xmlElementTable *xmlElementTablePtr;

/*
 * ALL attribute declarations are stored in a table.
 * There is one table per DTD.
 */

typedef struct _xmlHashTable xmlAttributeTable;
typedef xmlAttributeTable *xmlAttributeTablePtr;

/*
 * ALL IDs attributes are stored in a table.
 * There is one table per document.
 */

typedef struct _xmlHashTable xmlIDTable;
typedef xmlIDTable *xmlIDTablePtr;

/*
 * ALL Refs attributes are stored in a table.
 * There is one table per document.
 */

typedef struct _xmlHashTable xmlRefTable;
typedef xmlRefTable *xmlRefTablePtr;

/* Notation */
XMLPUBFUN xmlNotationPtr
		xmlAddNotationDecl	(xmlValidCtxtPtr ctxt,
					 xmlDtdPtr dtd,
					 const xmlChar *name,
					 const xmlChar *PublicID,
					 const xmlChar *SystemID);
XML_DEPRECATED
XMLPUBFUN xmlNotationTablePtr
		xmlCopyNotationTable	(xmlNotationTablePtr table);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeNotationTable	(xmlNotationTablePtr table);
#ifdef LIBXML_OUTPUT_ENABLED
XML_DEPRECATED
XMLPUBFUN void
		xmlDumpNotationDecl	(xmlBufferPtr buf,
					 xmlNotationPtr nota);
/* XML_DEPRECATED, still used in lxml */
XMLPUBFUN void
		xmlDumpNotationTable	(xmlBufferPtr buf,
					 xmlNotationTablePtr table);
#endif /* LIBXML_OUTPUT_ENABLED */

/* Element Content */
/* the non Doc version are being deprecated */
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
		xmlNewElementContent	(const xmlChar *name,
					 xmlElementContentType type);
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
		xmlCopyElementContent	(xmlElementContentPtr content);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeElementContent	(xmlElementContentPtr cur);
/* the new versions with doc argument */
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
		xmlNewDocElementContent	(xmlDocPtr doc,
					 const xmlChar *name,
					 xmlElementContentType type);
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
		xmlCopyDocElementContent(xmlDocPtr doc,
					 xmlElementContentPtr content);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeDocElementContent(xmlDocPtr doc,
					 xmlElementContentPtr cur);
XML_DEPRECATED
XMLPUBFUN void
		xmlSnprintfElementContent(char *buf,
					 int size,
	                                 xmlElementContentPtr content,
					 int englob);
#ifdef LIBXML_OUTPUT_ENABLED
XML_DEPRECATED
XMLPUBFUN void
		xmlSprintfElementContent(char *buf,
	                                 xmlElementContentPtr content,
					 int englob);
#endif /* LIBXML_OUTPUT_ENABLED */

/* Element */
XMLPUBFUN xmlElementPtr
		xmlAddElementDecl	(xmlValidCtxtPtr ctxt,
					 xmlDtdPtr dtd,
					 const xmlChar *name,
					 xmlElementTypeVal type,
					 xmlElementContentPtr content);
XML_DEPRECATED
XMLPUBFUN xmlElementTablePtr
		xmlCopyElementTable	(xmlElementTablePtr table);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeElementTable	(xmlElementTablePtr table);
#ifdef LIBXML_OUTPUT_ENABLED
XML_DEPRECATED
XMLPUBFUN void
		xmlDumpElementTable	(xmlBufferPtr buf,
					 xmlElementTablePtr table);
XML_DEPRECATED
XMLPUBFUN void
		xmlDumpElementDecl	(xmlBufferPtr buf,
					 xmlElementPtr elem);
#endif /* LIBXML_OUTPUT_ENABLED */

/* Enumeration */
XML_DEPRECATED
XMLPUBFUN xmlEnumerationPtr
		xmlCreateEnumeration	(const xmlChar *name);
/* XML_DEPRECATED, needed for custom attributeDecl SAX handler */
XMLPUBFUN void
		xmlFreeEnumeration	(xmlEnumerationPtr cur);
XML_DEPRECATED
XMLPUBFUN xmlEnumerationPtr
		xmlCopyEnumeration	(xmlEnumerationPtr cur);

/* Attribute */
XMLPUBFUN xmlAttributePtr
		xmlAddAttributeDecl	(xmlValidCtxtPtr ctxt,
					 xmlDtdPtr dtd,
					 const xmlChar *elem,
					 const xmlChar *name,
					 const xmlChar *ns,
					 xmlAttributeType type,
					 xmlAttributeDefault def,
					 const xmlChar *defaultValue,
					 xmlEnumerationPtr tree);
XML_DEPRECATED
XMLPUBFUN xmlAttributeTablePtr
		xmlCopyAttributeTable  (xmlAttributeTablePtr table);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeAttributeTable  (xmlAttributeTablePtr table);
#ifdef LIBXML_OUTPUT_ENABLED
XML_DEPRECATED
XMLPUBFUN void
		xmlDumpAttributeTable  (xmlBufferPtr buf,
					xmlAttributeTablePtr table);
XML_DEPRECATED
XMLPUBFUN void
		xmlDumpAttributeDecl   (xmlBufferPtr buf,
					xmlAttributePtr attr);
#endif /* LIBXML_OUTPUT_ENABLED */

/* IDs */
XMLPUBFUN int
		xmlAddIDSafe	       (xmlAttrPtr attr,
					const xmlChar *value);
XMLPUBFUN xmlIDPtr
		xmlAddID	       (xmlValidCtxtPtr ctxt,
					xmlDocPtr doc,
					const xmlChar *value,
					xmlAttrPtr attr);
XMLPUBFUN void
		xmlFreeIDTable	       (xmlIDTablePtr table);
XMLPUBFUN xmlAttrPtr
		xmlGetID	       (xmlDocPtr doc,
					const xmlChar *ID);
XMLPUBFUN int
		xmlIsID		       (xmlDocPtr doc,
					xmlNodePtr elem,
					xmlAttrPtr attr);
XMLPUBFUN int
		xmlRemoveID	       (xmlDocPtr doc,
					xmlAttrPtr attr);

/* IDREFs */
XML_DEPRECATED
XMLPUBFUN xmlRefPtr
		xmlAddRef	       (xmlValidCtxtPtr ctxt,
					xmlDocPtr doc,
					const xmlChar *value,
					xmlAttrPtr attr);
XML_DEPRECATED
XMLPUBFUN void
		xmlFreeRefTable	       (xmlRefTablePtr table);
XML_DEPRECATED
XMLPUBFUN int
		xmlIsRef	       (xmlDocPtr doc,
					xmlNodePtr elem,
					xmlAttrPtr attr);
XML_DEPRECATED
XMLPUBFUN int
		xmlRemoveRef	       (xmlDocPtr doc,
					xmlAttrPtr attr);
XML_DEPRECATED
XMLPUBFUN xmlListPtr
		xmlGetRefs	       (xmlDocPtr doc,
					const xmlChar *ID);

/**
 * The public function calls related to validity checking.
 */
#ifdef LIBXML_VALID_ENABLED
/* Allocate/Release Validation Contexts */
XMLPUBFUN xmlValidCtxtPtr
		xmlNewValidCtxt(void);
XMLPUBFUN void
		xmlFreeValidCtxt(xmlValidCtxtPtr);

XML_DEPRECATED
XMLPUBFUN int
		xmlValidateRoot		(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateElementDecl	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
		                         xmlElementPtr elem);
XML_DEPRECATED
XMLPUBFUN xmlChar *
		xmlValidNormalizeAttributeValue(xmlDocPtr doc,
					 xmlNodePtr elem,
					 const xmlChar *name,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN xmlChar *
		xmlValidCtxtNormalizeAttributeValue(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem,
					 const xmlChar *name,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateAttributeDecl(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
		                         xmlAttributePtr attr);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateAttributeValue(xmlAttributeType type,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateNotationDecl	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
		                         xmlNotationPtr nota);
XMLPUBFUN int
		xmlValidateDtd		(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlDtdPtr dtd);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateDtdFinal	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc);
XMLPUBFUN int
		xmlValidateDocument	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc);
XMLPUBFUN int
		xmlValidateElement	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateOneElement	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
		                         xmlNodePtr elem);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateOneAttribute	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr	elem,
					 xmlAttrPtr attr,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateOneNamespace	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem,
					 const xmlChar *prefix,
					 xmlNsPtr ns,
					 const xmlChar *value);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateDocumentFinal(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidateNotationUse	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 const xmlChar *notationName);
#endif /* LIBXML_VALID_ENABLED */

XMLPUBFUN int
		xmlIsMixedElement	(xmlDocPtr doc,
					 const xmlChar *name);
XMLPUBFUN xmlAttributePtr
		xmlGetDtdAttrDesc	(xmlDtdPtr dtd,
					 const xmlChar *elem,
					 const xmlChar *name);
XMLPUBFUN xmlAttributePtr
		xmlGetDtdQAttrDesc	(xmlDtdPtr dtd,
					 const xmlChar *elem,
					 const xmlChar *name,
					 const xmlChar *prefix);
XMLPUBFUN xmlNotationPtr
		xmlGetDtdNotationDesc	(xmlDtdPtr dtd,
					 const xmlChar *name);
XMLPUBFUN xmlElementPtr
		xmlGetDtdQElementDesc	(xmlDtdPtr dtd,
					 const xmlChar *name,
					 const xmlChar *prefix);
XMLPUBFUN xmlElementPtr
		xmlGetDtdElementDesc	(xmlDtdPtr dtd,
					 const xmlChar *name);

#ifdef LIBXML_VALID_ENABLED

XMLPUBFUN int
		xmlValidGetPotentialChildren(xmlElementContent *ctree,
					 const xmlChar **names,
					 int *len,
					 int max);

XMLPUBFUN int
		xmlValidGetValidElements(xmlNode *prev,
					 xmlNode *next,
					 const xmlChar **names,
					 int max);
XMLPUBFUN int
		xmlValidateNameValue	(const xmlChar *value);
XMLPUBFUN int
		xmlValidateNamesValue	(const xmlChar *value);
XMLPUBFUN int
		xmlValidateNmtokenValue	(const xmlChar *value);
XMLPUBFUN int
		xmlValidateNmtokensValue(const xmlChar *value);

#ifdef LIBXML_REGEXP_ENABLED
/*
 * Validation based on the regexp support
 */
XML_DEPRECATED
XMLPUBFUN int
		xmlValidBuildContentModel(xmlValidCtxtPtr ctxt,
					 xmlElementPtr elem);

XML_DEPRECATED
XMLPUBFUN int
		xmlValidatePushElement	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem,
					 const xmlChar *qname);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidatePushCData	(xmlValidCtxtPtr ctxt,
					 const xmlChar *data,
					 int len);
XML_DEPRECATED
XMLPUBFUN int
		xmlValidatePopElement	(xmlValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem,
					 const xmlChar *qname);
#endif /* LIBXML_REGEXP_ENABLED */
#endif /* LIBXML_VALID_ENABLED */
#ifdef __cplusplus
}
#endif
#endif /* __XML_VALID_H__ */

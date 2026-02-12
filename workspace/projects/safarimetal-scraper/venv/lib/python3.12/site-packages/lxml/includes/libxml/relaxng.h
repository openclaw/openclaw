/*
 * Summary: implementation of the Relax-NG validation
 * Description: implementation of the Relax-NG validation
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_RELAX_NG__
#define __XML_RELAX_NG__

#include <libxml/xmlversion.h>
#include <libxml/xmlerror.h>
#include <libxml/xmlstring.h>
#include <libxml/tree.h>
#include <libxml/parser.h>

#ifdef LIBXML_RELAXNG_ENABLED

#ifdef __cplusplus
extern "C" {
#endif

typedef struct _xmlRelaxNG xmlRelaxNG;
typedef xmlRelaxNG *xmlRelaxNGPtr;


/**
 * xmlRelaxNGValidityErrorFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of an error callback from a Relax-NG validation
 */
typedef void (*xmlRelaxNGValidityErrorFunc) (void *ctx,
						      const char *msg,
						      ...) LIBXML_ATTR_FORMAT(2,3);

/**
 * xmlRelaxNGValidityWarningFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of a warning callback from a Relax-NG validation
 */
typedef void (*xmlRelaxNGValidityWarningFunc) (void *ctx,
							const char *msg,
							...) LIBXML_ATTR_FORMAT(2,3);

/**
 * A schemas validation context
 */
typedef struct _xmlRelaxNGParserCtxt xmlRelaxNGParserCtxt;
typedef xmlRelaxNGParserCtxt *xmlRelaxNGParserCtxtPtr;

typedef struct _xmlRelaxNGValidCtxt xmlRelaxNGValidCtxt;
typedef xmlRelaxNGValidCtxt *xmlRelaxNGValidCtxtPtr;

/*
 * xmlRelaxNGValidErr:
 *
 * List of possible Relax NG validation errors
 */
typedef enum {
    XML_RELAXNG_OK = 0,
    XML_RELAXNG_ERR_MEMORY,
    XML_RELAXNG_ERR_TYPE,
    XML_RELAXNG_ERR_TYPEVAL,
    XML_RELAXNG_ERR_DUPID,
    XML_RELAXNG_ERR_TYPECMP,
    XML_RELAXNG_ERR_NOSTATE,
    XML_RELAXNG_ERR_NODEFINE,
    XML_RELAXNG_ERR_LISTEXTRA,
    XML_RELAXNG_ERR_LISTEMPTY,
    XML_RELAXNG_ERR_INTERNODATA,
    XML_RELAXNG_ERR_INTERSEQ,
    XML_RELAXNG_ERR_INTEREXTRA,
    XML_RELAXNG_ERR_ELEMNAME,
    XML_RELAXNG_ERR_ATTRNAME,
    XML_RELAXNG_ERR_ELEMNONS,
    XML_RELAXNG_ERR_ATTRNONS,
    XML_RELAXNG_ERR_ELEMWRONGNS,
    XML_RELAXNG_ERR_ATTRWRONGNS,
    XML_RELAXNG_ERR_ELEMEXTRANS,
    XML_RELAXNG_ERR_ATTREXTRANS,
    XML_RELAXNG_ERR_ELEMNOTEMPTY,
    XML_RELAXNG_ERR_NOELEM,
    XML_RELAXNG_ERR_NOTELEM,
    XML_RELAXNG_ERR_ATTRVALID,
    XML_RELAXNG_ERR_CONTENTVALID,
    XML_RELAXNG_ERR_EXTRACONTENT,
    XML_RELAXNG_ERR_INVALIDATTR,
    XML_RELAXNG_ERR_DATAELEM,
    XML_RELAXNG_ERR_VALELEM,
    XML_RELAXNG_ERR_LISTELEM,
    XML_RELAXNG_ERR_DATATYPE,
    XML_RELAXNG_ERR_VALUE,
    XML_RELAXNG_ERR_LIST,
    XML_RELAXNG_ERR_NOGRAMMAR,
    XML_RELAXNG_ERR_EXTRADATA,
    XML_RELAXNG_ERR_LACKDATA,
    XML_RELAXNG_ERR_INTERNAL,
    XML_RELAXNG_ERR_ELEMWRONG,
    XML_RELAXNG_ERR_TEXTWRONG
} xmlRelaxNGValidErr;

/*
 * xmlRelaxNGParserFlags:
 *
 * List of possible Relax NG Parser flags
 */
typedef enum {
    XML_RELAXNGP_NONE = 0,
    XML_RELAXNGP_FREE_DOC = 1,
    XML_RELAXNGP_CRNG = 2
} xmlRelaxNGParserFlag;

XMLPUBFUN int
		    xmlRelaxNGInitTypes		(void);
XML_DEPRECATED
XMLPUBFUN void
		    xmlRelaxNGCleanupTypes	(void);

/*
 * Interfaces for parsing.
 */
XMLPUBFUN xmlRelaxNGParserCtxtPtr
		    xmlRelaxNGNewParserCtxt	(const char *URL);
XMLPUBFUN xmlRelaxNGParserCtxtPtr
		    xmlRelaxNGNewMemParserCtxt	(const char *buffer,
						 int size);
XMLPUBFUN xmlRelaxNGParserCtxtPtr
		    xmlRelaxNGNewDocParserCtxt	(xmlDocPtr doc);

XMLPUBFUN int
		    xmlRelaxParserSetFlag	(xmlRelaxNGParserCtxtPtr ctxt,
						 int flag);

XMLPUBFUN void
		    xmlRelaxNGFreeParserCtxt	(xmlRelaxNGParserCtxtPtr ctxt);
XMLPUBFUN void
		    xmlRelaxNGSetParserErrors(xmlRelaxNGParserCtxtPtr ctxt,
					 xmlRelaxNGValidityErrorFunc err,
					 xmlRelaxNGValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN int
		    xmlRelaxNGGetParserErrors(xmlRelaxNGParserCtxtPtr ctxt,
					 xmlRelaxNGValidityErrorFunc *err,
					 xmlRelaxNGValidityWarningFunc *warn,
					 void **ctx);
XMLPUBFUN void
		    xmlRelaxNGSetParserStructuredErrors(
					 xmlRelaxNGParserCtxtPtr ctxt,
					 xmlStructuredErrorFunc serror,
					 void *ctx);
XMLPUBFUN void
		    xmlRelaxNGSetResourceLoader	(xmlRelaxNGParserCtxtPtr ctxt,
						 xmlResourceLoader loader,
						 void *vctxt);
XMLPUBFUN xmlRelaxNGPtr
		    xmlRelaxNGParse		(xmlRelaxNGParserCtxtPtr ctxt);
XMLPUBFUN void
		    xmlRelaxNGFree		(xmlRelaxNGPtr schema);
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void
		    xmlRelaxNGDump		(FILE *output,
					 xmlRelaxNGPtr schema);
XMLPUBFUN void
		    xmlRelaxNGDumpTree	(FILE * output,
					 xmlRelaxNGPtr schema);
#endif /* LIBXML_OUTPUT_ENABLED */
/*
 * Interfaces for validating
 */
XMLPUBFUN void
		    xmlRelaxNGSetValidErrors(xmlRelaxNGValidCtxtPtr ctxt,
					 xmlRelaxNGValidityErrorFunc err,
					 xmlRelaxNGValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN int
		    xmlRelaxNGGetValidErrors(xmlRelaxNGValidCtxtPtr ctxt,
					 xmlRelaxNGValidityErrorFunc *err,
					 xmlRelaxNGValidityWarningFunc *warn,
					 void **ctx);
XMLPUBFUN void
			xmlRelaxNGSetValidStructuredErrors(xmlRelaxNGValidCtxtPtr ctxt,
					  xmlStructuredErrorFunc serror, void *ctx);
XMLPUBFUN xmlRelaxNGValidCtxtPtr
		    xmlRelaxNGNewValidCtxt	(xmlRelaxNGPtr schema);
XMLPUBFUN void
		    xmlRelaxNGFreeValidCtxt	(xmlRelaxNGValidCtxtPtr ctxt);
XMLPUBFUN int
		    xmlRelaxNGValidateDoc	(xmlRelaxNGValidCtxtPtr ctxt,
						 xmlDocPtr doc);
/*
 * Interfaces for progressive validation when possible
 */
XMLPUBFUN int
		    xmlRelaxNGValidatePushElement	(xmlRelaxNGValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem);
XMLPUBFUN int
		    xmlRelaxNGValidatePushCData	(xmlRelaxNGValidCtxtPtr ctxt,
					 const xmlChar *data,
					 int len);
XMLPUBFUN int
		    xmlRelaxNGValidatePopElement	(xmlRelaxNGValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem);
XMLPUBFUN int
		    xmlRelaxNGValidateFullElement	(xmlRelaxNGValidCtxtPtr ctxt,
					 xmlDocPtr doc,
					 xmlNodePtr elem);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_RELAXNG_ENABLED */

#endif /* __XML_RELAX_NG__ */

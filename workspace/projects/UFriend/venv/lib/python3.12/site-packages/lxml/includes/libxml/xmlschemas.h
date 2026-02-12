/*
 * Summary: incomplete XML Schemas structure implementation
 * Description: interface to the XML Schemas handling and schema validity
 *              checking, it is incomplete right now.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */


#ifndef __XML_SCHEMA_H__
#define __XML_SCHEMA_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_SCHEMAS_ENABLED

#include <stdio.h>
#include <libxml/encoding.h>
#include <libxml/parser.h>
#include <libxml/tree.h>
#include <libxml/xmlerror.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * This error codes are obsolete; not used any more.
 */
typedef enum {
    XML_SCHEMAS_ERR_OK		= 0,
    XML_SCHEMAS_ERR_NOROOT	= 1,
    XML_SCHEMAS_ERR_UNDECLAREDELEM,
    XML_SCHEMAS_ERR_NOTTOPLEVEL,
    XML_SCHEMAS_ERR_MISSING,
    XML_SCHEMAS_ERR_WRONGELEM,
    XML_SCHEMAS_ERR_NOTYPE,
    XML_SCHEMAS_ERR_NOROLLBACK,
    XML_SCHEMAS_ERR_ISABSTRACT,
    XML_SCHEMAS_ERR_NOTEMPTY,
    XML_SCHEMAS_ERR_ELEMCONT,
    XML_SCHEMAS_ERR_HAVEDEFAULT,
    XML_SCHEMAS_ERR_NOTNILLABLE,
    XML_SCHEMAS_ERR_EXTRACONTENT,
    XML_SCHEMAS_ERR_INVALIDATTR,
    XML_SCHEMAS_ERR_INVALIDELEM,
    XML_SCHEMAS_ERR_NOTDETERMINIST,
    XML_SCHEMAS_ERR_CONSTRUCT,
    XML_SCHEMAS_ERR_INTERNAL,
    XML_SCHEMAS_ERR_NOTSIMPLE,
    XML_SCHEMAS_ERR_ATTRUNKNOWN,
    XML_SCHEMAS_ERR_ATTRINVALID,
    XML_SCHEMAS_ERR_VALUE,
    XML_SCHEMAS_ERR_FACET,
    XML_SCHEMAS_ERR_,
    XML_SCHEMAS_ERR_XXX
} xmlSchemaValidError;

/*
* ATTENTION: Change xmlSchemaSetValidOptions's check
* for invalid values, if adding to the validation
* options below.
*/
/**
 * xmlSchemaValidOption:
 *
 * This is the set of XML Schema validation options.
 */
typedef enum {
    XML_SCHEMA_VAL_VC_I_CREATE			= 1<<0
	/* Default/fixed: create an attribute node
	* or an element's text node on the instance.
	*/
} xmlSchemaValidOption;

/*
    XML_SCHEMA_VAL_XSI_ASSEMBLE			= 1<<1,
	* assemble schemata using
	* xsi:schemaLocation and
	* xsi:noNamespaceSchemaLocation
*/

/**
 * The schemas related types are kept internal
 */
typedef struct _xmlSchema xmlSchema;
typedef xmlSchema *xmlSchemaPtr;

/**
 * xmlSchemaValidityErrorFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of an error callback from an XSD validation
 */
typedef void (*xmlSchemaValidityErrorFunc)
                 (void *ctx, const char *msg, ...) LIBXML_ATTR_FORMAT(2,3);

/**
 * xmlSchemaValidityWarningFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of a warning callback from an XSD validation
 */
typedef void (*xmlSchemaValidityWarningFunc)
                 (void *ctx, const char *msg, ...) LIBXML_ATTR_FORMAT(2,3);

/**
 * A schemas validation context
 */
typedef struct _xmlSchemaParserCtxt xmlSchemaParserCtxt;
typedef xmlSchemaParserCtxt *xmlSchemaParserCtxtPtr;

typedef struct _xmlSchemaValidCtxt xmlSchemaValidCtxt;
typedef xmlSchemaValidCtxt *xmlSchemaValidCtxtPtr;

/**
 * xmlSchemaValidityLocatorFunc:
 * @ctx: user provided context
 * @file: returned file information
 * @line: returned line information
 *
 * A schemas validation locator, a callback called by the validator.
 * This is used when file or node information are not available
 * to find out what file and line number are affected
 *
 * Returns: 0 in case of success and -1 in case of error
 */

typedef int (*xmlSchemaValidityLocatorFunc) (void *ctx,
                           const char **file, unsigned long *line);

/*
 * Interfaces for parsing.
 */
XMLPUBFUN xmlSchemaParserCtxtPtr
	    xmlSchemaNewParserCtxt	(const char *URL);
XMLPUBFUN xmlSchemaParserCtxtPtr
	    xmlSchemaNewMemParserCtxt	(const char *buffer,
					 int size);
XMLPUBFUN xmlSchemaParserCtxtPtr
	    xmlSchemaNewDocParserCtxt	(xmlDocPtr doc);
XMLPUBFUN void
	    xmlSchemaFreeParserCtxt	(xmlSchemaParserCtxtPtr ctxt);
XMLPUBFUN void
	    xmlSchemaSetParserErrors	(xmlSchemaParserCtxtPtr ctxt,
					 xmlSchemaValidityErrorFunc err,
					 xmlSchemaValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN void
	    xmlSchemaSetParserStructuredErrors(xmlSchemaParserCtxtPtr ctxt,
					 xmlStructuredErrorFunc serror,
					 void *ctx);
XMLPUBFUN int
	    xmlSchemaGetParserErrors	(xmlSchemaParserCtxtPtr ctxt,
					xmlSchemaValidityErrorFunc * err,
					xmlSchemaValidityWarningFunc * warn,
					void **ctx);
XMLPUBFUN void
	    xmlSchemaSetResourceLoader	(xmlSchemaParserCtxtPtr ctxt,
					 xmlResourceLoader loader,
					 void *data);
XMLPUBFUN int
	    xmlSchemaIsValid		(xmlSchemaValidCtxtPtr ctxt);

XMLPUBFUN xmlSchemaPtr
	    xmlSchemaParse		(xmlSchemaParserCtxtPtr ctxt);
XMLPUBFUN void
	    xmlSchemaFree		(xmlSchemaPtr schema);
#ifdef LIBXML_DEBUG_ENABLED
XMLPUBFUN void
	    xmlSchemaDump		(FILE *output,
					 xmlSchemaPtr schema);
#endif /* LIBXML_DEBUG_ENABLED */
/*
 * Interfaces for validating
 */
XMLPUBFUN void
	    xmlSchemaSetValidErrors	(xmlSchemaValidCtxtPtr ctxt,
					 xmlSchemaValidityErrorFunc err,
					 xmlSchemaValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN void
	    xmlSchemaSetValidStructuredErrors(xmlSchemaValidCtxtPtr ctxt,
					 xmlStructuredErrorFunc serror,
					 void *ctx);
XMLPUBFUN int
	    xmlSchemaGetValidErrors	(xmlSchemaValidCtxtPtr ctxt,
					 xmlSchemaValidityErrorFunc *err,
					 xmlSchemaValidityWarningFunc *warn,
					 void **ctx);
XMLPUBFUN int
	    xmlSchemaSetValidOptions	(xmlSchemaValidCtxtPtr ctxt,
					 int options);
XMLPUBFUN void
            xmlSchemaValidateSetFilename(xmlSchemaValidCtxtPtr vctxt,
	                                 const char *filename);
XMLPUBFUN int
	    xmlSchemaValidCtxtGetOptions(xmlSchemaValidCtxtPtr ctxt);

XMLPUBFUN xmlSchemaValidCtxtPtr
	    xmlSchemaNewValidCtxt	(xmlSchemaPtr schema);
XMLPUBFUN void
	    xmlSchemaFreeValidCtxt	(xmlSchemaValidCtxtPtr ctxt);
XMLPUBFUN int
	    xmlSchemaValidateDoc	(xmlSchemaValidCtxtPtr ctxt,
					 xmlDocPtr instance);
XMLPUBFUN int
            xmlSchemaValidateOneElement (xmlSchemaValidCtxtPtr ctxt,
			                 xmlNodePtr elem);
XMLPUBFUN int
	    xmlSchemaValidateStream	(xmlSchemaValidCtxtPtr ctxt,
					 xmlParserInputBufferPtr input,
					 xmlCharEncoding enc,
					 const xmlSAXHandler *sax,
					 void *user_data);
XMLPUBFUN int
	    xmlSchemaValidateFile	(xmlSchemaValidCtxtPtr ctxt,
					 const char * filename,
					 int options);

XMLPUBFUN xmlParserCtxtPtr
	    xmlSchemaValidCtxtGetParserCtxt(xmlSchemaValidCtxtPtr ctxt);

/*
 * Interface to insert Schemas SAX validation in a SAX stream
 */
typedef struct _xmlSchemaSAXPlug xmlSchemaSAXPlugStruct;
typedef xmlSchemaSAXPlugStruct *xmlSchemaSAXPlugPtr;

XMLPUBFUN xmlSchemaSAXPlugPtr
            xmlSchemaSAXPlug		(xmlSchemaValidCtxtPtr ctxt,
					 xmlSAXHandlerPtr *sax,
					 void **user_data);
XMLPUBFUN int
            xmlSchemaSAXUnplug		(xmlSchemaSAXPlugPtr plug);


XMLPUBFUN void
            xmlSchemaValidateSetLocator	(xmlSchemaValidCtxtPtr vctxt,
					 xmlSchemaValidityLocatorFunc f,
					 void *ctxt);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_SCHEMAS_ENABLED */
#endif /* __XML_SCHEMA_H__ */

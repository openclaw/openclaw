/*
 * Summary: XML Schematron implementation
 * Description: interface to the XML Schematron validity checking.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */


#ifndef __XML_SCHEMATRON_H__
#define __XML_SCHEMATRON_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_SCHEMATRON_ENABLED

#include <libxml/xmlerror.h>
#include <libxml/tree.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    XML_SCHEMATRON_OUT_QUIET = 1 << 0,	/* quiet no report */
    XML_SCHEMATRON_OUT_TEXT = 1 << 1,	/* build a textual report */
    XML_SCHEMATRON_OUT_XML = 1 << 2,	/* output SVRL */
    XML_SCHEMATRON_OUT_ERROR = 1 << 3,  /* output via xmlStructuredErrorFunc */
    XML_SCHEMATRON_OUT_FILE = 1 << 8,	/* output to a file descriptor */
    XML_SCHEMATRON_OUT_BUFFER = 1 << 9,	/* output to a buffer */
    XML_SCHEMATRON_OUT_IO = 1 << 10	/* output to I/O mechanism */
} xmlSchematronValidOptions;

/**
 * The schemas related types are kept internal
 */
typedef struct _xmlSchematron xmlSchematron;
typedef xmlSchematron *xmlSchematronPtr;

/**
 * xmlSchematronValidityErrorFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of an error callback from a Schematron validation
 */
typedef void (*xmlSchematronValidityErrorFunc) (void *ctx, const char *msg, ...);

/**
 * xmlSchematronValidityWarningFunc:
 * @ctx: the validation context
 * @msg: the message
 * @...: extra arguments
 *
 * Signature of a warning callback from a Schematron validation
 */
typedef void (*xmlSchematronValidityWarningFunc) (void *ctx, const char *msg, ...);

/**
 * A schemas validation context
 */
typedef struct _xmlSchematronParserCtxt xmlSchematronParserCtxt;
typedef xmlSchematronParserCtxt *xmlSchematronParserCtxtPtr;

typedef struct _xmlSchematronValidCtxt xmlSchematronValidCtxt;
typedef xmlSchematronValidCtxt *xmlSchematronValidCtxtPtr;

/*
 * Interfaces for parsing.
 */
XMLPUBFUN xmlSchematronParserCtxtPtr
	    xmlSchematronNewParserCtxt	(const char *URL);
XMLPUBFUN xmlSchematronParserCtxtPtr
	    xmlSchematronNewMemParserCtxt(const char *buffer,
					 int size);
XMLPUBFUN xmlSchematronParserCtxtPtr
	    xmlSchematronNewDocParserCtxt(xmlDocPtr doc);
XMLPUBFUN void
	    xmlSchematronFreeParserCtxt	(xmlSchematronParserCtxtPtr ctxt);
/*****
XMLPUBFUN void
	    xmlSchematronSetParserErrors(xmlSchematronParserCtxtPtr ctxt,
					 xmlSchematronValidityErrorFunc err,
					 xmlSchematronValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN int
		xmlSchematronGetParserErrors(xmlSchematronParserCtxtPtr ctxt,
					xmlSchematronValidityErrorFunc * err,
					xmlSchematronValidityWarningFunc * warn,
					void **ctx);
XMLPUBFUN int
		xmlSchematronIsValid	(xmlSchematronValidCtxtPtr ctxt);
 *****/
XMLPUBFUN xmlSchematronPtr
	    xmlSchematronParse		(xmlSchematronParserCtxtPtr ctxt);
XMLPUBFUN void
	    xmlSchematronFree		(xmlSchematronPtr schema);
/*
 * Interfaces for validating
 */
XMLPUBFUN void
	    xmlSchematronSetValidStructuredErrors(
	                                  xmlSchematronValidCtxtPtr ctxt,
					  xmlStructuredErrorFunc serror,
					  void *ctx);
/******
XMLPUBFUN void
	    xmlSchematronSetValidErrors	(xmlSchematronValidCtxtPtr ctxt,
					 xmlSchematronValidityErrorFunc err,
					 xmlSchematronValidityWarningFunc warn,
					 void *ctx);
XMLPUBFUN int
	    xmlSchematronGetValidErrors	(xmlSchematronValidCtxtPtr ctxt,
					 xmlSchematronValidityErrorFunc *err,
					 xmlSchematronValidityWarningFunc *warn,
					 void **ctx);
XMLPUBFUN int
	    xmlSchematronSetValidOptions(xmlSchematronValidCtxtPtr ctxt,
					 int options);
XMLPUBFUN int
	    xmlSchematronValidCtxtGetOptions(xmlSchematronValidCtxtPtr ctxt);
XMLPUBFUN int
            xmlSchematronValidateOneElement (xmlSchematronValidCtxtPtr ctxt,
			                 xmlNodePtr elem);
 *******/

XMLPUBFUN xmlSchematronValidCtxtPtr
	    xmlSchematronNewValidCtxt	(xmlSchematronPtr schema,
					 int options);
XMLPUBFUN void
	    xmlSchematronFreeValidCtxt	(xmlSchematronValidCtxtPtr ctxt);
XMLPUBFUN int
	    xmlSchematronValidateDoc	(xmlSchematronValidCtxtPtr ctxt,
					 xmlDocPtr instance);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_SCHEMATRON_ENABLED */
#endif /* __XML_SCHEMATRON_H__ */

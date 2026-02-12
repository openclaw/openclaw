/*
 * Summary: interface for the XSLT functions not from XPath
 * Description: a set of extra functions coming from XSLT but not in XPath
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard and Bjorn Reese <breese@users.sourceforge.net>
 */

#ifndef __XML_XSLT_FUNCTIONS_H__
#define __XML_XSLT_FUNCTIONS_H__

#include <libxml/xpath.h>
#include <libxml/xpathInternals.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * XSLT_REGISTER_FUNCTION_LOOKUP:
 *
 * Registering macro, not general purpose at all but used in different modules.
 */
#define XSLT_REGISTER_FUNCTION_LOOKUP(ctxt)			\
    xmlXPathRegisterFuncLookup((ctxt)->xpathCtxt,		\
	xsltXPathFunctionLookup,				\
	(void *)(ctxt->xpathCtxt));

XSLTPUBFUN xmlXPathFunction XSLTCALL
	xsltXPathFunctionLookup		(void *vctxt,
					 const xmlChar *name,
					 const xmlChar *ns_uri);

/*
 * Interfaces for the functions implementations.
 */

XSLTPUBFUN void XSLTCALL
	xsltDocumentFunction		(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltKeyFunction			(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltUnparsedEntityURIFunction	(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltFormatNumberFunction	(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltGenerateIdFunction		(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltSystemPropertyFunction	(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltElementAvailableFunction	(xmlXPathParserContextPtr ctxt,
					 int nargs);
XSLTPUBFUN void XSLTCALL
	xsltFunctionAvailableFunction	(xmlXPathParserContextPtr ctxt,
					 int nargs);

/*
 * And the registration
 */

XSLTPUBFUN void XSLTCALL
	xsltRegisterAllFunctions	(xmlXPathContextPtr ctxt);

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_FUNCTIONS_H__ */


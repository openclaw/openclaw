/*
 * Summary: interface for the document handling
 * Description: implements document loading and cache (multiple
 *              document() reference for the same resources must
 *              be equal.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XSLT_DOCUMENTS_H__
#define __XML_XSLT_DOCUMENTS_H__

#include <libxml/tree.h>
#include "xsltexports.h"
#include "xsltInternals.h"

#ifdef __cplusplus
extern "C" {
#endif

XSLTPUBFUN xsltDocumentPtr XSLTCALL
		xsltNewDocument		(xsltTransformContextPtr ctxt,
					 xmlDocPtr doc);
XSLTPUBFUN xsltDocumentPtr XSLTCALL
		xsltLoadDocument	(xsltTransformContextPtr ctxt,
					 const xmlChar *URI);
XSLTPUBFUN xsltDocumentPtr XSLTCALL
		xsltFindDocument	(xsltTransformContextPtr ctxt,
					 xmlDocPtr doc);
XSLTPUBFUN void XSLTCALL
		xsltFreeDocuments	(xsltTransformContextPtr ctxt);

XSLTPUBFUN xsltDocumentPtr XSLTCALL
		xsltLoadStyleDocument	(xsltStylesheetPtr style,
					 const xmlChar *URI);
XSLTPUBFUN xsltDocumentPtr XSLTCALL
		xsltNewStyleDocument	(xsltStylesheetPtr style,
					 xmlDocPtr doc);
XSLTPUBFUN void XSLTCALL
		xsltFreeStyleDocuments	(xsltStylesheetPtr style);

/*
 * Hooks for document loading
 */

/**
 * xsltLoadType:
 *
 * Enum defining the kind of loader requirement.
 */
typedef enum {
    XSLT_LOAD_START = 0,	/* loading for a top stylesheet */
    XSLT_LOAD_STYLESHEET = 1,	/* loading for a stylesheet include/import */
    XSLT_LOAD_DOCUMENT = 2	/* loading document at transformation time */
} xsltLoadType;

/**
 * xsltDocLoaderFunc:
 * @URI: the URI of the document to load
 * @dict: the dictionary to use when parsing that document
 * @options: parsing options, a set of xmlParserOption
 * @ctxt: the context, either a stylesheet or a transformation context
 * @type: the xsltLoadType indicating the kind of loading required
 *
 * An xsltDocLoaderFunc is a signature for a function which can be
 * registered to load document not provided by the compilation or
 * transformation API themselve, for example when an xsl:import,
 * xsl:include is found at compilation time or when a document()
 * call is made at runtime.
 *
 * Returns the pointer to the document (which will be modified and
 * freed by the engine later), or NULL in case of error.
 */
typedef xmlDocPtr (*xsltDocLoaderFunc)		(const xmlChar *URI,
						 xmlDictPtr dict,
						 int options,
						 void *ctxt,
						 xsltLoadType type);

XSLTPUBFUN void XSLTCALL
		xsltSetLoaderFunc		(xsltDocLoaderFunc f);

/* the loader may be needed by extension libraries so it is exported */
XSLTPUBVAR xsltDocLoaderFunc xsltDocDefaultLoader;

#ifdef __cplusplus
}
#endif

#endif /* __XML_XSLT_DOCUMENTS_H__ */

